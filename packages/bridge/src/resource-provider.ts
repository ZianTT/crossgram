import { Service, type Context } from 'cordis'
import type { tl } from '@mtcute/core'
import type Long from 'long'
import type { Unsubscribe } from './platform.js'

export type TelegramStickerResourceKind =
  | 'emoji'
  | 'emoji_animations'
  | 'emoji_generic'

export interface TelegramResourceFile {
  bytes: Uint8Array
  mimeType: string
}

/** Telegram 客户端系统资源（默认表情、动画、特效等），按注册顺序由首个非空返回值的 provider 处理。 */
export interface TelegramResourceProvider {
  getAvailableReactions?():
    | tl.messages.RawAvailableReactions
    | Promise<tl.messages.RawAvailableReactions | undefined>
    | undefined
  getAvailableEffects?():
    | tl.messages.RawAvailableEffects
    | Promise<tl.messages.RawAvailableEffects | undefined>
    | undefined
  getStickerSet?(kind: TelegramStickerResourceKind):
    | tl.messages.RawStickerSet
    | Promise<tl.messages.RawStickerSet | undefined>
    | undefined
  getFile?(documentId: Long):
    | TelegramResourceFile
    | Promise<TelegramResourceFile | undefined>
    | undefined
}

export class TelegramResourceRegistry {
  private readonly _providers = new Map<string, TelegramResourceProvider>()

  register(id: string, provider: TelegramResourceProvider): Unsubscribe {
    if (this._providers.has(id)) throw new Error(`duplicate Telegram resource provider ID: ${id}`)
    this._providers.set(id, provider)
    return () => {
      if (this._providers.get(id) === provider) this._providers.delete(id)
    }
  }

  get(id: string): TelegramResourceProvider | undefined {
    return this._providers.get(id)
  }

  get entries(): Array<[string, TelegramResourceProvider]> {
    return [...this._providers.entries()]
  }
}

export class TelegramResourceService extends Service {
  readonly registry = new TelegramResourceRegistry()

  constructor(ctx: Context) {
    super(ctx, 'telegramResource')
  }

  register(provider: TelegramResourceProvider, id: string): Unsubscribe {
    return this.ctx.effect(
      () => this.registry.register(id, provider),
      `telegramResource.register(${id})`,
    )
  }

  get(id: string): TelegramResourceProvider | undefined {
    return this.registry.get(id)
  }

  async availableReactions(): Promise<tl.messages.RawAvailableReactions> {
    for (const [, provider] of this.registry.entries) {
      const result = await provider.getAvailableReactions?.()
      if (result) return result
    }
    return { _: 'messages.availableReactions', hash: 0, reactions: [] }
  }

  async availableEffects(): Promise<tl.messages.RawAvailableEffects> {
    for (const [, provider] of this.registry.entries) {
      const result = await provider.getAvailableEffects?.()
      if (result) return result
    }
    return { _: 'messages.availableEffects', hash: 0, effects: [], documents: [] }
  }

  async stickerSet(
    kind: TelegramStickerResourceKind,
  ): Promise<tl.messages.RawStickerSet | undefined> {
    for (const [, provider] of this.registry.entries) {
      const result = await provider.getStickerSet?.(kind)
      if (result) return result
    }
  }

  async getFile(documentId: Long): Promise<TelegramResourceFile | undefined> {
    for (const [, provider] of this.registry.entries) {
      const result = await provider.getFile?.(documentId)
      if (result) return result
    }
  }
}
