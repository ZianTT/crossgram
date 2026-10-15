import {
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  privateDecrypt,
  generatePrimeSync,
  createHash,
  constants,
} from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface ServerRsaKey {
  /** 客户端 patch 所用的 PKCS#1 PEM 公钥 */
  publicKeyPem: string
  /** PKCS#8 PEM 私钥 */
  privateKeyPem: string
  /** Telegram 公钥指纹：SHA1(TL_bytes(n) ++ TL_bytes(e)) 低 64 位的 hex */
  fingerprint: string
  modulus: string
  exponent: string
}

function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let v = 0n
  for (const b of bytes) v = (v << 8n) | BigInt(b)
  return v
}

function bigIntToBytesBE(v: bigint): Uint8Array {
  let hex = v.toString(16)
  if (hex.length % 2) hex = `0${hex}`
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bigIntToBytesN(v: bigint, n: number): Uint8Array {
  const out = new Uint8Array(n)
  let x = v
  for (let i = n - 1; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n }
  return out
}

/** TL bytes 编码：长度前缀 + 数据 + 4 字节对齐填充 */
function tlBytes(data: Uint8Array): Uint8Array {
  let head: number[]
  let total: number
  if (data.length < 254) {
    head = [data.length]
    total = 1 + data.length
  } else {
    head = [254, data.length & 0xff, (data.length >> 8) & 0xff, (data.length >> 16) & 0xff]
    total = 4 + data.length
  }
  const pad = (4 - (total % 4)) % 4
  const out = new Uint8Array(head.length + data.length + pad)
  out.set(head, 0)
  out.set(data, head.length)
  return out
}

/** 计算 Telegram RSA 指纹：取 SHA1(TL_bytes(n) ++ TL_bytes(e)) 末尾 8 字节逆序后的 16 位 hex */
function computeFingerprint(n: bigint, e: bigint): string {
  const serialized = new Uint8Array([...tlBytes(bigIntToBytesBE(n)), ...tlBytes(bigIntToBytesBE(e))])
  const sha = createHash('sha1').update(serialized).digest()
  const reversed = Uint8Array.from(sha.subarray(sha.length - 8)).reverse()
  let fp = ''
  for (const b of reversed) fp += b.toString(16).padStart(2, '0')
  return fp
}

export function generateRsaKeyPair(): ServerRsaKey {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })

  const jwk = createPublicKey(publicKey).export({ format: 'jwk' }) as { n: string, e: string }
  const n = bytesToBigIntBE(new Uint8Array(Buffer.from(jwk.n, 'base64url')))
  const e = bytesToBigIntBE(new Uint8Array(Buffer.from(jwk.e, 'base64url')))

  return {
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    fingerprint: computeFingerprint(n, e),
    modulus: n.toString(16),
    exponent: e.toString(16),
  }
}

/** 从 JSON 路径加载密钥对；若不存在则生成并写入 JSON 与 `<path>.pem` */
export function loadOrCreateRsaKeyPair(path: string): ServerRsaKey {
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf8')) as ServerRsaKey
  }
  const key = generateRsaKeyPair()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(key, null, 2))
  writeFileSync(`${path}.pem`, key.publicKeyPem)
  return key
}

/** 裸 RSA 解密（无 padding），返回 256 字节大端 `ciphertext^d mod n`，外层负责去除 MTProto 填充 */
export function rsaRawDecrypt(ciphertext: bigint, privateKeyPem: string): Uint8Array {
  const key = createPrivateKey(privateKeyPem)
  const input = Buffer.from(bigIntToBytesN(ciphertext, 256))
  const out = privateDecrypt({ key, padding: constants.RSA_NO_PADDING }, input)
  return new Uint8Array(out)
}

/** 生成两个 31 位素数之积 pq（pq < 2^63，供客户端分解） */
export function generatePq(): { pq: bigint, p: bigint, q: bigint } {
  let p = generatePrimeSync(31, { bigint: true }) as bigint
  let q = generatePrimeSync(31, { bigint: true }) as bigint
  if (p > q) [p, q] = [q, p]
  return { pq: p * q, p, q }
}
