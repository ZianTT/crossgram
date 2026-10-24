import { Context, Service } from 'cordis'

const PCM_ENCODING = 's16le'
const PCM_SAMPLE_RATE = 48_000
const PCM_CHANNELS = 1
const PCM_DURATION_MS = 20
const PCM_SAMPLES_PER_FRAME = 960
const PCM_BYTES_PER_FRAME = 1_920

/** 单帧 20 ms、48 kHz、单声道 s16le PCM。 */
export const QQ_VOICE_PCM_FORMAT = Object.freeze({
  encoding: PCM_ENCODING,
  sampleRate: PCM_SAMPLE_RATE,
  channels: PCM_CHANNELS,
  durationMs: PCM_DURATION_MS,
  samplesPerFrame: PCM_SAMPLES_PER_FRAME,
  bytesPerFrame: PCM_BYTES_PER_FRAME,
})

/** 实时音频优先低延迟，队列满时丢弃最旧帧而非阻塞采集。 */
export const QQ_VOICE_PCM_QUEUE_CAPACITY = 4

const MAX_SESSION_ID_LENGTH = 128
const MAX_TOKEN_BYTES = 4_096
const DEFAULT_CLOSE_TIMEOUT_MS = 1_000

export interface QQVoicePcmFrame {
  format: typeof QQ_VOICE_PCM_FORMAT
  data: Uint8Array
}

/** 单次媒体连接的内存上下文；入口处会拷贝 `token` 并将调用方传入的缓冲区清零。 */
export interface QQVoiceMediaSessionContext {
  callId: string
  leaseId: string
  token: Uint8Array
}

/** `token` 所有权移交给当次 `connect()` 调用，实现方必须在 Promise 结束前消费并清零。 */
export interface QQVoiceMediaConnectOptions extends QQVoiceMediaSessionContext {
  signal: AbortSignal
}

export interface QQVoiceMediaTransport {
  connect(options: QQVoiceMediaConnectOptions): Promise<QQVoiceMediaConnection>
}

export interface QQVoiceMediaConnection {
  send(frame: QQVoicePcmFrame, options: { signal: AbortSignal }): Promise<void>
  receive(options: { signal: AbortSignal }): AsyncIterable<QQVoicePcmFrame>
  close(): Promise<void>
  destroy(): Promise<void> | void
}

export class QQVoiceMediaClient implements QQVoiceMediaTransport {
  constructor(private readonly connector: QQVoiceMediaTransport['connect']) {}

  connect(options: QQVoiceMediaConnectOptions): Promise<QQVoiceMediaConnection> {
    return this.connector(options)
  }
}

export interface QQVoiceMediaOperationOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface QQVoiceMediaStartOptions extends QQVoiceMediaOperationOptions, QQVoiceMediaSessionContext {}

export interface QQVoiceMediaStats {
  outgoingDroppedFrames: number
  incomingDroppedFrames: number
}

export class QQVoiceMediaTimeoutError extends Error {
  constructor(operation: 'connect' | 'receive' | 'close') {
    super(`QQ voice media ${operation} timed out`)
    this.name = 'QQVoiceMediaTimeoutError'
  }
}

export class QQVoiceMediaClosedError extends Error {
  constructor() {
    super('QQ voice media session is closed')
    this.name = 'QQVoiceMediaClosedError'
  }
}

export class QQVoiceMediaTransportError extends Error {
  constructor() {
    super('QQ voice media transport failed')
    this.name = 'QQVoiceMediaTransportError'
  }
}

interface PendingStart {
  readonly generation: number
  readonly controller: AbortController
  readonly token: Uint8Array
  connect?: Promise<QQVoiceMediaConnection>
  cancelled: boolean
  destroying: boolean
}

/** 双向 PCM 会话；上下行各自最多缓存 4 帧，溢出时丢弃最旧帧以避免阻塞生产端。 */
export class QQVoiceMediaSession {
  private readonly controller = new AbortController()
  private readonly outgoing = new DroppingQueue<QQVoicePcmFrame>(QQ_VOICE_PCM_QUEUE_CAPACITY)
  private readonly incoming = new DroppingQueue<QQVoicePcmFrame>(QQ_VOICE_PCM_QUEUE_CAPACITY)
  private readonly loops: Promise<void>[]
  private closePromise?: Promise<void>
  private terminalizing?: Promise<void>
  private readonly closedResult = Promise.withResolvers<void>()
  private failure?: QQVoiceMediaTransportError
  private readonly counts: QQVoiceMediaStats = {
    outgoingDroppedFrames: 0,
    incomingDroppedFrames: 0,
  }

  constructor(private readonly connection: QQVoiceMediaConnection) {
    this.loops = [this.sendLoop(), this.receiveLoop()]
  }

  get closed(): boolean {
    return this.controller.signal.aborted
  }

  get stats(): QQVoiceMediaStats {
    return { ...this.counts }
  }

  get finished(): Promise<void> {
    return this.closedResult.promise
  }

  /** 同步校验并入队，不等待底层传输 I/O。 */
  send(frame: QQVoicePcmFrame, options: Pick<QQVoiceMediaOperationOptions, 'signal'> = {}): void {
    assertPcmFrame(frame)
    if (options.signal?.aborted) throw options.signal.reason ?? new QQVoiceMediaClosedError()
    if (this.controller.signal.aborted) throw this.controller.signal.reason ?? new QQVoiceMediaClosedError()
    // 拷贝一份，便于调用方复用采集缓冲区。
    if (this.outgoing.push({ format: QQ_VOICE_PCM_FORMAT, data: new Uint8Array(frame.data) })) {
      this.counts.outgoingDroppedFrames++
    }
  }

  receive(options: QQVoiceMediaOperationOptions = {}): Promise<QQVoicePcmFrame> {
    const scope = operationScope(options, this.controller.signal, 'receive')
    return this.incoming.next(scope.signal).finally(scope.dispose)
  }

  close(): Promise<void> {
    return this.closePromise ??= this.closeImpl()
  }

  private async sendLoop(): Promise<void> {
    try {
      while (true) {
        const frame = await this.outgoing.next(this.controller.signal)
        await abortable(this.connection.send(frame, { signal: this.controller.signal }), this.controller.signal)
      }
    } catch (error) {
      if (!this.controller.signal.aborted) this.fail(error)
    }
  }

  private async receiveLoop(): Promise<void> {
    try {
      for await (const frame of this.connection.receive({ signal: this.controller.signal })) {
        if (this.controller.signal.aborted) return
        assertPcmFrame(frame)
        // 入队前拷贝，防止底层传输层复用接收缓冲区。
        if (this.incoming.push({ format: QQ_VOICE_PCM_FORMAT, data: new Uint8Array(frame.data) })) {
          this.counts.incomingDroppedFrames++
        }
      }
      if (!this.controller.signal.aborted) this.fail(new QQVoiceMediaClosedError())
    } catch (error) {
      if (!this.controller.signal.aborted) this.fail(error)
    }
  }

  private fail(_error: unknown): void {
    this.failure = new QQVoiceMediaTransportError()
    void this.close().catch(() => undefined)
  }

  private async closeImpl(): Promise<void> {
    const reason = this.failure ?? new QQVoiceMediaClosedError()
    this.controller.abort(reason)
    this.outgoing.close(reason)
    this.incoming.close(reason)
    const terminalizing = this.terminalizing ??= this.terminateConnection()
    await settleAtMost(Promise.allSettled(this.loops), DEFAULT_CLOSE_TIMEOUT_MS)
    const result = await settleAtMost(terminalizing, DEFAULT_CLOSE_TIMEOUT_MS)
    if (result.status === 'timed-out') throw new QQVoiceMediaTimeoutError('close')
    if (result.status === 'rejected') throw result.reason
  }

  private async terminateConnection(): Promise<void> {
    const gracefulClose = invoke(this.connection.close.bind(this.connection))
    void gracefulClose.then(() => this.closedResult.resolve(), () => undefined)
    const closeResult = await settleAtMost(gracefulClose, DEFAULT_CLOSE_TIMEOUT_MS)
    if (closeResult.status === 'fulfilled') {
      this.closedResult.resolve()
      return
    }

    const destroy = invoke(this.connection.destroy.bind(this.connection))
    void destroy.then(() => this.closedResult.resolve(), () => undefined)
    const destroyResult = await settleAtMost(destroy, DEFAULT_CLOSE_TIMEOUT_MS)
    if (destroyResult.status === 'timed-out') throw new QQVoiceMediaTimeoutError('close')
    if (destroyResult.status === 'rejected') throw new QQVoiceMediaTransportError()

    this.closedResult.resolve()
    if (closeResult.status === 'timed-out') throw new QQVoiceMediaTimeoutError('close')
    throw new QQVoiceMediaTransportError()
  }
}

export class QQVoiceMedia extends Service {
  private active?: QQVoiceMediaSession
  private starting?: PendingStart
  private closing?: Promise<void>
  private generation = 0

  constructor(ctx: Context) {
    super(ctx, 'qqntVoiceMedia')
  }

  get session(): QQVoiceMediaSession | undefined {
    return this.active
  }

  async start(
    transport: QQVoiceMediaTransport,
    options: QQVoiceMediaStartOptions,
  ): Promise<QQVoiceMediaSession> {
    if (this.starting || this.active || this.closing) {
      throw new QQVoiceMediaClosedError()
    }
    validateSessionId(options.callId)
    validateSessionId(options.leaseId)
    if (options.timeoutMs !== undefined) validateTimeout(options.timeoutMs, 'connect')
    const token = copySessionToken(options.token)
    options.token.fill(0)
    const pending: PendingStart = {
      generation: ++this.generation,
      controller: new AbortController(),
      token,
      cancelled: false,
      destroying: false,
    }
    this.starting = pending
    const scope = operationScope(options, pending.controller.signal, 'connect')
    try {
      pending.connect = invoke(() => transport.connect({
        signal: scope.signal,
        callId: options.callId,
        leaseId: options.leaseId,
        token,
      }))
      void pending.connect.then(
        (connection) => {
          if (pending.cancelled || this.starting !== pending || pending.generation !== this.generation) {
            this.destroyLateConnection(connection, pending)
          }
        },
        () => this.releasePending(pending),
      )
      const connection = await abortable(pending.connect, scope.signal)
      if (scope.signal.aborted || this.starting !== pending || pending.generation !== this.generation) {
        this.cancelPending(pending)
        throw scope.signal.reason ?? new QQVoiceMediaClosedError()
      }
      const session = new QQVoiceMediaSession(connection)
      this.active = session
      this.releasePending(pending)
      void session.finished.then(() => {
        if (this.active === session) this.active = undefined
      })
      return session
    } catch (error) {
      if (scope.signal.aborted) {
        this.cancelPending(pending)
        throw scope.signal.reason ?? new QQVoiceMediaClosedError()
      }
      this.releasePending(pending)
      throw new QQVoiceMediaTransportError()
    } finally {
      token.fill(0)
      scope.dispose()
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    const closing = this.closeImpl()
    this.closing = closing
    void closing.finally(() => {
      if (this.closing === closing) this.closing = undefined
    }).catch(() => undefined)
    return closing
  }

  private async closeImpl(): Promise<void> {
    if (this.starting) this.cancelPending(this.starting)
    const active = this.active
    this.active = undefined
    await active?.close()
  }

  private releasePending(pending: PendingStart): void {
    if (this.starting === pending) this.starting = undefined
  }

  private cancelPending(pending: PendingStart): void {
    pending.cancelled = true
    pending.token.fill(0)
    pending.controller.abort(new QQVoiceMediaClosedError())
    this.releasePending(pending)
  }

  private destroyLateConnection(connection: QQVoiceMediaConnection, pending: PendingStart): void {
    if (pending.destroying) return
    pending.destroying = true
    void invoke(connection.destroy.bind(connection)).catch(() => undefined)
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    yield () => this.close()
  }
}

function assertPcmFrame(frame: QQVoicePcmFrame): void {
  const format = frame.format
  if (!format || format.encoding !== PCM_ENCODING
    || format.sampleRate !== PCM_SAMPLE_RATE
    || format.channels !== PCM_CHANNELS
    || format.durationMs !== PCM_DURATION_MS
    || format.samplesPerFrame !== PCM_SAMPLES_PER_FRAME
    || format.bytesPerFrame !== PCM_BYTES_PER_FRAME
    || !(frame.data instanceof Uint8Array)
    || frame.data.byteLength !== PCM_BYTES_PER_FRAME) {
    throw new Error('QQ voice media requires 48 kHz mono s16le PCM frames of exactly 1,920 bytes')
  }
}

function copySessionToken(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > MAX_TOKEN_BYTES) {
    throw new RangeError('QQ voice media token is invalid')
  }
  return new Uint8Array(value)
}

function validateSessionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_SESSION_ID_LENGTH) {
    throw new RangeError('QQ voice media session context is invalid')
  }
}

function operationScope(
  options: QQVoiceMediaOperationOptions,
  parent: AbortSignal | undefined,
  operation: 'connect' | 'receive',
): { signal: AbortSignal, dispose(): void } {
  const controller = new AbortController()
  const abort = () => controller.abort(parent?.reason ?? options.signal?.reason ?? new QQVoiceMediaClosedError())
  parent?.addEventListener('abort', abort, { once: true })
  options.signal?.addEventListener('abort', abort, { once: true })
  if (parent?.aborted || options.signal?.aborted) abort()
  const timeout = options.timeoutMs === undefined ? undefined : validateTimeout(options.timeoutMs, operation)
  const timer = timeout === undefined ? undefined : setTimeout(
    () => controller.abort(new QQVoiceMediaTimeoutError(operation)), timeout,
  )
  timer?.unref()
  return {
    signal: controller.signal,
    dispose() {
      if (timer) clearTimeout(timer)
      parent?.removeEventListener('abort', abort)
      options.signal?.removeEventListener('abort', abort)
    },
  }
}

function validateTimeout(value: number, operation: 'connect' | 'receive'): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`QQ voice media ${operation} timeout must be non-negative`)
  return Math.trunc(value)
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new QQVoiceMediaClosedError())
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new QQVoiceMediaClosedError())
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

type Settled<T> =
  | { status: 'fulfilled', value: T }
  | { status: 'rejected', reason: unknown }
  | { status: 'timed-out' }

async function settleAtMost<T>(promise: Promise<T>, timeoutMs: number): Promise<Settled<T>> {
  let timer: NodeJS.Timeout | undefined
  const result = await Promise.race<Settled<T>>([
    promise.then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ status: 'rejected', reason }),
    ),
    new Promise<Settled<T>>((resolve) => {
      timer = setTimeout(() => resolve({ status: 'timed-out' }), timeoutMs)
      timer.unref()
    }),
  ])
  if (timer) clearTimeout(timer)
  return result
}

function invoke<T>(operation: () => T | Promise<T>): Promise<T> {
  return Promise.resolve().then(operation)
}

class DroppingQueue<T> {
  private readonly values: T[] = []
  private readonly readers: Array<{ resolve(value: T): void, reject(error: unknown): void }> = []
  private error?: unknown

  constructor(private readonly capacity: number) {}

  /** 淘汰了最旧元素时返回 `true`。 */
  push(value: T): boolean {
    if (this.error) throw this.error
    const reader = this.readers.shift()
    if (reader) {
      reader.resolve(value)
      return false
    }
    const dropped = this.values.length === this.capacity
    if (dropped) this.values.shift()
    this.values.push(value)
    return dropped
  }

  next(signal: AbortSignal): Promise<T> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve(value)
    if (this.error) return Promise.reject(this.error)
    if (signal.aborted) return Promise.reject(signal.reason ?? new QQVoiceMediaClosedError())
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        this.remove(this.readers, entry)
        reject(signal.reason ?? new QQVoiceMediaClosedError())
      }
      const entry = {
        resolve: (value: T) => { signal.removeEventListener('abort', abort); resolve(value) },
        reject: (error: unknown) => { signal.removeEventListener('abort', abort); reject(error) },
      }
      signal.addEventListener('abort', abort, { once: true })
      this.readers.push(entry)
    })
  }

  close(error: unknown): void {
    if (this.error) return
    this.error = error
    for (const reader of this.readers.splice(0)) reader.reject(error)
    this.values.length = 0
  }

  private remove(entries: unknown[], entry: unknown): void {
    const index = entries.indexOf(entry)
    if (index >= 0) entries.splice(index, 1)
  }
}
