import { Service, type Context } from 'cordis'
import type {
  IMConversation, IMMedia, IMMediaInput, IMMessage, IMPlatform, PlatformSession,
} from './platform.js'

export interface SpeechTranscriptionInput<TMediaLocator = unknown> {
  platform: IMPlatform<TMediaLocator>
  session: PlatformSession
  conversation?: IMConversation<TMediaLocator>
  message?: IMMessage<TMediaLocator>
  media: IMMedia<TMediaLocator>
  /** BCP-47 语言提示（如 `zh-CN`、`en-US`）。 */
  language?: string
  /** 是否为收消息时自动触发的转写请求。 */
  automatic?: boolean
  signal?: AbortSignal
}

export interface SpeechTranscriptionResult {
  text: string
  language?: string
  confidence?: number
  provider?: string
}

export interface SpeechTranscriptEvent<TMediaLocator = unknown> {
  platform: IMPlatform<TMediaLocator>
  session: PlatformSession
  conversation: IMConversation<TMediaLocator>
  messageId: string
  text: string
  provider?: string
  timestamp: number
}

export interface SpeechSynthesisInput<TMediaLocator = unknown> {
  platform: IMPlatform<TMediaLocator>
  session: PlatformSession
  conversation?: IMConversation<TMediaLocator>
  text: string
  language?: string
  voice?: string
  signal?: AbortSignal
}

export interface SpeechSynthesisResult {
  media: IMMediaInput
  provider?: string
}

export class SpeechPipeline extends Service {
  constructor(ctx: Context) {
    super(ctx, 'speech')
  }

  transcribe<TMediaLocator = unknown>(
    input: SpeechTranscriptionInput<TMediaLocator>,
    fallback: () => SpeechTranscriptionResult | undefined | Promise<SpeechTranscriptionResult | undefined> = () => undefined,
  ): Promise<SpeechTranscriptionResult | undefined> {
    return Promise.resolve(this.ctx.waterfall(
      this.ctx,
      'bridge/speech/transcribe',
      input,
      fallback,
    ))
  }

  synthesize<TMediaLocator = unknown>(
    input: SpeechSynthesisInput<TMediaLocator>,
    fallback: () => SpeechSynthesisResult | undefined | Promise<SpeechSynthesisResult | undefined> = () => undefined,
  ): Promise<SpeechSynthesisResult | undefined> {
    return Promise.resolve(this.ctx.waterfall(
      this.ctx,
      'bridge/speech/synthesize',
      input,
      fallback,
    ))
  }
}
