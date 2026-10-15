import type { ICryptoProvider, Logger } from '@mtcute/core/utils.js'
import type { TlReaderMap } from '@mtcute/tl-runtime'
import type Long from 'long'
import type { tl } from '@mtcute/core'
import { typed, u8 } from '@fuman/utils'
import { TlBinaryReader } from '@mtcute/tl-runtime'
import { createAesIgeForMessage } from '@mtcute/core/utils.js'

/**
 * 服务端 MTProto v2 消息加解密封装。
 *
 * 客户端与服务端使用同一 auth key 的不同切片派生密钥：
 * - 解密客户端消息：`msg_key = SHA256(authKey[88:120] + plaintext)[8:24]`，`client=true` (x=0)
 * - 加密服务端消息：`msg_key = SHA256(authKey[96:128] + plaintext)[8:24]`，`client=false` (x=8)
 */
export class ServerAuthKey {
  ready = false
  key!: Uint8Array
  id!: Uint8Array
  /** authKey[88:120]，用于派生客户端→服务端方向的 msg_key */
  clientSalt!: Uint8Array
  /** authKey[96:128]，用于派生服务端→客户端方向的 msg_key */
  serverSalt!: Uint8Array

  constructor(
    readonly _crypto: ICryptoProvider,
    readonly _log: Logger,
    readonly _readerMap: TlReaderMap,
  ) {}

  setup(authKey?: Uint8Array | null): void {
    if (!authKey) {
      this.ready = false
      return
    }
    this.ready = true
    this.key = authKey
    this.clientSalt = authKey.subarray(88, 120)
    this.serverSalt = authKey.subarray(96, 128)
    this.id = new Uint8Array(this._crypto.sha1(authKey).subarray(-8))
    this._log.verbose('server auth key set up, id = %h', this.id)
  }

  reset(): void {
    this.ready = false
  }

  match(keyId: Uint8Array): boolean {
    return this.ready && typed.equal(keyId, this.id)
  }

  /**
   * 加密服务端→客户端消息（MTProto v2，`client=false` / x=8）。
   * 输入 `message` 为 `msg_id + seq_no + length + body`，返回 `authKeyId(8) + messageKey(16) + ciphertext`。
   */
  encryptMessage(message: Uint8Array, serverSalt: Long, sessionId: Long): Uint8Array {
    if (!this.ready) throw new Error('Auth key not set up')

    // 填充至少 12 字节随机数据，并对齐到 16 字节边界
    let padding = (16 + message.length + 12) % 16
    padding = 12 + (padding ? 16 - padding : 0)

    const buf = u8.alloc(16 + message.length + padding)
    const dv = typed.toDataView(buf)
    dv.setInt32(0, serverSalt.low, true)
    dv.setInt32(4, serverSalt.high, true)
    dv.setInt32(8, sessionId.low, true)
    dv.setInt32(12, sessionId.high, true)
    buf.set(message, 16)
    this._crypto.randomFill(buf.subarray(16 + message.length, 16 + message.length + padding))

    const messageKey = this._crypto.sha256(u8.concat2(this.serverSalt, buf)).subarray(8, 24)
    const ige = createAesIgeForMessage(this._crypto, this.key, messageKey, false)
    const encryptedData = ige.encrypt(buf)

    return u8.concat3(this.id, messageKey, encryptedData)
  }

  /**
   * 解密客户端→服务端消息（MTProto v2，`client=true` / x=0）。
   * `sessionId` 为 `null` 时跳过校验（用于从首包提取客户端 session_id）。
   */
  decryptMessage(
    data: Uint8Array,
    sessionId: Long | null,
    callback: (msgId: tl.Long, seqNo: number, reader: TlBinaryReader, sessionId: Long) => void,
  ): void {
    const messageKey = data.subarray(8, 24)
    let encryptedData = data.subarray(24)

    // 剥离非 16 字节对齐的传输层填充
    const mod16 = encryptedData.byteLength % 16
    if (mod16 !== 0) {
      encryptedData = encryptedData.subarray(0, encryptedData.byteLength - mod16)
    }

    const ige = createAesIgeForMessage(this._crypto, this.key, messageKey, true)
    const innerData = ige.decrypt(encryptedData)

    const expectedMessageKey = this._crypto.sha256(u8.concat2(this.clientSalt, innerData)).subarray(8, 24)
    if (!typed.equal(messageKey, expectedMessageKey)) {
      this._log.warn('received message with invalid messageKey = %h (expected %h)', messageKey, expectedMessageKey)
      return
    }

    const innerReader = new TlBinaryReader(this._readerMap, innerData)
    innerReader.seek(8) // 跳过 server_salt
    const sessionId_ = innerReader.long()
    const rawBytes = innerData.subarray(0, 32)
    this._log.verbose('decrypted innerData[0:32] = %h, sessionId = %h', rawBytes, sessionId_)
    if (sessionId !== null && sessionId_.neq(sessionId)) {
      this._log.warn('ignoring message with invalid sessionId = %h (expected %h)', sessionId_, sessionId)
      return
    }

    const messageId = innerReader.long(true)
    const seqNo = innerReader.uint()
    const length = innerReader.uint()

    if (length > innerData.length - 32) {
      this._log.warn('ignoring message with invalid length: %d > %d', length, innerData.length - 32)
      return
    }

    if (length % 4 !== 0) {
      this._log.warn('ignoring message with invalid length: %d is not a multiple of 4', length)
      return
    }

    const paddingSize = innerData.length - length - 32
    if (paddingSize < 12 || paddingSize > 1024) {
      this._log.warn('ignoring message with invalid padding size: %d', paddingSize)
      return
    }

    callback(messageId, seqNo, innerReader, sessionId_)
  }
}
