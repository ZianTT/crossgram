import { createHash, pbkdf2 as nodePbkdf2, randomBytes, timingSafeEqual } from 'node:crypto'
import Long from 'long'
import { bigint, u8 } from '@fuman/utils'

/** Telegram 2048 位 SRP 安全素数（与 MTProto DH 交换相同）。 */
// eslint-disable-next-line style/max-len
export const SRP_PRIME_HEX = 'C71CAEB9C6B1C9048E6C522F70F13F73980D40238E3E21C14934D037563D930F48198A0AA7C14058229493D22530F4DBFA336F6E0AC925139543AED44CCE7C3720FD51F69458705AC68CD4FE6B6B13ABDC9746512969328454F18FAF8C595F642477FE96BB2A941D5BCD1D4AC8CC49880708FA9B378E3C4F3A9060BEE67CF9A4A4A695811051907E162753B56B0F6B410DBA74D8A84B2A14B3144E0EF1284754FD17ED950D5965B4B9DD46582DB1178D169C6BC465B0D6FF9CA3928FEF5B9AE4E418FC15E83EBEA0F87FA9FF5EED70050DED2849F47BF959D956850CE929851F0D8115F635B105EE2E4E15D04B2454BF6F4FADF034B10403119CD8E3B92FCC5B'

const SRP_PRIME = BigInt(`0x${SRP_PRIME_HEX}`)
const SRP_G = 3n
const SRP_G_BYTES = (() => {
  const bytes = u8.alloc(256)
  bytes[255] = Number(SRP_G)
  return bytes
})() // 与客户端一致：g 按 256 字节大端序编码
const SRP_P_BYTES = Buffer.from(SRP_PRIME_HEX, 'hex')
const K = BigInt(`0x${createHash('sha256').update(SRP_P_BYTES).update(SRP_G_BYTES).digest('hex')}`)

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest()

export interface SrpVerifier {
  /** g^x mod p，256 字节十六进制字符串。 */
  v: string
  salt1: string
  salt2: string
}

/** 校验 `passwordSrp` 字段是否包含完整的验证子（旧记录迁移后的默认空对象 `{}` 视为未设置密码）。 */
export function isValidSrpVerifier(value: unknown): value is SrpVerifier {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.v === 'string' && candidate.v.length > 0
    && typeof candidate.salt1 === 'string' && candidate.salt1.length > 0
    && typeof candidate.salt2 === 'string' && candidate.salt2.length > 0
}

function to256(value: bigint): Uint8Array {
  return bigint.toBytes(value, 256)
}

function fromU8(value: Uint8Array): bigint {
  return bigint.fromBytes(value)
}

// 与 mtcute computePasswordHash 一致：
// SH(d, s) = SHA256(s || d || s); x = SH(PBKDF2(SH(SH(pwd, s1), s2), s1, 100k, 64), s2)
async function computePasswordHash(password: string, salt1: Uint8Array, salt2: Uint8Array): Promise<bigint> {
  const SH = (data: Uint8Array, salt: Uint8Array) => sha256(u8.concat3(salt, data, salt))
  const ph1 = SH(SH(Buffer.from(password, 'utf8'), salt1), salt2)
  const stretched = await new Promise<Buffer>((resolve, reject) => nodePbkdf2(
    ph1, salt1, 100_000, 64, 'sha512', (err, buf) => err ? reject(err) : resolve(buf),
  ))
  return fromU8(SH(stretched, salt2))
}

export async function generateSrpVerifier(password: string): Promise<SrpVerifier> {
  const salt1 = randomBytes(32)
  const salt2 = randomBytes(16)
  const x = await computePasswordHash(password, salt1, salt2)
  const v = bigint.modPowBinary(SRP_G, x, SRP_PRIME)
  return { v: Buffer.from(to256(v)).toString('hex'), salt1: salt1.toString('hex'), salt2: salt2.toString('hex') }
}

export interface SrpChallenge {
  srpId: Long
  b: bigint
  /** 服务端公钥 `B = (k·v + g^b) mod p`。 */
  B: bigint
  verifier: SrpVerifier
}

const CHALLENGE_TTL_MS = 5 * 60_000

export class SrpChallengeStore {
  private readonly _entries = new Map<string, { challenge: SrpChallenge, expiresAt: number }>()

  constructor(private readonly _now: () => number = Date.now) {}

  begin(authKeyId: string, verifier: SrpVerifier): SrpChallenge {
    this._prune()
    const b = fromU8(randomBytes(256))
    const B = (K * fromU8(Buffer.from(verifier.v, 'hex')) + bigint.modPowBinary(SRP_G, b, SRP_PRIME)) % SRP_PRIME
    const random = randomBytes(8)
    const challenge: SrpChallenge = {
      srpId: new Long(
        random.readInt32LE(0) | 0,
        random.readInt32LE(4) | 0,
      ),
      b,
      B,
      verifier,
    }
    this._entries.set(authKeyId, { challenge, expiresAt: this._now() + CHALLENGE_TTL_MS })
    return challenge
  }

  get(authKeyId: string): SrpChallenge | undefined {
    this._prune()
    return this._entries.get(authKeyId)?.challenge
  }

  delete(authKeyId: string): void {
    this._entries.delete(authKeyId)
  }

  private _prune(): void {
    const now = this._now()
    for (const [key, entry] of this._entries) {
      if (entry.expiresAt <= now) this._entries.delete(key)
    }
  }
}

export interface SrpCheckRequest {
  srpId: Long
  /** 客户端公钥 `A`（256 字节）。 */
  A: Uint8Array
  /** 客户端证明 `M1`（32 字节）。 */
  M1: Uint8Array
}

/**
 * 校验客户端 SRP 证明。
 * 不主动清理 challenge，由调用方在验证通过后删除，确保验证失败后客户端重试可继续复用同一个 `B`。
 */
export function verifySrpChallenge(challenge: SrpChallenge, request: SrpCheckRequest): boolean {
  if (!request.srpId.eq(challenge.srpId)) return false
  const A = fromU8(request.A)
  if (A <= 1n || A >= SRP_PRIME) return false
  const ABytes = to256(A)
  const BBytes = to256(challenge.B)
  const u = fromU8(sha256(u8.concat2(ABytes, BBytes)))
  const v = fromU8(Buffer.from(challenge.verifier.v, 'hex'))
  // S = (A * v^u)^b mod p
  const S = bigint.modPowBinary(A * bigint.modPowBinary(v, u, SRP_PRIME) % SRP_PRIME, challenge.b, SRP_PRIME)
  const KSession = sha256(to256(S))
  const H = (data: Uint8Array) => sha256(data)
  const expected = sha256(u8.concat([
    u8.xor(H(SRP_P_BYTES), H(SRP_G_BYTES)),
    H(Buffer.from(challenge.verifier.salt1, 'hex')),
    H(Buffer.from(challenge.verifier.salt2, 'hex')),
    ABytes,
    BBytes,
    KSession,
  ]))
  return request.M1.length === expected.length && timingSafeEqual(expected, request.M1)
}
