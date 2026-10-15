import type { ServerTransportSocket } from './server-socket.js'
import type { IPacketCodec } from '@mtcute/core'
import type { ICryptoProvider, Logger } from '@mtcute/core/utils.js'
import { IntermediatePacketCodec, PaddedIntermediatePacketCodec } from '@mtcute/core'
import { Bytes } from '@fuman/io'
import { reclaimReceiveBuffer } from './receive-buffer.js'
import { AbridgedPacketCodec, createServerObfuscation } from './server-obfuscation.js'

export interface TransportTrafficSample {
  direction: 'received' | 'sent'
  bytes: number
  timestamp: number
}

export type TransportSendCompletion = 'written' | 'closed' | 'encode-failed' | 'write-failed' | 'abandoned' | 'timeout'

export const TRANSPORT_SETTLE_TIMEOUT_MS = 30_000

interface PendingSend {
  data: Uint8Array
  closeAfterWrite: boolean
  abandoned: boolean
  started: boolean
  submitted: boolean
  settle?: (outcome: TransportSendCompletion) => void
}

/**
 * 单个客户端传输连接，根据客户端首包自动识别 MTProto 传输协议：
 *   - `0xef`：abridged（明文）
 *   - `0xeeeeeeee`：intermediate（明文）
 *   - `0xdddddddd`：padded intermediate（明文）
 *   - 其余 64 字节头：obfuscated2（AES-CTR）
 */
export class ServerConnection {
  private _closed = false
  private _readPaused = false
  private _recvBuffer = Bytes.alloc(65536)
  private _pendingSocketData: Uint8Array[] = []
  private _decoding = false
  private _pendingSends: PendingSend[] = []
  private _completionSends = new Set<PendingSend>()
  private _encoding = false
  private _closing = false
  private _pendingCloseFrame: Uint8Array | null = null
  private _messageHandler: ((data: Uint8Array) => void) | null = null
  private _codec: IPacketCodec | null = null
  // 记录出现写背压（socket.write 返回 false）的起始时间，drain 时清零；用于检测对端假死但 TCP 仍保持 ESTABLISHED 的僵尸连接。
  private _backpressuredSince: number | null = null
  private readonly _onDrain = (): void => {
    this._backpressuredSince = null
  }
  private readonly _onData = (data: Buffer): void => this._handleData(data)
  private readonly _onError = (error: Error): void => {
    this._log.warn('socket error: %s', error.message)
  }
  private readonly _onClose = (): void => {
    this._closed = true
    this._readPaused = false
    this._closing = true
    this._settlePendingSends('closed')
    this._backpressuredSince = null
  }

  constructor(
    private readonly _socket: ServerTransportSocket,
    private readonly _crypto: ICryptoProvider,
    private readonly _log: Logger,
    private readonly _onTraffic?: (sample: TransportTrafficSample) => void,
  ) {
    _socket.on('data', this._onData)
    _socket.on('drain', this._onDrain)
    _socket.on('error', this._onError)
    _socket.on('close', this._onClose)
  }

  listen(handler: (data: Uint8Array) => void): () => void {
    if (this._messageHandler) throw new Error('MTProto connection already has a frame consumer')
    this._messageHandler = handler
    return () => {
      this._messageHandler = null
    }
  }

  send(data: Uint8Array): void {
    this._send(data, false)
  }

  sendAndWait(data: Uint8Array): Promise<TransportSendCompletion> {
    return new Promise((resolve) => this._send(data, false, resolve))
  }

  sendAndClose(data: Uint8Array): void {
    this._send(data, true)
  }

  private _send(
    data: Uint8Array,
    closeAfterWrite: boolean,
    completion?: (outcome: TransportSendCompletion) => void,
  ): void {
    if (this._closed || this._closing) {
      completion?.('closed')
      return
    }
    if (!this._codec) {
      this._log.warn('send() called before transport was detected; dropping %d bytes', data.length)
      completion?.('abandoned')
      if (closeAfterWrite) this.close()
      return
    }

    if (closeAfterWrite) this._closing = true
    const pending: PendingSend = {
      data: new Uint8Array(data), closeAfterWrite, abandoned: false, started: false, submitted: false,
    }
    if (completion) {
      this._completionSends.add(pending)
      const timeout = setTimeout(() => {
        pending.abandoned = true
        this._settlePendingSend(pending, 'timeout')
        if (pending.started || this._encoding) this.close()
      }, TRANSPORT_SETTLE_TIMEOUT_MS)
      pending.settle = (outcome) => {
        clearTimeout(timeout)
        completion(outcome)
      }
    }
    // 混淆传输使用有状态的 AES-CTR，编码与底层写入必须严格保序
    this._pendingSends.push(pending)
    this._drainSendQueue()
  }

  private _drainSendQueue(): void {
    if (this._encoding || this._closed) return
    const pending = this._pendingSends.shift()
    if (!pending) return
    if (pending.abandoned) {
      this._drainSendQueue()
      return
    }

    this._encoding = true
    pending.started = true
    const writable = Bytes.alloc(pending.data.length + 16)
    const write = () => {
      if (this._closed) {
        this._settlePendingSend(pending, 'closed')
        return
      }
      if (pending.abandoned) return
      const encoded = writable.result()
      this._onTraffic?.({ direction: 'sent', bytes: encoded.length, timestamp: Date.now() })
      if (pending.closeAfterWrite) {
        this._pendingCloseFrame = encoded
        this._finishPendingClose()
      } else {
        try {
          pending.submitted = true
          const flushed = this._socket.write(encoded, (error) => {
            this._settlePendingSend(pending, error ? 'write-failed' : 'written')
          })
          if (!flushed && this._backpressuredSince === null) {
            this._backpressuredSince = Date.now()
          }
        } catch (error) {
          this._log.error('socket write failed: %s', error instanceof Error ? error.stack : error)
          this._settlePendingSend(pending, 'write-failed')
          this.close()
        }
      }
    }
    const complete = () => {
      this._encoding = false
      this._drainSendQueue()
    }
    const fail = (error: unknown) => {
      this._log.error('transport encode failed: %s', error instanceof Error ? error.stack : error)
      this._settlePendingSend(pending, 'encode-failed')
      this.close()
    }

    try {
      const result = this._codec!.encode(pending.data, writable)
      if (result instanceof Promise) {
        result.then(write, fail).finally(complete)
      } else {
        write()
        complete()
      }
    } catch (error) {
      fail(error)
      complete()
    }
  }

  private _settlePendingSend(pending: PendingSend, outcome: TransportSendCompletion): void {
    if (!this._completionSends.delete(pending)) return
    pending.settle?.(outcome)
    this._finishPendingClose()
  }

  private _finishPendingClose(): void {
    if (!this._pendingCloseFrame || this._closed || this._completionSends.size > 0) return
    const frame = this._pendingCloseFrame
    this._pendingCloseFrame = null
    this._closed = true
    this._settlePendingSends('closed')
    this._socket.end(frame)
  }

  private _settlePendingSends(outcome: TransportSendCompletion): void {
    this._pendingSends.length = 0
    for (const pending of this._completionSends) {
      if (!pending.submitted) this._settlePendingSend(pending, outcome)
    }
  }

  /** 当前连接持续处于写背压且对端未消费的毫秒数（正常时为 0） */
  get stalledForMs(): number {
    if (this._backpressuredSince === null) return 0
    return Date.now() - this._backpressuredSince
  }

  get bufferedBytes(): number {
    return this._socket.writableLength
  }

  get closed(): boolean {
    return this._closed
  }

  pauseReading(): void {
    if (this._closed || this._readPaused) return
    this._readPaused = true
    this._socket.pause()
  }

  resumeReading(): void {
    if (this._closed || !this._readPaused) return
    this._readPaused = false
    this._socket.resume()
  }

  get remoteAddress(): string | undefined {
    return this._socket.remoteAddress
  }

  get label(): string {
    return `${this._socket.remoteAddress ?? '?'}:${this._socket.remotePort ?? '?'}`
  }

  close(): void {
    if (this._closed) return
    this._closed = true
    this._readPaused = false
    this._closing = true
    this._settlePendingSends('closed')
    this._backpressuredSince = null
    this._socket.off('drain', this._onDrain)
    this._socket.destroy()
  }

  dispose(): void {
    this._messageHandler = null
    this._socket.off('data', this._onData)
    this._socket.off('drain', this._onDrain)
    this._socket.off('error', this._onError)
    this._socket.off('close', this._onClose)
  }

  private _handleData(data: Buffer): void {
    if (this._closed) return

    this._onTraffic?.({ direction: 'received', bytes: data.length, timestamp: Date.now() })
    this._log.debug('received %d bytes from socket', data.length)

    // 拷贝底层的 socket Buffer 并串行解码，避免异步解码期间破坏接收游标和混淆流状态
    this._pendingSocketData.push(new Uint8Array(data))
    this._scheduleDecode()
  }

  private _scheduleDecode(): void {
    if (this._decoding || this._closed) return
    this._decoding = true
    this._drainSocketData().catch((error) => {
      this._log.error('transport decode failed: %s', error instanceof Error ? error.stack : error)
      this.close()
    }).finally(() => {
      this._decoding = false
      if (this._pendingSocketData.length > 0) this._scheduleDecode()
    })
  }

  private async _drainSocketData(): Promise<void> {
    while (!this._closed && this._pendingSocketData.length > 0) {
      for (const chunk of this._pendingSocketData.splice(0)) {
        const writeView = this._recvBuffer.writeSync(chunk.length)
        writeView.set(chunk)
        this._recvBuffer.disposeWriteSync(chunk.length)
      }

      if (!this._codec && !this._detectTransport()) continue

      this._log.debug('recv buffer available for decode: %d bytes', this._recvBuffer.available)

      for (;;) {
        const frame = await this._codec!.decode(this._recvBuffer, false)
        if (frame === null) {
          this._log.debug('decode returned null (incomplete data), available: %d', this._recvBuffer.available)
          break
        }

        this._log.debug('decoded frame: %d bytes', frame.length)
        // 向下游异步管线传递独立拷贝，防止后续 reclaim 覆盖还未消费的数据
        this._messageHandler?.(new Uint8Array(frame))
      }

      this._recvBuffer = reclaimReceiveBuffer(this._recvBuffer, 65536)
    }
  }

  private _detectTransport(): boolean {
    const avail = this._recvBuffer.available
    if (avail < 1) return false

    const firstByte = this._recvBuffer.readSync(1)[0]
    this._recvBuffer.rewind(1)
    if (firstByte === 0xef) {
      this._recvBuffer.readSync(1)
      this._codec = new AbridgedPacketCodec()
      this._log.debug('transport detected: abridged (plaintext)')
      return true
    }

    if (avail < 4) return false
    const tag = this._recvBuffer.readSync(4)
    const isAll = (v: number) => tag[0] === v && tag[1] === v && tag[2] === v && tag[3] === v
    const intermediate = isAll(0xee)
    const padded = isAll(0xdd)
    this._recvBuffer.rewind(4)

    if (intermediate) {
      this._recvBuffer.readSync(4)
      this._codec = new IntermediatePacketCodec()
      this._log.debug('transport detected: intermediate (plaintext)')
      return true
    }
    if (padded) {
      this._recvBuffer.readSync(4)
      const codec = new PaddedIntermediatePacketCodec()
      codec.setup?.(this._crypto)
      this._codec = codec
      this._log.debug('transport detected: padded-intermediate (plaintext)')
      return true
    }

    if (avail < 64) return false
    const header = new Uint8Array(this._recvBuffer.readSync(64))
    const { codec, innerTag } = createServerObfuscation(header, this._crypto, this._log)
    this._codec = codec
    this._log.debug('transport detected: obfuscated (inner tag %h)', innerTag)
    return true
  }
}
