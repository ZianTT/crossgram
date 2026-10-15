import { randomUUID } from 'node:crypto'
import { Service, type Context } from 'cordis'
import type {
  IMConversation, IMEvent, IMMediaUploadPreparation, IMMediaUploadProbe, IMMessage, IMMessageInput,
  PlatformSession, Unsubscribe,
} from './platform.js'
import type { PlatformEventDeliveryOptions, PlatformEventPublishResult } from './platform-manager.js'

export interface SystemPeer {
  id: string
  conversation: IMConversation
}

import type { SystemBot } from './dashboard-types.js'
export type { SystemBot } from './dashboard-types.js'

export interface SystemPeerResolution {
  peer: SystemPeer
  readonly provider: SystemPeerProvider
}

export interface SystemPeerCallbackInput {
  message: IMMessage
  data: string
}

export interface SystemPeerCallbackResult {
  alert?: boolean
  message?: string
  url?: string
  cacheTime?: number
}

export interface SystemPeerProvider {
  bootstrap(session: PlatformSession, peers: SystemPeerService): Promise<void>
  resolve(session: PlatformSession, conversationId: string): Promise<SystemPeer | undefined>
  /** 用户发出的消息完成落库后调用。 */
  receive?(
    session: PlatformSession,
    peer: SystemPeer,
    message: IMMessage,
    peers: SystemPeerService,
    input?: IMMessageInput,
  ): Promise<void>
  /** 允许本地会话直接消费 Telegram 上传分片，无需经过平台暂存。 */
  prepareMediaUpload?(
    session: PlatformSession,
    peer: SystemPeer,
    media: IMMediaUploadProbe,
    peers: SystemPeerService,
  ): Promise<IMMediaUploadPreparation | undefined>
  callback?(
    session: PlatformSession,
    peer: SystemPeer,
    input: SystemPeerCallbackInput,
    peers: SystemPeerService,
  ): Promise<SystemPeerCallbackResult | undefined>
  listBots?(): Promise<readonly SystemBot[]> | readonly SystemBot[]
}

export class SystemPeerCallbackError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

/** 管理 bridge 自有的本地私聊会话（如系统机器人、请求收件箱）。 */
export class SystemPeerService extends Service {
  private readonly _providers = new Set<SystemPeerProvider>()
  private readonly _listeners = new Set<() => void>()
  private _ingest?: (
    session: PlatformSession,
    event: IMEvent,
    options?: PlatformEventDeliveryOptions,
  ) => Promise<PlatformEventPublishResult>

  constructor(ctx: Context) {
    super(ctx, 'systemPeer')
  }

  attach(
    ingest: (session: PlatformSession, event: IMEvent, options?: PlatformEventDeliveryOptions) => Promise<PlatformEventPublishResult>,
  ): void {
    this._ingest = ingest
  }

  register(provider: SystemPeerProvider): Unsubscribe {
    return this.ctx.effect(() => {
      this._providers.add(provider)
      this._changed()
      for (const binding of this.ctx.get('imPlatform')?.sessions ?? []) {
        void provider.bootstrap(binding.session, this).catch((error) => {
          this.ctx.logger('system-peer').warn('system peer bootstrap failed: %s', String(error))
        })
      }
      return () => {
        if (!this._providers.delete(provider)) return
        this._changed()
      }
    }, 'systemPeer.register')
  }

  async listBots(): Promise<SystemBot[]> {
    const listed = await Promise.all([...this._providers].map(async (provider) =>
      provider.listBots ? await provider.listBots() : []))
    const byUsername = new Map<string, SystemBot>()
    for (const bot of listed.flat()) {
      const username = normalizeUsername(bot.username)
      if (!username) continue
      const previous = byUsername.get(username)
      if (previous && previous.conversationId !== bot.conversationId) {
        this.ctx.logger('system-peer').warn(
          'duplicate system bot username @%s from %s and %s; keeping the first registration',
          bot.username, previous.sourcePlugin, bot.sourcePlugin,
        )
        continue
      }
      byUsername.set(username, { ...bot, username: bot.username.replace(/^@/u, '') })
    }
    return [...byUsername.values()].sort((left, right) =>
      left.username.localeCompare(right.username, 'en-US', { sensitivity: 'base' }))
  }

  async resolveUsername(session: PlatformSession, username: string): Promise<SystemPeerResolution | undefined> {
    const normalized = normalizeUsername(username)
    if (!normalized) return
    for (const provider of this._providers) {
      if (!provider.listBots) continue
      const bot = (await provider.listBots()).find((candidate) => normalizeUsername(candidate.username) === normalized)
      if (!bot) continue
      const peer = await provider.resolve(session, bot.conversationId)
      if (peer) return { peer, provider }
    }
  }

  onChanged(listener: () => void): Unsubscribe {
    return this.ctx.effect(() => {
      this._listeners.add(listener)
      return () => { this._listeners.delete(listener) }
    }, 'systemPeer.onChanged')
  }

  notifyChanged(): void {
    this._changed()
  }

  async bootstrap(session: PlatformSession): Promise<void> {
    for (const provider of this._providers) {
      try {
        await provider.bootstrap(session, this)
      } catch (error) {
        this.ctx.logger('system-peer').warn('system peer bootstrap failed: %s', String(error))
      }
    }
  }

  async resolve(session: PlatformSession, conversationId: string): Promise<SystemPeerResolution | undefined> {
    for (const provider of this._providers) {
      const peer = await provider.resolve(session, conversationId)
      if (peer) return { peer, provider }
    }
  }

  async receive(
    session: PlatformSession,
    resolution: SystemPeerResolution,
    message: IMMessage,
    input?: IMMessageInput,
  ): Promise<void> {
    await resolution.provider.receive?.(session, resolution.peer, message, this, input)
  }

  async prepareMediaUpload(
    session: PlatformSession,
    resolution: SystemPeerResolution,
    media: IMMediaUploadProbe,
  ): Promise<IMMediaUploadPreparation | undefined> {
    return resolution.provider.prepareMediaUpload?.(session, resolution.peer, media, this)
  }

  async callback(
    session: PlatformSession,
    resolution: SystemPeerResolution,
    input: SystemPeerCallbackInput,
  ): Promise<SystemPeerCallbackResult | undefined> {
    return resolution.provider.callback?.(session, resolution.peer, input, this)
  }

  makeOutgoing(session: PlatformSession, resolution: SystemPeerResolution, content: IMMessageInput): IMMessage {
    return {
      id: `bridge:outgoing:${randomUUID()}`,
      conversationId: resolution.peer.id,
      senderId: session.userId,
      content: {
        parts: content.parts.map((part) => part.type === 'media'
          ? {
            type: 'media' as const,
            media: {
              ...part.media,
              id: `bridge:system-peer-media:${randomUUID()}`,
              // 复用已有平台媒体时顶层无 locator，从 origin 中提取以确保落库后仍可下载。
              ...((part.media.origin?.locator) !== undefined
                ? { locator: part.media.origin.locator }
                : {}),
            },
          }
          : part) as IMMessage['content']['parts'],
      },
      timestamp: Math.floor(Date.now() / 1_000),
      outgoing: true,
      replyToId: content.replyToId,
    }
  }

  async emit(session: PlatformSession, event: IMEvent, options?: PlatformEventDeliveryOptions): Promise<PlatformEventPublishResult> {
    if (!this._ingest) throw new Error('system peer bridge is not attached')
    return this._ingest(session, event, options)
  }

  private _changed(): void {
    for (const listener of [...this._listeners]) {
      try { listener() } catch (error) {
        this.ctx.logger('system-peer').warn('system peer change listener failed: %s', String(error))
      }
    }
  }
}

function normalizeUsername(username: string): string | undefined {
  const normalized = username.trim().replace(/^@/u, '').toLocaleLowerCase('en-US')
  return /^[a-z][a-z0-9_]{4,31}$/u.test(normalized) ? normalized : undefined
}
