import type { IPacketCodec } from '@mtcute/core'
import type { IAesCtr, ICryptoProvider, Logger } from '@mtcute/core/utils.js'
import { IntermediatePacketCodec, PaddedIntermediatePacketCodec } from '@mtcute/core'
import { Bytes, read, write, type ISyncWritable } from '@fuman/io'
import { reclaimReceiveBuffer } from './receive-buffer.js'
import { u8 } from '@fuman/utils'

const EMPTY_TAG = new Uint8Array(0)

/**
 * Abridged 传输层编解码器（客户端首字节标识 `0xef`）。
 * 帧格式：长度头（以 4 字节字为单位）+ 载荷。
 *   - 长度 < 0x7f：单字节 `length`
 *   - 长度 >= 0x7f：`0x7f` + 3 字节小端 `length`
 */
export class AbridgedPacketCodec implements IPacketCodec {
  tag(): Uint8Array {
    return new Uint8Array([0xef])
  }

  decode(reader: Bytes, eof: boolean): Uint8Array | null {
    if (eof) return null
    if (reader.available < 1) return null

    const firstByte = reader.readSync(1)[0]
    // 客户端请求 quick ack 时会置位 abridged 长度字节的最高位（bit 7），计算帧长时需掩去。
    const lengthMarker = firstByte & 0x7f
    let length: number
    let headerSize: number
    if (lengthMarker < 0x7f) {
      length = lengthMarker * 4
      headerSize = 1
    } else {
      if (reader.available < 3) {
        reader.rewind(1)
        return null
      }
      const b = reader.readSync(3)
      length = (b[0] | (b[1] << 8) | (b[2] << 16)) * 4
      headerSize = 4
    }

    if (reader.available < length) {
      reader.rewind(headerSize)
      return null
    }

    return new Uint8Array(read.exactly(reader, length))
  }

  encode(frame: Uint8Array, into: ISyncWritable): void {
    const words = frame.length >> 2
    if (words >= 0x7f) {
      const header = new Uint8Array(4)
      header[0] = 0x7f
      header[1] = words & 0xff
      header[2] = (words >> 8) & 0xff
      header[3] = (words >> 16) & 0xff
      write.bytes(into, header)
    } else {
      write.bytes(into, new Uint8Array([words]))
    }
    write.bytes(into, frame)
  }

  reset(): void {}
}

/** 服务端混淆传输层编解码器：在外层做 AES-CTR 流加解密，内层委托给具体的协议分帧器 */
export class ServerObfuscatedCodec implements IPacketCodec {
  private _decodeBuf = Bytes.alloc()

  constructor(
    private readonly _encryptor: IAesCtr,
    private readonly _decryptor: IAesCtr,
    private readonly _inner: IPacketCodec,
  ) {}

  tag(): Uint8Array {
    return EMPTY_TAG
  }

  decode(reader: Bytes, eof: boolean): Uint8Array | Promise<Uint8Array | null> | null {
    if (eof) return null
    if (reader.available > 0) {
      this._decodeBuf = reclaimReceiveBuffer(this._decodeBuf, 16 * 1024)
      const decrypted = this._decryptor.process(reader.readSync(reader.available))
      const into = this._decodeBuf.writeSync(decrypted.length)
      into.set(decrypted)
    }
    const frame = this._inner.decode(this._decodeBuf, eof)
    return frame instanceof Promise ? frame.then(value => this._finishDecode(value)) : this._finishDecode(frame)
  }

  private _finishDecode(frame: Uint8Array | null): Uint8Array | null {
    // 若内层解码器返回了共享底层 buffer 的视图，需在压缩缓冲区前拷贝一份
    if (frame && frame.buffer === this._decodeBuf.result().buffer) frame = new Uint8Array(frame)
    // 仅在等待更多数据或缓冲区已排空时回收，避免批量解帧时反复搬移尾部数据
    if (frame === null || this._decodeBuf.available === 0) {
      this._decodeBuf = reclaimReceiveBuffer(this._decodeBuf, 16 * 1024)
    }
    return frame
  }

  encode(frame: Uint8Array, into: ISyncWritable): void {
    const temp = Bytes.alloc(frame.length + 64)
    const result = this._inner.encode(frame, temp)
    if (result instanceof Promise) {
      throw new TypeError('inner codec must encode synchronously under obfuscation')
    }
    write.bytes(into, this._encryptor.process(temp.result()))
  }

  reset(): void {
    this._inner.reset()
    this._decodeBuf = Bytes.alloc()
    this._encryptor.close?.()
    this._decryptor.close?.()
  }
}

function allEqual(bytes: Uint8Array, value: number): boolean {
  return bytes[0] === value && bytes[1] === value && bytes[2] === value && bytes[3] === value
}

function selectInnerCodec(tag: Uint8Array, crypto: ICryptoProvider, log: Logger): IPacketCodec {
  if (allEqual(tag, 0xdd)) {
    const codec = new PaddedIntermediatePacketCodec()
    codec.setup?.(crypto)
    return codec
  }
  if (allEqual(tag, 0xef)) {
    return new AbridgedPacketCodec()
  }
  if (!allEqual(tag, 0xee)) {
    log.warn('obfuscated: unknown inner protocol tag %h, defaulting to intermediate', tag)
  }
  return new IntermediatePacketCodec()
}

/**
 * 从客户端发送的 64 字节混淆握手头派生服务端 AES-CTR 编解码器。
 * 握手头布局：`[8:40]` 客户端加密 key，`[40:56]` 加密 IV；将 `[8:56]` 逆序后前 32 字节为服务端加密 key、后 16 字节为 IV。
 * 客户端发送前用自身加密器加密了 `[56:64]`，因此服务端解密器需先推进完整 64 字节以同步密钥流，并从解密后的 `[56:60]` 取出内层协议标识。
 */
export function createServerObfuscation(
  header: Uint8Array,
  crypto: ICryptoProvider,
  log: Logger,
): { codec: ServerObfuscatedCodec, innerTag: Uint8Array } {
  if (header.length !== 64) {
    throw new RangeError(`obfuscation header must be 64 bytes, got ${header.length}`)
  }

  const encryptKey = header.subarray(8, 40)
  const encryptIv = header.subarray(40, 56)
  const reversed = u8.toReversed(header.subarray(8, 56))
  const decryptKey = reversed.subarray(0, 32)
  const decryptIv = reversed.subarray(32, 48)

  const decryptor = crypto.createAesCtr(encryptKey, encryptIv, false)
  const encryptor = crypto.createAesCtr(decryptKey, decryptIv, true)

  const decryptedHeader = decryptor.process(header)
  const innerTag = decryptedHeader.subarray(56, 60)

  const inner = selectInnerCodec(innerTag, crypto, log)
  return { codec: new ServerObfuscatedCodec(encryptor, decryptor, inner), innerTag }
}
