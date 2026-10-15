import type { PlatformSession } from '../platform.js'
import type { VoiceWorkerCall } from './call-registry.js'

/** 20ms、48kHz、单声道 s16le PCM 音频帧。 */
export interface VoicePcmFrame {
  readonly format: {
    readonly encoding: 's16le'
    readonly sampleRate: 48_000
    readonly channels: 1
    readonly durationMs: 20
    readonly samplesPerFrame: 960
    readonly bytesPerFrame: 1_920
  }
  readonly data: Uint8Array
}

export interface VoiceMediaSession {
  send(frame: VoicePcmFrame, options?: { signal?: AbortSignal }): void
  receive(options?: { signal?: AbortSignal }): Promise<VoicePcmFrame>
  close(): Promise<void>
  readonly finished: Promise<void>
}

export interface VoiceWorkerMediaEndpoint {
  send(frame: VoicePcmFrame, options: { signal: AbortSignal }): Promise<void>
  receive(options: { signal: AbortSignal }): AsyncIterable<VoicePcmFrame>
  close(): Promise<void> | void
}

export interface VoiceCallMediaProvider {
  start(
    call: VoiceWorkerCall,
    session: PlatformSession,
    endpoint: VoiceWorkerMediaEndpoint,
  ): Promise<VoiceMediaSession>
}

/** 双向桥接 worker PCM 端点与平台音频会话，任一侧结束时自动关闭双端。 */
export class VoiceMediaAttachment {
  private readonly controller = new AbortController()
  private readonly completed = Promise.withResolvers<void>()
  private readonly loops: Promise<void>[]
  private closing?: Promise<void>
  private terminalReported = false

  constructor(
    private readonly media: VoiceMediaSession,
    private readonly worker: VoiceWorkerMediaEndpoint,
    private readonly onTerminal?: (phase: VoiceMediaTerminalPhase, code: string) => void,
  ) {
    this.loops = [this.copyWorkerToMedia(), this.copyMediaToWorker()]
    void media.finished.then(
      () => { this.reportTerminal('platform-finished', 'CLOSED'); return this.close() },
      (error) => { this.reportTerminal('platform-finished', terminalCode(error)); return this.close() },
    )
  }

  get finished(): Promise<void> {
    return this.completed.promise
  }

  close(): Promise<void> {
    return this.closing ??= this.closeImpl()
  }

  private async copyWorkerToMedia(): Promise<void> {
    try {
      for await (const frame of this.worker.receive({ signal: this.controller.signal })) {
        if (this.controller.signal.aborted) return
        this.media.send(copyFrame(frame), { signal: this.controller.signal })
      }
    } catch (error) {
      if (!this.controller.signal.aborted) this.reportTerminal('worker-receive', terminalCode(error))
    } finally {
      void this.close()
    }
  }

  private async copyMediaToWorker(): Promise<void> {
    try {
      while (!this.controller.signal.aborted) {
        const frame = await this.media.receive({ signal: this.controller.signal })
        await abortable(this.worker.send(copyFrame(frame), { signal: this.controller.signal }), this.controller.signal)
      }
    } catch (error) {
      if (!this.controller.signal.aborted) this.reportTerminal('worker-send', terminalCode(error))
    } finally {
      void this.close()
    }
  }

  private async closeImpl(): Promise<void> {
    this.controller.abort()
    await Promise.allSettled([this.media.close(), this.worker.close()])
    await Promise.allSettled(this.loops)
    this.completed.resolve()
  }

  private reportTerminal(phase: VoiceMediaTerminalPhase, code: string): void {
    if (this.terminalReported) return
    this.terminalReported = true
    try {
      this.onTerminal?.(phase, code)
    } catch {
    }
  }
}

export type VoiceMediaTerminalPhase = 'platform-finished' | 'worker-receive' | 'worker-send'

function terminalCode(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'UNKNOWN'
}

function copyFrame(frame: VoicePcmFrame): VoicePcmFrame {
  return { format: frame.format, data: new Uint8Array(frame.data) }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
