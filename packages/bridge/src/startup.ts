import type { tl } from '@mtcute/core'
import Long from 'long'
import { bareVector } from '@mtproto-relay/mtproto'

type StartupHandler = (request?: unknown) => tl.TlObject

/** 客户端登录后批量拉取的可选资源；返回合法空 TL 对象，避免客户端对 `METHOD_NOT_IMPLEMENTED` 指数退避重试。 */
export const startupRpcHandlers: Readonly<Record<string, StartupHandler>> = {
  'help.getPeerColors': () => ({
    _: 'help.peerColors', hash: 0, colors: [],
  } as unknown as tl.TlObject),
  'help.getPeerProfileColors': () => ({
    _: 'help.peerColors', hash: 0, colors: [],
  } as unknown as tl.TlObject),
  'account.getDefaultEmojiStatuses': () => ({
    _: 'account.emojiStatuses', hash: Long.ZERO, statuses: [],
  } as unknown as tl.TlObject),
  'help.getPromoData': () => ({
    _: 'help.promoDataEmpty', expires: futureDate(),
  } as unknown as tl.TlObject),
  'help.getTermsOfServiceUpdate': () => ({
    _: 'help.termsOfServiceUpdateEmpty', expires: futureDate(),
  } as unknown as tl.TlObject),
  'messages.getEmojiGroups': () => ({
    _: 'messages.emojiGroups', hash: 0, groups: [],
  } as unknown as tl.TlObject),
  'messages.getEmojiStickerGroups': () => ({
    _: 'messages.emojiGroups', hash: 0, groups: [],
  } as unknown as tl.TlObject),
  'stories.getAllStories': () => ({
    _: 'stories.allStories', count: 0, state: '', peerStories: [], chats: [], users: [],
    stealthMode: { _: 'storiesStealthMode' },
  } as unknown as tl.TlObject),
  'messages.getFeaturedStickers': () => ({
    _: 'messages.featuredStickers', hash: Long.ZERO, count: 0, sets: [], unread: [],
  } as unknown as tl.TlObject),
  'messages.getFeaturedEmojiStickers': () => ({
    _: 'messages.featuredStickers', hash: Long.ZERO, count: 0, sets: [], unread: [],
  } as unknown as tl.TlObject),
  'messages.getSavedGifs': () => ({
    _: 'messages.savedGifs', hash: Long.ZERO, gifs: [],
  } as unknown as tl.TlObject),
  'help.getPremiumPromo': () => ({
    _: 'help.premiumPromo', statusText: '', statusEntities: [],
    videoSections: [], videos: [], periodOptions: [], users: [],
  } as unknown as tl.TlObject),
  'account.getReactionsNotifySettings': () => ({
    _: 'reactionsNotifySettings', sound: { _: 'notificationSoundDefault' }, showPreviews: true,
  } as unknown as tl.TlObject),
  'messages.getSavedReactionTags': () => ({
    _: 'messages.savedReactionTags', tags: [], hash: Long.ZERO,
  } as unknown as tl.TlObject),
  'payments.getStarGiftActiveAuctions': () => ({
    _: 'payments.starGiftActiveAuctions', auctions: [], users: [], chats: [],
  } as unknown as tl.TlObject),
  'stories.getStoriesArchive': () => ({
    _: 'stories.stories', count: 0, stories: [], chats: [], users: [],
  } as unknown as tl.TlObject),
  // 不注册 `langpack.*`（返回空语言包会覆盖客户端内置文案）和 `auth.initPasskeyLogin`（报错才能让 Web 端回退到扫码登录）。
  'help.getCountriesList': () => ({
    _: 'help.countriesList', hash: 0, countries: COUNTRIES,
  } as unknown as tl.TlObject),
  'account.getCollectibleEmojiStatuses': () => ({
    _: 'account.emojiStatuses', hash: Long.ZERO, statuses: [],
  } as unknown as tl.TlObject),
  'account.getContentSettings': () => ({
    _: 'account.contentSettings', flags: 0,
  } as unknown as tl.TlObject),
  'aicompose.getTones': () => ({
    _: 'aicompose.tones', hash: Long.ZERO, tones: [], users: [],
  } as unknown as tl.TlObject),
  'communities.getJoinedCommunities': () => ({
    _: 'messages.chats', chats: [],
  } as unknown as tl.TlObject),
  'messages.getPaidReactionPrivacy': () => ({
    _: 'updatesTooLong',
  } as unknown as tl.TlObject),
  'messages.getPinnedSavedDialogs': () => ({
    _: 'messages.savedDialogsNotModified', count: 0,
  } as unknown as tl.TlObject),
  'payments.getStarsStatus': () => ({
    _: 'payments.starsStatus', flags: 0, balance: { _: 'starsAmount', amount: Long.ZERO, nanos: 0 },
    chats: [], users: [],
  } as unknown as tl.TlObject),
  'payments.getStarsTopupOptions': () => bareVector([]) as unknown as tl.TlObject,
}

function futureDate(): number {
  return Math.floor(Date.now() / 1000) + 86400
}

/** 仅下发本服务分配的 `+888` 虚拟号段（见 `platform-account.ts` 的 `allocateVirtualPhone`）。 */
const COUNTRIES: readonly tl.TlObject[] = [{
  _: 'help.country',
  iso2: 'XD',
  defaultName: 'CrossGram',
  countryCodes: [{
    _: 'help.countryCode',
    countryCode: '888',
    prefixes: ['888'],
    patterns: ['9999 9999 9999'],
  }],
}] as unknown as readonly tl.TlObject[]
