import type { Database } from '@cordisjs/plugin-database'
import type { tl } from '@mtcute/core'
import Long from 'long'
import type { JsonObject, JsonValue } from './platform.js'

export interface StoredDialogFilter {
  kind: 'dialogFilter' | 'dialogFilterChatlist'
  contacts?: boolean
  nonContacts?: boolean
  groups?: boolean
  broadcasts?: boolean
  bots?: boolean
  excludeMuted?: boolean
  excludeRead?: boolean
  excludeArchived?: boolean
  titleNoanimate?: boolean
  hasMyInvites?: boolean
  title: JsonValue
  emoticon?: string
  color?: number
  pinnedPeerIds: string[]
  includePeerIds: string[]
  excludePeerIds: string[]
}

export interface OrderedDialogFilter {
  filterId: number
  filter?: StoredDialogFilter
}

/** Durable Telegram chat folders and the special archive peer folder. */
export class DialogFolderStore {
  constructor(private readonly _database: Database) {}

  async listFilters(platformSessionId: string): Promise<OrderedDialogFilter[]> {
    const rows = await this._database.get('mtproto_dialog_filter', { platformSessionId })
    const ordered = rows.sort((left, right) => left.sortOrder - right.sortOrder || left.filterId - right.filterId)
      .map((row): OrderedDialogFilter => ({
        filterId: row.filterId,
        ...(row.payload ? { filter: row.payload as unknown as StoredDialogFilter } : {}),
      }))
    if (!ordered.some((entry) => entry.filterId === 0)) ordered.unshift({ filterId: 0 })
    return ordered
  }

  async putFilter(
    platformSessionId: string,
    filterId: number,
    filter: StoredDialogFilter,
  ): Promise<void> {
    const rows = await this._database.get('mtproto_dialog_filter', { platformSessionId })
    const existing = rows.find((row) => row.filterId === filterId)
    const sortOrder = existing?.sortOrder
      ?? (rows.length ? Math.max(...rows.map((row) => row.sortOrder)) + 1 : 1)
    await this._database.upsert('mtproto_dialog_filter', [{
      id: filterKey(platformSessionId, filterId), platformSessionId, filterId, sortOrder,
      payload: filter as unknown as JsonObject, updatedAt: new Date(),
    }])
  }

  async removeFilter(platformSessionId: string, filterId: number): Promise<void> {
    await this._database.remove('mtproto_dialog_filter', { platformSessionId, filterId })
  }

  async reorderFilters(platformSessionId: string, requestedOrder: readonly number[]): Promise<number[]> {
    const rows = await this._database.get('mtproto_dialog_filter', { platformSessionId })
    const existingIds = new Set([0, ...rows.filter((row) => row.payload).map((row) => row.filterId)])
    const order: number[] = []
    for (const id of requestedOrder) {
      if (!existingIds.has(id) || order.includes(id)) continue
      order.push(id)
    }
    for (const id of existingIds) if (!order.includes(id)) order.push(id)
    const byId = new Map(rows.map((row) => [row.filterId, row]))
    await this._database.withTransaction(async (database) => {
      for (const [sortOrder, filterId] of order.entries()) {
        const existing = byId.get(filterId)
        await database.upsert('mtproto_dialog_filter', [{
          id: filterKey(platformSessionId, filterId), platformSessionId, filterId, sortOrder,
          payload: existing?.payload ?? null, updatedAt: new Date(),
        }])
      }
    })
    return order
  }

  async archivedPeerIds(platformSessionId: string): Promise<Set<string>> {
    const rows = await this._database.get('mtproto_dialog_folder_peer', {
      platformSessionId, folderId: 1,
    })
    return new Set(rows.map((row) => row.platformConversationId))
  }

  async setPeerFolders(
    platformSessionId: string,
    peers: readonly { peerId: string, folderId: 0 | 1 }[],
  ): Promise<Set<string>> {
    const unique = new Map(peers.map((peer) => [peer.peerId, peer.folderId]))
    const peerIds = [...unique.keys()]
    const existing = new Map((peerIds.length
      ? await this._database.get('mtproto_dialog_folder_peer', {
          platformSessionId, platformConversationId: { $in: peerIds },
        })
      : []).map((row) => [row.platformConversationId, row]))
    const changed = new Set<string>()
    await this._database.withTransaction(async (database) => {
      for (const [peerId, folderId] of unique) {
        if ((existing.get(peerId)?.folderId === 1 ? 1 : 0) === folderId) continue
        changed.add(peerId)
        // Telegram pins are per folder: moving a dialog drops its pin.
        await writePeerRow(database, platformSessionId, peerId, folderId, null)
      }
    })
    return changed
  }

  /** Pinned peers of every folder, in pinned order. */
  async pinnedPeerIds(platformSessionId: string): Promise<string[]> {
    const rows = (await this._database.get('mtproto_dialog_folder_peer', { platformSessionId }))
      .filter((row) => row.pinnedOrder != null)
    return rows.sort((left, right) => left.pinnedOrder! - right.pinnedOrder!
      || left.platformConversationId.localeCompare(right.platformConversationId))
      .map((row) => row.platformConversationId)
  }

  /** Pins a peer above every other pinned dialog, or unpins it. Returns whether anything changed. */
  async setPeerPinned(platformSessionId: string, peerId: string, pinned: boolean): Promise<boolean> {
    return this._database.withTransaction(async (database) => {
      const rows = await database.get('mtproto_dialog_folder_peer', { platformSessionId })
      const existing = rows.find((row) => row.platformConversationId === peerId)
      if ((existing?.pinnedOrder != null) === pinned) return false
      const orders = rows.flatMap((row) => row.pinnedOrder == null ? [] : [row.pinnedOrder])
      const pinnedOrder = pinned ? (orders.length ? Math.min(...orders) - 1 : 0) : null
      await writePeerRow(database, platformSessionId, peerId, existing?.folderId ?? 0, pinnedOrder)
      return true
    })
  }

  /**
   * Replaces the order of one folder's pinned peers. `previous` is that
   * folder's current pinned list; with `force`, peers missing from `order` are
   * unpinned, otherwise they keep their relative order after it.
   */
  async reorderPinnedPeers(
    platformSessionId: string,
    order: readonly string[],
    previous: readonly string[],
    force: boolean,
  ): Promise<string[]> {
    const requested = [...new Set(order)]
    const kept = force ? [] : previous.filter((peerId) => !requested.includes(peerId))
    const next = [...requested, ...kept]
    const removed = previous.filter((peerId) => !next.includes(peerId))
    await this._database.withTransaction(async (database) => {
      const touched = [...next, ...removed]
      const existing = new Map((touched.length
        ? await database.get('mtproto_dialog_folder_peer', {
            platformSessionId, platformConversationId: { $in: touched },
          })
        : []).map((row) => [row.platformConversationId, row]))
      for (const [pinnedOrder, peerId] of next.entries()) {
        await writePeerRow(database, platformSessionId, peerId, existing.get(peerId)?.folderId ?? 0, pinnedOrder)
      }
      for (const peerId of removed) {
        await writePeerRow(database, platformSessionId, peerId, existing.get(peerId)?.folderId ?? 0, null)
      }
    })
    return next
  }
}

/** A row only exists while it carries state: an archived folder or a pin. */
async function writePeerRow(
  database: Database,
  platformSessionId: string,
  peerId: string,
  folderId: 0 | 1 | number,
  pinnedOrder: number | null,
): Promise<void> {
  if (folderId === 0 && pinnedOrder === null) {
    await database.remove('mtproto_dialog_folder_peer', {
      platformSessionId, platformConversationId: peerId,
    })
    return
  }
  await database.upsert('mtproto_dialog_folder_peer', [{
    id: peerKey(platformSessionId, peerId), platformSessionId,
    platformConversationId: peerId, folderId, pinnedOrder, updatedAt: new Date(),
  }])
}

export function encodeDialogFilterTitle(title: tl.TypeTextWithEntities): JsonValue {
  return encodeTlValue(title)
}

export function decodeDialogFilterTitle(title: JsonValue): tl.TypeTextWithEntities {
  return decodeTlValue(title) as tl.TypeTextWithEntities
}

function filterKey(platformSessionId: string, filterId: number): string {
  return JSON.stringify([platformSessionId, filterId])
}

function peerKey(platformSessionId: string, platformConversationId: string): string {
  return JSON.stringify([platformSessionId, platformConversationId])
}

function encodeTlValue(value: unknown): JsonValue {
  if (Long.isLong(value)) {
    return { $tl: 'long', value: value.toString(), unsigned: value.unsigned }
  }
  if (value instanceof Uint8Array) {
    return { $tl: 'bytes', value: Buffer.from(value).toString('base64') }
  }
  if (Array.isArray(value)) return value.map(encodeTlValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, encodeTlValue(item)]))
  }
  if (value === undefined) return null
  return value as JsonValue
}

function decodeTlValue(value: JsonValue): unknown {
  if (Array.isArray(value)) return value.map(decodeTlValue)
  if (value && typeof value === 'object') {
    if (value.$tl === 'long' && typeof value.value === 'string') {
      return Long.fromString(value.value, value.unsigned === true)
    }
    if (value.$tl === 'bytes' && typeof value.value === 'string') {
      return new Uint8Array(Buffer.from(value.value, 'base64'))
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeTlValue(item)]))
  }
  return value
}
