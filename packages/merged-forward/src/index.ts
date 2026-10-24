import type { Context } from 'cordis'
import type { tl } from '@mtcute/core'
import Long from 'long'
import {
  projectDetachedMessage,
  stableId,
  type BridgeSessionState,
  type IMMedia,
  type IMMessageBundle,
  type IMMessageSnapshot,
  type MessageProjectionInput,
  type MessageProjectionResult,
} from '@mtproto-relay/bridge'
import type { ServerRpcContext } from '@mtproto-relay/mtproto'

export const name = 'merged-forward-viewer'
export const inject = ['mtproto', 'mtprotoBridge']

interface BundleRecord {
  platformSessionId: string
  chatId: number
  bundle: IMMessageBundle
  /** 编码进 `chatId` 的持久地址；仅进程内存活的转发没有该字段。 */
  address?: BundleAddress
  snapshots?: Promise<IMMessageSnapshot[]>
  avatar?: Promise<IMMedia<any> | undefined>
  projection?: Promise<ProjectedBundle>
}

interface AvatarEntry {
  media: IMMedia<any>
  peer: AvatarPeer
}

interface AvatarPeer { kind: 'user' | 'chat', id: number }

/**
 * 单个平台会话下的头像表。peer location 按 peer+photo 索引（不同转发可共用同一张头像）；
 * photo location 不带 peer，取首次注册的条目。
 */
interface SessionAvatars {
  peers: Map<string, AvatarEntry>
  photos: Map<string, AvatarEntry>
}

interface ProjectedBundle {
  messages: tl.TypeMessage[]
  chats: tl.TypeChat[]
  users: tl.TypeUser[]
}

/**
 * 合并转发的位置：承载它的持久化消息行 ID，以及从外到内的 bundle 序号路径。
 * `path[0]` 是落库消息中的第几个 bundle，后续每一级对应父级转发内归档消息的 bundle 序号。
 */
export interface BundleAddress {
  storedMessageId: number
  path: number[]
}

/**
 * 合并转发虚拟群 ID 的起始值。高于普通 peer 与 `stableId`（< 2^31），避免与普通会话冲突；
 * 同时高于旧版 2^31 基址，使客户端缓存的旧版哈希消息 ID 自动失效。
 */
const BUNDLE_CHAT_ID_BASE = 2 ** 32
const BUNDLE_PATH_CODES = 1024
/** TDLib 客户端接受的普通群（basic chat）最大 ID 上限。 */
const MAX_BUNDLE_CHAT_ID = 999_999_999_999

/** 将 `BundleAddress` 编码进虚拟群 `chatId`，使重启后仅凭客户端持有的 ID 即可还原；超出编码范围时返回 `undefined`。 */
export function encodeBundleChatId(address: BundleAddress): number | undefined {
  const { storedMessageId, path } = address
  if (!Number.isSafeInteger(storedMessageId) || storedMessageId <= 0) return
  const code = encodeBundlePath(path)
  if (code === undefined || code >= BUNDLE_PATH_CODES) return
  const id = BUNDLE_CHAT_ID_BASE + storedMessageId * BUNDLE_PATH_CODES + code
  return Number.isSafeInteger(id) && id <= MAX_BUNDLE_CHAT_ID ? id : undefined
}

export function decodeBundleChatId(chatId: number): BundleAddress | undefined {
  if (!Number.isSafeInteger(chatId) || chatId > MAX_BUNDLE_CHAT_ID) return
  const relative = chatId - BUNDLE_CHAT_ID_BASE
  const storedMessageId = Math.floor(relative / BUNDLE_PATH_CODES)
  if (storedMessageId <= 0) return
  const path = decodeBundlePath(relative % BUNDLE_PATH_CODES)
  return path ? { storedMessageId, path } : undefined
}

/** 用带前导哨兵位的 Elias-gamma 编码将 `ordinal + 1` 序列打包进 10 bit 整数，首条顶层转发编码为 0。 */
function encodeBundlePath(path: readonly number[]): number | undefined {
  if (!path.length || path.some((ordinal) => !Number.isSafeInteger(ordinal) || ordinal < 0)) return
  let bits = '1'
  for (const ordinal of path) {
    const binary = (ordinal + 1).toString(2)
    bits += '0'.repeat(binary.length - 1) + binary
    if (bits.length > 16) return
  }
  return parseInt(bits, 2) - 3
}

function decodeBundlePath(code: number): number[] | undefined {
  const bits = (code + 3).toString(2).slice(1)
  const path: number[] = []
  let cursor = 0
  while (cursor < bits.length) {
    let zeros = 0
    while (cursor + zeros < bits.length && bits[cursor + zeros] === '0') zeros++
    const end = cursor + zeros * 2 + 1
    if (end > bits.length) return
    path.push(parseInt(bits.slice(cursor + zeros, end), 2) - 1)
    cursor = end
  }
  return path.length && encodeBundlePath(path) === code ? path : undefined
}

function bundleParts(parts: readonly { type: string }[]): IMMessageBundle[] {
  return parts.flatMap((part) => part.type === 'message-bundle'
    ? [(part as { type: 'message-bundle', bundle: IMMessageBundle }).bundle]
    : [])
}

function nestedBundles(snapshots: readonly IMMessageSnapshot[]): IMMessageBundle[] {
  return snapshots.flatMap((snapshot) => bundleParts(snapshot.content.parts))
}

export type BundleSessionState = Pick<BridgeSessionState, 'platform' | 'session'> & {
  dialogs?: Partial<Pick<BridgeSessionState['dialogs'], 'readStoredMessage'>>
}

const MAX_CACHED_RECORDS = 256
const MAX_NESTED_ADDRESSES = 4096

/**
 * 合并转发虚拟会话的缓存与投影。
 * 带持久地址的转发编码在 `chatId` 中，重启后可从 `MessageStore` 重建；转发内部消息 ID 按时间序递增分配以支持客户端游标分页。
 */
export class MergedForwardProjection {
  private readonly _records = new Map<string, Map<number, BundleRecord>>()
  private readonly _nestedAddresses = new Map<string, Map<string, BundleAddress>>()
  private readonly _rebuilds = new Map<string, Promise<BundleRecord | undefined>>()
  private readonly _avatars = new Map<string, SessionAvatars>()
  private readonly _photoIds = new Set<string>()

  constructor(private readonly _dcId = 1) {}

  makeBundleUser(state: BridgeSessionState, snapshot: IMMessageSnapshot): tl.RawUser {
    const id = bundleUserId(state, snapshot.senderId)
    const source = snapshot.sender
    return {
      _: 'user', id, accessHash: Long.fromNumber(id),
      firstName: source?.firstName || snapshot.senderId,
      lastName: source?.lastName,
      username: source?.username,
      photo: source?.avatar
        ? this.registerAvatar(
            state.session.platformSessionId, { kind: 'user', id }, source.avatar,
          ).photo
        : { _: 'userProfilePhotoEmpty' },
    }
  }

  remember(platformSessionId: string, bundle: IMMessageBundle, address?: BundleAddress): BundleRecord {
    const encoded = address ? encodeBundleChatId(address) : undefined
    const chatId = encoded ?? bundleChatId(bundle)
    const records = this._records.get(platformSessionId) ?? new Map<number, BundleRecord>()
    const existing = records.get(chatId)
    if (existing?.bundle.id === bundle.id) {
      existing.bundle = bundle
      records.delete(chatId)
      records.set(chatId, existing)
      return existing
    }
    const record: BundleRecord = {
      platformSessionId, chatId, bundle,
      ...(encoded !== undefined ? { address: { storedMessageId: address!.storedMessageId, path: [...address!.path] } } : {}),
    }
    records.set(chatId, record)
    this._records.set(platformSessionId, records)
    this.evict(records)
    return record
  }

  /** 只淘汰带持久地址的记录（可从 `MessageStore` 重建），保留进程内临时转发。 */
  private evict(records: Map<number, BundleRecord>): void {
    let addressed = 0
    for (const record of records.values()) if (record.address) addressed++
    for (const [chatId, record] of records) {
      if (addressed <= MAX_CACHED_RECORDS) break
      if (!record.address) continue
      records.delete(chatId)
      addressed--
    }
  }

  resolve(platformSessionId: string, chatId: number): BundleRecord | undefined {
    return this._records.get(platformSessionId)?.get(chatId)
  }

  /** 查找虚拟群对应的转发记录；未命中缓存时根据 `chatId` 编码的地址从落库消息重建。 */
  async lookup(state: BundleSessionState, chatId: number): Promise<BundleRecord | undefined> {
    const platformSessionId = state.session.platformSessionId
    const cached = this.resolve(platformSessionId, chatId)
    if (cached) return cached
    const address = decodeBundleChatId(chatId)
    if (!address || !state.dialogs?.readStoredMessage) return
    const key = `${platformSessionId}\u0000${chatId}`
    const running = this._rebuilds.get(key)
    if (running) return running
    const pending = this.rebuild(state, address)
      .catch(() => undefined)
      .finally(() => {
        if (this._rebuilds.get(key) === pending) this._rebuilds.delete(key)
      })
    this._rebuilds.set(key, pending)
    return pending
  }

  private async rebuild(state: BundleSessionState, address: BundleAddress): Promise<BundleRecord | undefined> {
    const source = await state.dialogs!.readStoredMessage!(address.storedMessageId)
    if (!source) return
    let bundle = bundleParts(source.content.parts)[address.path[0]!]
    for (let depth = 1; bundle && depth < address.path.length; depth++) {
      const parent = this.remember(state.session.platformSessionId, bundle, {
        storedMessageId: address.storedMessageId, path: address.path.slice(0, depth),
      })
      bundle = nestedBundles(await this.loadSnapshots(state, parent))[address.path[depth]!]
    }
    if (!bundle) return
    return this.remember(state.session.platformSessionId, bundle, address)
  }

  records(platformSessionId: string): Iterable<BundleRecord> {
    return this._records.get(platformSessionId)?.values() ?? []
  }

  async resolveUsername(state: BundleSessionState, username: string): Promise<BundleRecord | undefined> {
    const match = /^bridge(?:bundle|chat)_(\d+)$/i.exec(username)
    return match ? this.lookup(state, Number(match[1])) : undefined
  }

  private addressOf(input: MessageProjectionInput, bundle: IMMessageBundle, ordinal: number): BundleAddress | undefined {
    if (input.mode !== 'bundle') {
      return input.storedMessageId ? { storedMessageId: input.storedMessageId, path: [ordinal] } : undefined
    }
    return this._nestedAddresses.get(input.session.platformSessionId)?.get(bundle.id)
  }

  private registerNested(record: BundleRecord, snapshots: readonly IMMessageSnapshot[]): void {
    if (!record.address) return
    const nested = nestedBundles(snapshots)
    if (!nested.length) return
    let addresses = this._nestedAddresses.get(record.platformSessionId)
    if (!addresses) {
      addresses = new Map()
      this._nestedAddresses.set(record.platformSessionId, addresses)
    }
    for (const [index, bundle] of nested.entries()) {
      addresses.delete(bundle.id)
      addresses.set(bundle.id, {
        storedMessageId: record.address.storedMessageId, path: [...record.address.path, index],
      })
    }
    while (addresses.size > MAX_NESTED_ADDRESSES) addresses.delete(addresses.keys().next().value!)
  }

  async project(
    input: MessageProjectionInput,
    next: () => MessageProjectionResult | Promise<MessageProjectionResult>,
  ): Promise<MessageProjectionResult> {
    if (input.ordinal !== 0) return next()
    const bundles = input.draft.source.content.parts
      .filter((part): part is Extract<typeof part, { type: 'message-bundle' }> => part.type === 'message-bundle')
    if (!bundles.length) return next()

    const links = new Map<string, string>()
    const targets = new Map<string, number>()
    const records = new Map<string, BundleRecord>()
    for (const [ordinal, part] of bundles.entries()) {
      const record = this.remember(
        input.session.platformSessionId, part.bundle, this.addressOf(input, part.bundle, ordinal),
      )
      records.set(part.bundle.id, record)
      const snapshots = await this.loadSnapshots(input, record)
      if (!record.bundle.preview?.trim()) {
        const preview = snapshotPreview(snapshots)
        if (preview) record.bundle = { ...record.bundle, preview }
      }
      const first = firstSnapshot(snapshots)
      // 链接锚定在转发首条消息，使客户端从头打开聊天记录而非跳到末尾。
      const target = first ? transcriptMessageId(0, 0) : undefined
      if (target) targets.set(part.bundle.id, target)
      links.set(part.bundle.id, this.makeLink(
        record,
        target,
      ))
      input.draft.chats.push(this.makeChat(record, snapshots, await this.loadAvatar(input, record)))
    }

    const source = input.draft.source
    input.draft.source = {
      ...source,
      content: {
        ...source.content,
        parts: source.content.parts.map((part) => {
          if (part.type !== 'message-bundle') return part
          const text = '查看聊天记录'
          return {
            type: 'text' as const,
            text,
            entities: [{
              type: 'text-link' as const,
              offset: 0,
              length: text.length,
              url: links.get(part.bundle.id)!,
            }],
          }
        }),
      },
    }
    if (!source.content.parts.some((part) =>
      part.type === 'media' || part.type === 'sticker' || part.type === 'card')) {
      const record = records.get(bundles[0].bundle.id)
      if (record) {
        input.draft.media = this.makePreview(record, targets.get(bundles[0].bundle.id))
      }
    }
    return next()
  }

  makeLink(record: BundleRecord, messageId?: number): string {
    return `https://t.me/bridgebundle_${record.chatId}${messageId ? `/${messageId}` : ''}`
  }

  makeChat(
    record: BundleRecord,
    snapshots: readonly IMMessageSnapshot[] = [],
    avatar?: IMMedia<any>,
  ): tl.RawChat {
    return {
      _: 'chat', left: true, id: record.chatId, title: record.bundle.title,
      photo: avatar
        ? this.registerAvatar(record.platformSessionId, { kind: 'chat', id: record.chatId }, avatar).photo
        : { _: 'chatPhotoEmpty' },
      participantsCount: Math.max(1, new Set(snapshots.map((item) => item.senderId)).size),
      date: 0, version: 1,
    }
  }

  /**
   * 合并转发的网页预览卡片。不附带 `photo`，否则 Telegram Android 会把 `telegram_message` 的图片渲染为通栏大图；
   * 会话头像只挂在虚拟群 `chat` 实体上。
   */
  makePreview(
    record: BundleRecord,
    messageId?: number,
  ): tl.RawMessageMediaWebPage {
    const url = this.makeLink(record, messageId)
    return {
      _: 'messageMediaWebPage', manual: true, safe: true,
      webpage: {
        _: 'webPage',
        id: Long.fromNumber(stableId(`merged-forward-preview:${record.bundle.id}`)),
        url, displayUrl: record.bundle.title, hash: 0,
        type: 'telegram_message', title: record.bundle.title,
        description: record.bundle.preview?.trim() || undefined,
      },
    }
  }

  makeFullChat(
    record: BundleRecord,
    snapshots: readonly IMMessageSnapshot[],
    avatar?: IMMedia<any>,
  ): tl.messages.RawChatFull {
    const chat = this.makeChat(record, snapshots, avatar)
    return {
      _: 'messages.chatFull',
      fullChat: {
        _: 'chatFull', id: record.chatId, about: '',
        participants: { _: 'chatParticipantsForbidden', chatId: record.chatId },
        chatPhoto: avatar
          ? this.makeBundlePhoto(record.platformSessionId, record.chatId, avatar)
          : { _: 'photoEmpty', id: Long.ZERO },
        notifySettings: { _: 'peerNotifySettings' }, botInfo: [],
      },
      chats: [chat], users: [],
    }
  }

  loadAvatar(input: Pick<MessageProjectionInput, 'platform' | 'session'>, record: BundleRecord) {
    if (record.avatar) return record.avatar
    const pending: Promise<IMMedia<any> | undefined> = readBundleAvatar(input, record)
    record.avatar = pending
    pending.catch(() => {
      if (record.avatar === pending) record.avatar = undefined
    })
    return pending.catch(() => undefined)
  }

  private makeBundlePhoto(
    platformSessionId: string,
    chatId: number,
    media: IMMedia<any>,
  ): tl.RawPhoto {
    const { photoId } = this.registerAvatar(platformSessionId, { kind: 'chat', id: chatId }, media)
    const width = media.width ?? BUNDLE_PHOTO_SIZE
    const height = media.height ?? BUNDLE_PHOTO_SIZE
    return {
      _: 'photo',
      id: photoId,
      accessHash: Long.fromNumber(stableId(`merged-forward-photo:${media.id}`)),
      fileReference: BUNDLE_PHOTO_FILE_REFERENCE,
      date: 0,
      sizes: [
        { _: 'photoSize', type: 'm', w: width, h: height, size: 0 },
        { _: 'photoSize', type: 'x', w: width, h: height, size: media.size ?? 0 },
      ],
      dcId: this._dcId,
    }
  }

  private registerAvatar(
    platformSessionId: string,
    peer: { kind: 'user', id: number },
    media: IMMedia<any>,
  ): { photoId: Long, photo: tl.RawUserProfilePhoto }
  private registerAvatar(
    platformSessionId: string,
    peer: { kind: 'chat', id: number },
    media: IMMedia<any>,
  ): { photoId: Long, photo: tl.RawChatPhoto }
  private registerAvatar(
    platformSessionId: string,
    peer: AvatarPeer,
    media: IMMedia<any>,
  ): { photoId: Long, photo: tl.RawUserProfilePhoto | tl.RawChatPhoto } {
    const photoId = Long.fromNumber(stableId(`avatar:${media.id}`))
    const session = this.avatarSession(platformSessionId)
    const entry: AvatarEntry = { media, peer }
    this._photoIds.add(photoId.toString())
    session.peers.set(peerKey(peer, photoId), entry)
    const photoKey = photoId.toString()
    if (!session.photos.has(photoKey)) session.photos.set(photoKey, entry)
    return {
      photoId,
      photo: peer.kind === 'user'
        ? { _: 'userProfilePhoto', photoId, dcId: this._dcId }
        : { _: 'chatPhoto', photoId, dcId: this._dcId },
    }
  }

  private avatarSession(platformSessionId: string): SessionAvatars {
    let session = this._avatars.get(platformSessionId)
    if (!session) {
      session = { peers: new Map(), photos: new Map() }
      this._avatars.set(platformSessionId, session)
    }
    return session
  }

  /** 在解析平台会话前快速判断文件位置是否可能属于合并转发头像，避免影响普通媒体下载路径。 */
  mightServeLocation(location: tl.TypeInputFileLocation): boolean {
    if (transcriptPhotoChatId(location) !== undefined) return true
    if (!this._photoIds.size) return false
    if (location._ === 'inputPeerPhotoFileLocation') {
      return this._photoIds.has(location.photoId.toString())
    }
    if (location._ === 'inputPhotoFileLocation') {
      return sameBytes(location.fileReference, BUNDLE_PHOTO_FILE_REFERENCE)
        && this._photoIds.has(location.id.toString())
    }
    return false
  }

  resolveAvatarLocation(platformSessionId: string, location: tl.TypeInputFileLocation): AvatarEntry | undefined {
    const session = this._avatars.get(platformSessionId)
    if (!session) return
    if (location._ === 'inputPeerPhotoFileLocation') {
      const peer = inputPeerKey(location.peer)
      return peer ? session.peers.get(`${peer}:${location.photoId}`) : undefined
    }
    if (location._ === 'inputPhotoFileLocation') {
      if (!sameBytes(location.fileReference, BUNDLE_PHOTO_FILE_REFERENCE)) return
      return session.photos.get(location.id.toString())
    }
  }

  loadSnapshots(input: Pick<MessageProjectionInput, 'platform' | 'session'>, record: BundleRecord) {
    if (record.snapshots) return record.snapshots
    const provider = input.platform.messageBundles
    record.snapshots = provider
      ? provider.load(input.session, record.bundle.locator)
      : Promise.resolve([])
    record.snapshots.catch(() => {
      record.snapshots = undefined
    })
    return record.snapshots
  }

  materialize(state: BridgeSessionState, record: BundleRecord): Promise<ProjectedBundle> {
    if (record.projection) return record.projection
    record.projection = this.buildProjection(state, record)
    record.projection.catch(() => {
      record.projection = undefined
    })
    return record.projection
  }

  clear(): void {
    this._records.clear()
    this._nestedAddresses.clear()
    this._rebuilds.clear()
    this._avatars.clear()
    this._photoIds.clear()
  }

  private async buildProjection(state: BridgeSessionState, record: BundleRecord): Promise<ProjectedBundle> {
    const snapshots = await this.loadSnapshots(state, record)
    this.registerNested(record, snapshots)
    const peer = { _: 'peerChat' as const, chatId: record.chatId }
    const ranks = transcriptRanks(snapshots)
    const replyIds = new Map(snapshots.map((snapshot) => [
      snapshot.id,
      transcriptMessageId(ranks.get(snapshot.id) ?? 0, 0),
    ]))
    const messages: tl.TypeMessage[] = []
    const chats: tl.TypeChat[] = [this.makeChat(record, snapshots, await this.loadAvatar(state, record))]
    const users = new Map<number, tl.TypeUser>()

    for (const snapshot of snapshots) {
      users.set(bundleUserId(state, snapshot.senderId), this.makeBundleUser(state, snapshot))
      const rendered = await projectDetachedMessage({
        pipeline: state.projection,
        platform: state.platform,
        session: state.session,
        stickers: state.stickers,
        source: snapshot,
        target: { peer, title: record.bundle.title },
        messageId: (ordinal) => transcriptMessageId(ranks.get(snapshot.id) ?? 0, ordinal),
        mediaId: (partIndex) => stableId(
          `merged-forward-media:${record.bundle.id}:${snapshot.id}:${partIndex}`,
        ),
        userId: (id) => bundleUserId(state, id),
        replyToMessageId: snapshot.replyToId ? replyIds.get(snapshot.replyToId) : undefined,
        groupedId: String(stableId(
          `merged-forward-group:${record.bundle.id}:${snapshot.groupId ?? snapshot.id}`,
        )),
      })
      messages.push(...rendered.messages)
      chats.push(...rendered.chats)
    }
    // 历史分页按最新在前返回；QQ 时间戳精度到秒，同秒消息用按归档序递增的 ID 决胜。
    messages.sort((left, right) => messageDate(right) - messageDate(left) || right.id - left.id)
    return {
      messages,
      chats: uniqueById(chats),
      users: [...users.values()],
    }
  }
}

export function makeMergedForwardProvider(dcId = 1): MergedForwardProjection {
  return new MergedForwardProjection(dcId)
}

export function apply(ctx: Context): void {
  const projection = new MergedForwardProjection(ctx.mtprotoBridge.dcId)
  ctx.on('bridge/message/project', (input, next) => projection.project(input, next))
  ctx.on('mtproto/rpc', async function (
    this: ServerRpcContext,
    request: tl.RpcMethod,
    next: () => Promise<unknown>,
  ): Promise<unknown> {
    const result = await routeMergedForwardRpc(ctx, projection, this, request)
    if (result === undefined) return next()
    return result
  } as never, { prepend: true })
  ctx.effect(() => () => projection.clear(), 'mergedForward.clear')
}

async function routeMergedForwardRpc(
  ctx: Context,
  projection: MergedForwardProjection,
  rpc: ServerRpcContext,
  request: tl.RpcMethod,
): Promise<unknown | undefined> {
  const resolveState = () => ctx.mtprotoBridge.resolveSession(rpc)
  if (request._ === 'upload.getFile') {
    const req = request as tl.upload.RawGetFileRequest
    if (!projection.mightServeLocation(req.location)) return
    const offset = Number(req.offset)
    if (!Number.isFinite(offset) || offset < 0 || req.limit <= 0) return
    const state = await resolveState()
    let entry = projection.resolveAvatarLocation(state.session.platformSessionId, req.location)
    if (!entry) {
      // 客户端可能在重启后拉取已缓存转发的头像，此时需先重建转发以重新注册头像。
      const chatId = transcriptPhotoChatId(req.location)
      const record = chatId === undefined ? undefined : await projection.lookup(state, chatId)
      if (record) {
        projection.makeChat(record, [], await projection.loadAvatar(state, record))
        entry = projection.resolveAvatarLocation(state.session.platformSessionId, req.location)
      }
    }
    if (!entry || !state.platform.downloadMedia) return
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of state.platform.downloadMedia(state.session, entry.media, {
      offset, limit: req.limit,
    })) {
      const remaining = req.limit - size
      if (remaining <= 0) break
      const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
      chunks.push(accepted)
      size += accepted.length
    }
    const bytes = new Uint8Array(size)
    let cursor = 0
    for (const chunk of chunks) {
      bytes.set(chunk, cursor)
      cursor += chunk.length
    }
    return {
      _: 'upload.file',
      type: offset === 0 ? avatarStorageFileType(bytes) : { _: 'storage.fileUnknown' as const },
      mtime: Math.floor(Date.now() / 1000),
      bytes,
    }
  }
  if (request._ === 'contacts.resolveUsername') {
    const req = request as tl.contacts.RawResolveUsernameRequest
    if (!/^bridge(?:bundle|chat)_\d+$/i.test(req.username)) return
    const state = await resolveState()
    const record = await projection.resolveUsername(state, req.username)
    if (!record) return
    const snapshots = await projection.loadSnapshots(state, record)
    return {
      _: 'contacts.resolvedPeer', peer: { _: 'peerChat', chatId: record.chatId },
      chats: [projection.makeChat(record, snapshots, await projection.loadAvatar(state, record))],
      users: [],
    }
  }
  if (request._ === 'messages.getFullChat') {
    const req = request as tl.messages.RawGetFullChatRequest
    const state = await resolveState()
    const record = await projection.lookup(state, req.chatId)
    if (!record) return
    return projection.makeFullChat(
      record,
      await projection.loadSnapshots(state, record),
      await projection.loadAvatar(state, record),
    )
  }
  if (
    request._ === 'messages.getHistory'
    || request._ === 'messages.readHistory'
    || request._ === 'messages.getScheduledHistory'
    || request._ === 'messages.getPeerSettings'
  ) {
    const req = request as tl.messages.RawGetHistoryRequest
      | tl.messages.RawReadHistoryRequest
      | tl.messages.RawGetScheduledHistoryRequest
      | tl.messages.RawGetPeerSettingsRequest
    if (req.peer._ !== 'inputPeerChat') return
    const state = await resolveState()
    const record = await projection.lookup(state, req.peer.chatId)
    if (!record) return
    if (request._ === 'messages.readHistory') {
      return { _: 'messages.affectedMessages', pts: 0, ptsCount: 0 }
    }
    if (request._ === 'messages.getScheduledHistory') {
      const snapshots = await projection.loadSnapshots(state, record)
      return {
        _: 'messages.messages', messages: [], topics: [],
        chats: [projection.makeChat(record, snapshots, await projection.loadAvatar(state, record))],
        users: [],
      }
    }
    if (request._ === 'messages.getPeerSettings') {
      const snapshots = await projection.loadSnapshots(state, record)
      return {
        _: 'messages.peerSettings', settings: { _: 'peerSettings' },
        chats: [projection.makeChat(record, snapshots, await projection.loadAvatar(state, record))],
        users: [],
      }
    }
    const bundle = await projection.materialize(state, record)
    const history = request as tl.messages.RawGetHistoryRequest
    // 兼容旧版不带首条消息锚点的深链：客户端用 `offsetId = 1` 显式请求最旧一页。
    const page = history.offsetId === kFirstMessageOffsetId
      ? firstPage(selectWithinBounds(bundle.messages, history), history.limit)
      : selectHistory(bundle.messages, history)
    return {
      _: 'messages.messagesSlice', count: bundle.messages.length,
      messages: page, topics: [], chats: bundle.chats, users: bundle.users,
    }
  }
  if (request._ === 'messages.getPeerDialogs') {
    const state = await resolveState()
    const req = request as tl.messages.RawGetPeerDialogsRequest
    const records = (await Promise.all(req.peers.map(async (item, index) => {
      if (item._ !== 'inputDialogPeer' || item.peer._ !== 'inputPeerChat') return undefined
      const record = await projection.lookup(state, item.peer.chatId)
      return record ? { index, record } : undefined
    }))).filter((entry): entry is { index: number, record: BundleRecord } => entry !== undefined)
    if (!records.length) return
    const virtualIndexes = new Set(records.map((entry) => entry.index))
    const ordinaryPeers = req.peers.filter((_item, index) => !virtualIndexes.has(index))
    const projectedChats = await Promise.all(records.map(async ({ record }) => {
      const snapshots = await projection.loadSnapshots(state, record)
      return projection.makeChat(record, snapshots, await projection.loadAvatar(state, record))
    }))
    const ordinary = ordinaryPeers.length
      ? await state.dialogs.getPeerDialogs({ ...req, peers: ordinaryPeers })
      : undefined
    const virtualByIndex = new Map(records.map((entry) => [entry.index, entry.record]))
    // `topMessage = 0` 让客户端通过锚点消息前的 dialog 预检，同时跳过将该虚拟会话写入聊天列表。
    let ordinaryCursor = 0
    const dialogs: tl.TypeDialog[] = []
    for (let index = 0; index < req.peers.length; index++) {
      const record = virtualByIndex.get(index)
      if (record) {
        dialogs.push(transcriptDialog(record.chatId))
        continue
      }
      if (req.peers[index]?._ !== 'inputDialogPeer') continue
      const next = ordinary?.dialogs[ordinaryCursor++]
      if (next) dialogs.push(next)
    }
    return {
      _: 'messages.peerDialogs',
      dialogs,
      messages: ordinary?.messages ?? [],
      chats: uniqueById([...(ordinary?.chats ?? []), ...projectedChats]),
      users: ordinary?.users ?? [],
      state: ordinary?.state ?? { _: 'updates.state', pts: 0, qts: 0, date: 0, seq: 0, unreadCount: 0 },
    }
  }
  if (request._ === 'messages.getMessages') {
    const state = await resolveState()
    const req = request as tl.messages.RawGetMessagesRequest
    const bundles = await Promise.all(
      [...projection.records(state.session.platformSessionId)]
        .map((record) => projection.materialize(state, record)),
    )
    const virtualById = new Map(bundles.flatMap((bundle) => bundle.messages.map((message) => [message.id, message])))
    const requestedIds = req.id.map(inputMessageId)
    const ordinaryInputs = req.id.filter((input) => !virtualById.has(inputMessageId(input)))
    if (ordinaryInputs.length === req.id.length) return
    const ordinary = ordinaryInputs.length
      ? await state.dialogs.getMessages({ ...req, id: ordinaryInputs })
      : undefined
    const ordinaryMessages = ordinary && ordinary._ !== 'messages.messagesNotModified'
      ? ordinary.messages
      : []
    const byId = new Map([...ordinaryMessages, ...virtualById.values()].map((message) => [message.id, message]))
    return {
      _: 'messages.messages',
      messages: requestedIds.map((id) => byId.get(id) ?? { _: 'messageEmpty', id }),
      topics: [],
      chats: uniqueById([
        ...(ordinary && ordinary._ !== 'messages.messagesNotModified' ? ordinary.chats : []),
        ...bundles.flatMap((bundle) => bundle.chats),
      ]),
      users: uniqueById([
        ...(ordinary && ordinary._ !== 'messages.messagesNotModified' ? ordinary.users : []),
        ...bundles.flatMap((bundle) => bundle.users),
      ]),
    }
  }
}

function transcriptDialog(chatId: number): tl.RawDialog {
  return {
    _: 'dialog',
    peer: { _: 'peerChat', chatId },
    topMessage: 0,
    readInboxMaxId: 0,
    readOutboxMaxId: 0,
    unreadCount: 0,
    unreadMentionsCount: 0,
    unreadReactionsCount: 0,
    unreadPollVotesCount: 0,
    notifySettings: { _: 'peerNotifySettings' },
  }
}

function firstSnapshot(
  snapshots: readonly IMMessageSnapshot[],
): IMMessageSnapshot | undefined {
  return chronologicalSnapshots(snapshots)[0]
}

export function snapshotPreview(snapshots: readonly IMMessageSnapshot[]): string | undefined {
  const lines = [...snapshots]
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(0, 4)
    .map((snapshot) => {
      const sender = [snapshot.sender?.firstName, snapshot.sender?.lastName]
        .filter(Boolean).join(' ').trim() || snapshot.senderId
      const content = snapshot.content.parts.map((part) => {
        if (part.type === 'text') return part.text.trim()
        if (part.type === 'media') {
          return part.media.kind === 'image' ? '[图片]' : part.media.name?.trim() || '[文件]'
        }
        if (part.type === 'sticker') return '[表情]'
        if (part.type === 'card') return part.card.title?.trim() || '[卡片消息]'
        return `[${part.bundle.title || '聊天记录'}]`
      }).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
      return content ? `${sender}: ${content}` : ''
    })
    .filter(Boolean)
  return lines.join('\n') || undefined
}

async function readBundleAvatar(
  input: Pick<MessageProjectionInput, 'platform' | 'session'>,
  record: BundleRecord,
): Promise<IMMedia<any> | undefined> {
  return await input.platform.messageBundles?.avatar?.(input.session, record.bundle.locator)
}

function bundleChatId(bundle: IMMessageBundle): number {
  return stableId(`merged-forward-chat:${bundle.id}`)
}

/** 避开客户端表示“从历史开头读取”的 `offsetId = 1` 哨兵值。 */
const TRANSCRIPT_MESSAGE_ID_BASE = 1000

/** 每条归档消息预留的 ID 步长，用于容纳单条消息拆分出的多个 part。 */
const TRANSCRIPT_MESSAGE_ID_STRIDE = 1000

/** 按归档时间序分配消息 ID，满足客户端用 `offset_id`/`max_id`/`min_id` 游标分页及同秒消息排序。 */
export function transcriptMessageId(rank: number, ordinal: number): number {
  return TRANSCRIPT_MESSAGE_ID_BASE + rank * TRANSCRIPT_MESSAGE_ID_STRIDE + ordinal
}

function chronologicalSnapshots(snapshots: readonly IMMessageSnapshot[]): IMMessageSnapshot[] {
  return snapshots
    .map((snapshot, index) => ({ snapshot, index }))
    .sort((left, right) =>
      left.snapshot.timestamp - right.snapshot.timestamp || left.index - right.index)
    .map((entry) => entry.snapshot)
}

function transcriptRanks(snapshots: readonly IMMessageSnapshot[]): Map<string, number> {
  return new Map(chronologicalSnapshots(snapshots).map((snapshot, rank) => [snapshot.id, rank]))
}

function bundleUserId(state: BridgeSessionState, platformUserId: string): number {
  return stableId(`merged-forward-user:${state.session.platformSessionId}:${platformUserId}`)
}

const BUNDLE_PHOTO_SIZE = 640

const BUNDLE_PHOTO_FILE_REFERENCE = new TextEncoder().encode('crossgram-merged-forward-avatar:v1')

function peerKey(peer: AvatarPeer, photoId: Long): string {
  return `${peer.kind}:${peer.id}:${photoId.toString()}`
}

function transcriptPhotoChatId(location: tl.TypeInputFileLocation): number | undefined {
  if (location._ !== 'inputPeerPhotoFileLocation' || location.peer._ !== 'inputPeerChat') return
  return decodeBundleChatId(location.peer.chatId) ? location.peer.chatId : undefined
}

function inputPeerKey(location: tl.TypeInputPeer): string | undefined {
  if (location._ === 'inputPeerUser') return `user:${location.userId}`
  if (location._ === 'inputPeerChat') return `chat:${location.chatId}`
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

function avatarStorageFileType(bytes: Uint8Array): tl.storage.TypeFileType {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { _: 'storage.filePng' }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { _: 'storage.fileJpeg' }
  }
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { _: 'storage.fileWebp' }
  }
  return { _: 'storage.fileUnknown' }
}

const kFirstMessageOffsetId = 1

function firstPage(
  messages: readonly tl.TypeMessage[],
  limit: number,
): tl.TypeMessage[] {
  const count = Math.max(0, limit)
  return messages.slice(Math.max(0, messages.length - count))
}

function selectHistory(
  messages: readonly tl.TypeMessage[],
  request: tl.messages.RawGetHistoryRequest,
): tl.TypeMessage[] {
  const filtered = selectWithinBounds(messages, request)
  const start = pageStart(filtered, request)
  return filtered.slice(start, start + Math.max(0, request.limit))
}

function selectWithinBounds(
  messages: readonly tl.TypeMessage[],
  request: tl.messages.RawGetHistoryRequest,
): tl.TypeMessage[] {
  let filtered = [...messages]
  if (request.maxId > 0) filtered = filtered.filter((message) => message.id < request.maxId)
  if (request.minId > 0) filtered = filtered.filter((message) => message.id > request.minId)
  return filtered
}

/**
 * 计算最新在前数组中的分页起点。
 * `offsetId` 为排他游标（从第一条 `< offsetId` 的消息开始），`addOffset` 为负时向更新的消息偏移。
 */
function pageStart(
  filtered: readonly tl.TypeMessage[],
  request: tl.messages.RawGetHistoryRequest,
): number {
  let start = 0
  if (request.offsetId > 0) {
    const below = filtered.findIndex((message) => message.id < request.offsetId)
    start = below < 0 ? filtered.length : below
  }
  return Math.max(0, start + request.addOffset)
}

function inputMessageId(input: tl.TypeInputMessage): number {
  return input._ === 'inputMessageID' || input._ === 'inputMessageReplyTo' ? input.id : 0
}

function messageDate(message: tl.TypeMessage): number {
  return message._ === 'messageEmpty' ? 0 : message.date
}

function uniqueById<T extends { _: string, id: number }>(items: readonly T[]): T[] {
  return [...new Map(items.map((item) => [`${item._}:${item.id}`, item])).values()]
}
