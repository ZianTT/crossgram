import type { ICryptoProvider, Logger } from '@mtcute/core/utils.js'
import type { mtp } from '@mtcute/core'
import type { TlReaderMap, TlWriterMap } from '@mtcute/tl-runtime'
import { bigint, typed, u8 } from '@fuman/utils'
import { TlBinaryReader, TlBinaryWriter, TlSerializationCounter } from '@mtcute/tl-runtime'
import Long from 'long'
import { generateKeyAndIvFromNonce } from '@mtcute/core/utils.js'
import { rsaRawDecrypt, generatePq } from '../crypto/rsa-keygen.js'

/** 兼容旧版 `req_pq`（服务端 reader map 支持，但 mtcute 未生成其类型） */
interface LegacyReqPq {
  _: 'mt_req_pq'
  nonce: Uint8Array
}

type PlainHandshakeObject = mtp.TlObject | LegacyReqPq

interface PendingPqChallenge {
  clientNonce: Uint8Array
  serverNonce: Uint8Array
  pq: bigint
  createdAt: number
}

const DEFAULT_MAX_PENDING_PQ_CHALLENGES = 4096
const DEFAULT_PQ_CHALLENGE_TTL_MS = 60_000

export class PqChallengeStore {
  private readonly _challenges: PendingPqChallenge[] = []

  constructor(
    private readonly _maxSize = DEFAULT_MAX_PENDING_PQ_CHALLENGES,
    private readonly _ttlMs = DEFAULT_PQ_CHALLENGE_TTL_MS,
    private readonly _now: () => number = Date.now,
  ) {}

  remember(clientNonce: Uint8Array, serverNonce: Uint8Array, pq: bigint): PendingPqChallenge {
    const now = this._now()
    this._prune(now)
    while (this._challenges.length >= this._maxSize) {
      this._challenges.shift()
    }

    // TL reader 返回的可能是底层接收缓冲区的视图，复制一份以便跨帧及跨 TDLib 连接切换保留
    const challenge = {
      clientNonce: new Uint8Array(clientNonce),
      serverNonce: new Uint8Array(serverNonce),
      pq,
      createdAt: now,
    }
    this._challenges.push(challenge)
    return challenge
  }

  select(clientNonce: Uint8Array, serverNonce: Uint8Array): PendingPqChallenge {
    this._prune(this._now())
    const matchingNonce = this._challenges.filter((challenge) => typed.equal(challenge.clientNonce, clientNonce))
    if (matchingNonce.length === 0) {
      throw new Error('Step 2: invalid nonce from client')
    }

    const challenge = matchingNonce.find((candidate) => typed.equal(candidate.serverNonce, serverNonce))
    if (!challenge) {
      throw new Error('Step 2: invalid server nonce from client')
    }
    return challenge
  }

  private _prune(now: number): void {
    while (this._challenges.length > 0 && now - this._challenges[0].createdAt > this._ttlMs) {
      this._challenges.shift()
    }
  }
}

export async function receivePlainHandshakeObject(
  readerMap: TlReaderMap,
  log: Logger,
  recvPlain: () => Promise<Uint8Array>,
): Promise<PlainHandshakeObject> {
  for (;;) {
    const data = await recvPlain()
    const object = new TlBinaryReader(readerMap, data, 20).object() as PlainHandshakeObject
    if (object._ !== 'mt_msgs_ack') return object
    log.debug('ignoring plaintext msgs_ack during handshake')
  }
}

// Telegram 标准 DH 素数（客户端内置白名单，免去客户端素性检验）
// eslint-disable-next-line style/max-len
const KNOWN_DH_PRIME = 0xC71CAEB9C6B1C9048E6C522F70F13F73980D40238E3E21C14934D037563D930F48198A0AA7C14058229493D22530F4DBFA336F6E0AC925139543AED44CCE7C3720FD51F69458705AC68CD4FE6B6B13ABDC9746512969328454F18FAF8C595F642477FE96BB2A941D5BCD1D4AC8CC49880708FA9B378E3C4F3A9060BEE67CF9A4A4A695811051907E162753B56B0F6B410DBA74D8A84B2A14B3144E0EF1284754FD17ED950D5965B4B9DD46582DB1178D169C6BC465B0D6FF9CA3928FEF5B9AE4E418FC15E83EBEA0F87FA9FF5EED70050DED2849F47BF959D956850CE929851F0D8115F635B105EE2E4E15D04B2454BF6F4FADF034B10403119CD8E3B92FCC5Bn

const DH_G = 3n
const DH_SAFETY_RANGE = 2n ** (2048n - 64n)

export interface AuthorizationResult {
  /** 2048-bit 共享密钥 */
  authKey: Uint8Array
  /** `newNonce[0:8] XOR serverNonce[0:8]` */
  serverSalt: Long
  /** 服务端与客户端的时钟偏移（秒） */
  timeOffset: number
  /** 客户端是否在 `p_q_inner_data_temp_dc` 中请求了临时 PFS key */
  temporary: boolean
  /** 临时 PFS key 的过期 Unix 时间戳（秒） */
  expiresAt?: number
}

/**
 * 服务端 MTProto DH 密钥交换流程：
 * 1. 下发 `pq` 质因数分解挑战
 * 2. 用 RSA 私钥解密 `p_q_inner_data`，下发 `g_a = g^a mod prime`
 * 3. 接收客户端 `g_b`，计算 `auth_key = g_b^a mod prime`
 */
export async function doServerAuthorization(
  crypto: ICryptoProvider,
  readerMap: TlReaderMap,
  writerMap: TlWriterMap,
  log: Logger,
  privateKeyPem: string,
  keyFingerprint: Long,
  sendPlain: (message: mtp.TlObject) => Promise<void>,
  recvPlain: () => Promise<Uint8Array>,
  pqChallenges = new PqChallengeStore(),
): Promise<AuthorizationResult> {
  const authLog = log.create('auth')

  // Step 1: 响应 PQ 请求直到收到 req_DH_params。
  // Telegram Desktop / TDLib 可能并发探测多个 req_pq，并在另一条 TCP 连接上继续发 req_DH_params，
  // 因此由外层 MTProto 服务跨会话共享 pqChallenges。

  let clientNonce!: Uint8Array
  let serverNonce!: Uint8Array
  let pq!: bigint
  let reqDh: mtp.RawMt_req_DH_params
  for (;;) {
    const obj = await receivePlainHandshakeObject(readerMap, authLog, recvPlain)

    if (obj._ === 'mt_req_DH_params') {
      reqDh = obj as mtp.RawMt_req_DH_params
      break
    }
    if (obj._ !== 'mt_req_pq' && obj._ !== 'mt_req_pq_multi') {
      throw new Error(`Expected req_pq(_multi) or req_DH_params, got ${obj._}`)
    }

    const challenge = pqChallenges.remember(
      obj.nonce,
      crypto.randomBytes(16),
      generatePq().pq,
    )

    const resPq: mtp.RawMt_resPQ = {
      _: 'mt_resPQ',
      nonce: challenge.clientNonce,
      serverNonce: challenge.serverNonce,
      pq: bigintToBytes(challenge.pq),
      serverPublicKeyFingerprints: [keyFingerprint],
    }
    authLog.debug(
      'step 1: received %s, nonce = %h → sending resPQ (pq = %h)',
      obj._,
      challenge.clientNonce,
      bigintToBytes(challenge.pq),
    )
    await sendPlain(resPq)
  }

  // Step 2: 校验 p * q == pq，解密 p_q_inner_data，返回 server_DH_params_ok

  const selectedChallenge = pqChallenges.select(reqDh.nonce, reqDh.serverNonce)
  clientNonce = selectedChallenge.clientNonce
  serverNonce = selectedChallenge.serverNonce
  pq = selectedChallenge.pq

  const clientP = bigint.fromBytes(reqDh.p)
  const clientQ = bigint.fromBytes(reqDh.q)
  if (clientP * clientQ !== pq) {
    throw new Error('Step 2: p * q != pq')
  }

  authLog.debug('step 2: received req_DH_params, decrypting inner data')

  const decryptedData = rsaDecryptWithRetry(reqDh.encryptedData, crypto, privateKeyPem)

  const innerReader = new TlBinaryReader(readerMap, decryptedData)
  const pqInnerData = innerReader.object() as mtp.TlObject

  if (pqInnerData._ !== 'mt_p_q_inner_data_dc' && pqInnerData._ !== 'mt_p_q_inner_data_temp_dc') {
    throw new Error(`Expected p_q_inner_data_dc, got ${pqInnerData._}`)
  }

  const pqInner = pqInnerData as mtp.RawMt_p_q_inner_data_dc | mtp.RawMt_p_q_inner_data_temp_dc
  const temporary = pqInner._ === 'mt_p_q_inner_data_temp_dc'

  if (!typed.equal(pqInner.nonce, clientNonce)) {
    throw new Error('Step 2: invalid nonce in inner data')
  }
  if (!typed.equal(pqInner.serverNonce, serverNonce)) {
    throw new Error('Step 2: invalid server nonce in inner data')
  }

  const newNonce = pqInner.newNonce
  authLog.debug('step 2: decrypted inner data, newNonce = %h', newNonce)

  // 生成服务端 DH 参数：私钥 a 与公钥 g_a = g^a mod prime
  const a = bigint.fromBytes(crypto.randomBytes(256))
  const gA = bigint.modPowBinary(DH_G, a, KNOWN_DH_PRIME)
  const gABytes = bigint.toBytes(gA, 256)

  const serverTime = Math.floor(Date.now() / 1000)
  const expiresAt = temporary
    ? serverTime + pqInner.expiresIn
    : undefined

  const serverDhInner: mtp.RawMt_server_DH_inner_data = {
    _: 'mt_server_DH_inner_data',
    nonce: clientNonce,
    serverNonce,
    g: Number(DH_G),
    dhPrime: bigint.toBytes(KNOWN_DH_PRIME, 256),
    gA: gABytes,
    serverTime,
  }

  // 序列化 inner data，前置 20 字节 SHA1，按 16 字节对齐后做 AES-IGE 加密
  const innerLength = TlSerializationCounter.countNeededBytes(writerMap, serverDhInner) + 20
  const paddedLength = innerLength + ((16 - (innerLength % 16)) % 16)
  const innerWriter = TlBinaryWriter.alloc(writerMap, paddedLength)
  innerWriter.pos = 20
  innerWriter.object(serverDhInner)
  const innerHash = crypto.sha1(innerWriter.uint8View.subarray(20, innerWriter.pos))
  innerWriter.pos = 0
  innerWriter.raw(innerHash)

  const [aesKey, aesIv] = generateKeyAndIvFromNonce(crypto, serverNonce, newNonce)
  const ige = crypto.createAesIge(aesKey, aesIv)
  const encryptedInner = ige.encrypt(innerWriter.uint8View.subarray(0, paddedLength))

  const serverDhParamsOk: mtp.RawMt_server_DH_params_ok = {
    _: 'mt_server_DH_params_ok',
    nonce: clientNonce,
    serverNonce,
    encryptedAnswer: encryptedInner,
  }

  authLog.debug('step 2: sending server_DH_params_ok')
  await sendPlain(serverDhParamsOk)

  // Step 3: 接收 set_client_DH_params，派生 auth key 并返回 dh_gen_ok

  const setClientDh = await receivePlainHandshakeObject(readerMap, authLog, recvPlain)

  if (setClientDh._ !== 'mt_set_client_DH_params') {
    throw new Error(`Expected mt_set_client_DH_params, got ${setClientDh._}`)
  }

  if (!typed.equal(setClientDh.nonce, clientNonce)) {
    throw new Error('Step 3: invalid nonce from client')
  }
  if (!typed.equal(setClientDh.serverNonce, serverNonce)) {
    throw new Error('Step 3: invalid server nonce from client')
  }

  const clientDhDecrypted = ige.decrypt(setClientDh.encryptedData)

  const clientDhHash = clientDhDecrypted.subarray(0, 20)
  const clientDhInnerReader = new TlBinaryReader(readerMap, clientDhDecrypted, 20)
  const clientDhInner = clientDhInnerReader.object() as mtp.RawMt_client_DH_inner_data

  if (clientDhInner._ !== 'mt_client_DH_inner_data') {
    throw new Error(`Expected mt_client_DH_inner_data, got ${clientDhInner._}`)
  }

  if (!typed.equal(clientDhHash, crypto.sha1(clientDhDecrypted.subarray(20, clientDhInnerReader.pos)))) {
    throw new Error('Step 3: invalid client DH inner data hash')
  }

  const gB = bigint.fromBytes(clientDhInner.gB)

  if (gB <= 1n || gB >= KNOWN_DH_PRIME - 1n) {
    throw new Error('Step 3: g_b is not within (1, dh_prime - 1)')
  }
  if (gB <= DH_SAFETY_RANGE || gB >= KNOWN_DH_PRIME - DH_SAFETY_RANGE) {
    throw new Error('Step 3: g_b is not within safety range')
  }

  const authKey = bigint.toBytes(bigint.modPowBinary(gB, a, KNOWN_DH_PRIME))
  const authKeyAuxHash = crypto.sha1(authKey).subarray(0, 8)

  const serverSaltBytes = u8.xor(newNonce.subarray(0, 8), serverNonce.subarray(0, 8))
  const saltDv = typed.toDataView(serverSaltBytes)
  const serverSalt = new Long(saltDv.getInt32(0, true), saltDv.getInt32(4, true))

  const newNonceHash1 = crypto.sha1(u8.concat3(newNonce, [1], authKeyAuxHash)).subarray(4, 20)

  const timeOffset = serverTime - Math.floor(Date.now() / 1000)

  const dhGenOk: mtp.RawMt_dh_gen_ok = {
    _: 'mt_dh_gen_ok',
    nonce: clientNonce,
    serverNonce,
    newNonceHash1: newNonceHash1,
  }

  authLog.debug('step 3: sending dh_gen_ok, auth key id = %h', crypto.sha1(authKey).subarray(-8))
  await sendPlain(dhGenOk)

  authLog.info('server authorization successful')

  return { authKey, serverSalt, timeOffset, temporary, expiresAt }
}

/**
 * 解密 RSA 密文，优先尝试 MTProto 新版填充（`rsaPad` / OAEP+ 变体），失败则回退到旧版 SHA1 填充。
 */
function rsaDecryptWithRetry(
  encryptedData: Uint8Array,
  crypto: ICryptoProvider,
  privateKeyPem: string,
): Uint8Array {
  const ciphertext = bigint.fromBytes(encryptedData)
  const plaintext = rsaRawDecrypt(ciphertext, privateKeyPem) // 256 bytes

  const newData = tryUnpadNew(plaintext, crypto)
  if (newData) return newData

  const oldData = tryUnpadOld(plaintext, crypto)
  if (oldData) return oldData

  throw new Error('RSA decryption failed: could not unpad with either method')
}

/**
 * 逆向解包 MTProto 新版 `rsaPad` 填充：
 * 1. `plaintext(256)` 拆分为 `xoredKey(32) + encrypted(224)`
 * 2. `aesKey = xoredKey XOR SHA256(encrypted)`
 * 3. 用零 IV 的 AES-IGE 解密 `encrypted` 得到 `dataWithHash(224)`
 * 4. 反转前 192 字节，拆分为 `data(192) + hash(32)`
 * 5. 校验 `hash == SHA256(aesKey + data)`
 */
function tryUnpadNew(plaintext: Uint8Array, crypto: ICryptoProvider): Uint8Array | null {
  try {
    const xoredKey = plaintext.subarray(0, 32)
    const encrypted = plaintext.subarray(32)

    const encryptedHash = crypto.sha256(encrypted)
    const aesKey = u8.alloc(32)
    for (let i = 0; i < 32; i++) {
      aesKey[i] = xoredKey[i] ^ encryptedHash[i]
    }

    const aesIv = u8.alloc(32)
    const ige = crypto.createAesIge(aesKey, aesIv)
    const dataWithHash = ige.decrypt(encrypted)

    const reversed = u8.alloc(dataWithHash.length)
    reversed.set(dataWithHash)
    reversed.subarray(0, 192).reverse()

    const data = reversed.subarray(0, 192)
    const hash = reversed.subarray(192)

    const expectedHash = crypto.sha256(u8.concat2(aesKey, data))
    if (!typed.equal(hash, expectedHash)) {
      console.error('[tryUnpadNew] hash mismatch!')
      console.error('[tryUnpadNew] plaintext len:', plaintext.length)
      console.error('[tryUnpadNew] encrypted len:', encrypted.length)
      console.error('[tryUnpadNew] dataWithHash len:', dataWithHash.length)
      console.error('[tryUnpadNew] data[0:4]:', Array.from(data.subarray(0, 4)))
      console.error('[tryUnpadNew] hash:', Buffer.from(hash).toString('hex'))
      console.error('[tryUnpadNew] expected:', Buffer.from(expectedHash).toString('hex'))
      return null
    }

    return data
  } catch (e) {
    console.error('[tryUnpadNew] exception:', e)
    return null
  }
}

/**
 * 逆向解包旧版 `rsaEncrypt` 填充（`SHA1(data)(20) + data + randomPadding`）。
 * 现代客户端均使用新版 `rsaPad`，此处仅检查 TL constructor ID，不实际启用旧填充。
 */
function tryUnpadOld(plaintext: Uint8Array, crypto: ICryptoProvider): Uint8Array | null {
  try {
    const hash = plaintext.subarray(0, 20)
    const data = plaintext.subarray(20)

    // mt_p_q_inner_data_dc = 0xAA57B5D5, mt_p_q_inner_data_temp_dc = 0x57069388
    const constructorId = (data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24)) >>> 0
    if (constructorId !== 0xAA57B5D5 && constructorId !== 0x57069388) {
      return null
    }

    return null
  } catch {
    return null
  }
}

function bigintToBytes(val: bigint): Uint8Array {
  const hex = val.toString(16)
  const padded = hex.length % 2 === 0 ? hex : `0${hex}`
  const buf = new Uint8Array(padded.length / 2)
  for (let i = 0; i < buf.length; i++) {
    buf[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16)
  }
  return buf
}
