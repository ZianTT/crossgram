import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Long from 'long'
import { defineModels } from './models.js'
import {
  decodeDialogFilterTitle, DialogFolderStore, encodeDialogFilterTitle,
  type StoredDialogFilter,
} from './dialog-folders.js'

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createStore() {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return { ctx, store: new DialogFolderStore(ctx.database) }
}

function filter(title: string, peerId: string): StoredDialogFilter {
  return {
    kind: 'dialogFilter', groups: true, excludeArchived: true,
    title: encodeDialogFilterTitle({
      _: 'textWithEntities', text: title,
      entities: [{
        _: 'messageEntityCustomEmoji', offset: 0, length: 1, documentId: Long.fromNumber(42),
      }],
    }),
    pinnedPeerIds: [peerId], includePeerIds: [peerId], excludePeerIds: [],
  }
}

describe('DialogFolderStore', () => {
  it('persists filters, exact rich titles, deletion, and default-tab ordering', async () => {
    const { ctx, store } = await createStore()
    await expect(store.listFilters('session')).resolves.toEqual([{ filterId: 0 }])

    await store.putFilter('session', 2, filter('A', 'group-a'))
    await store.putFilter('session', 3, filter('B', 'group-b'))
    await expect(store.reorderFilters('session', [3, 0, 2, 999, 3])).resolves.toEqual([3, 0, 2])

    const resumed = new DialogFolderStore(ctx.database)
    const stored = await resumed.listFilters('session')
    expect(stored.map((entry) => entry.filterId)).toEqual([3, 0, 2])
    expect(decodeDialogFilterTitle(stored[0].filter!.title)).toEqual({
      _: 'textWithEntities', text: 'B',
      entities: [{
        _: 'messageEntityCustomEmoji', offset: 0, length: 1, documentId: Long.fromNumber(42),
      }],
    })

    await resumed.removeFilter('session', 3)
    expect((await store.listFilters('session')).map((entry) => entry.filterId)).toEqual([0, 2])
  })

  it('archives and unarchives peers atomically and reports only real changes', async () => {
    const { ctx, store } = await createStore()
    await expect(store.setPeerFolders('session', [
      { peerId: 'group-a', folderId: 1 },
      { peerId: 'group-b', folderId: 1 },
      { peerId: 'group-a', folderId: 1 },
    ])).resolves.toEqual(new Set(['group-a', 'group-b']))
    await expect(store.archivedPeerIds('session')).resolves.toEqual(new Set(['group-a', 'group-b']))

    const resumed = new DialogFolderStore(ctx.database)
    await expect(resumed.setPeerFolders('session', [
      { peerId: 'group-a', folderId: 1 },
      { peerId: 'group-b', folderId: 0 },
    ])).resolves.toEqual(new Set(['group-b']))
    await expect(store.archivedPeerIds('session')).resolves.toEqual(new Set(['group-a']))
  })

  it('pins peers newest-first, reorders them, and keeps folder rows independent', async () => {
    const { ctx, store } = await createStore()
    await expect(store.pinnedPeerIds('session')).resolves.toEqual([])
    await expect(store.setPeerPinned('session', 'group-a', true)).resolves.toBe(true)
    await expect(store.setPeerPinned('session', 'group-b', true)).resolves.toBe(true)
    await expect(store.setPeerPinned('session', 'group-a', true)).resolves.toBe(false)
    await expect(store.pinnedPeerIds('session')).resolves.toEqual(['group-b', 'group-a'])
    await expect(store.pinnedPeerIds('other-session')).resolves.toEqual([])

    await expect(store.reorderPinnedPeers('session', ['group-a', 'group-c', 'group-a'], ['group-b', 'group-a'], false))
      .resolves.toEqual(['group-a', 'group-c', 'group-b'])
    const resumed = new DialogFolderStore(ctx.database)
    await expect(resumed.pinnedPeerIds('session')).resolves.toEqual(['group-a', 'group-c', 'group-b'])

    await expect(resumed.reorderPinnedPeers('session', ['group-b'], ['group-a', 'group-c', 'group-b'], true))
      .resolves.toEqual(['group-b'])
    await expect(resumed.pinnedPeerIds('session')).resolves.toEqual(['group-b'])
    await expect(resumed.setPeerPinned('session', 'group-b', false)).resolves.toBe(true)
    await expect(resumed.setPeerPinned('session', 'group-b', false)).resolves.toBe(false)
    await expect(resumed.pinnedPeerIds('session')).resolves.toEqual([])
    // Unpinned rows outside an archive carry no state and are removed.
    await expect(ctx.database.get('mtproto_dialog_folder_peer', { platformSessionId: 'session' }))
      .resolves.toEqual([])
  })

  it('keeps archived pins in the archive and drops a pin when its peer changes folder', async () => {
    const { ctx, store } = await createStore()
    await store.setPeerFolders('session', [{ peerId: 'group-a', folderId: 1 }])
    await store.setPeerPinned('session', 'group-a', true)
    await expect(store.archivedPeerIds('session')).resolves.toEqual(new Set(['group-a']))
    await expect(store.pinnedPeerIds('session')).resolves.toEqual(['group-a'])

    await store.setPeerPinned('session', 'group-a', false)
    await expect(store.archivedPeerIds('session')).resolves.toEqual(new Set(['group-a']))

    await store.setPeerPinned('session', 'group-a', true)
    await store.setPeerPinned('session', 'group-b', true)
    await expect(store.setPeerFolders('session', [
      { peerId: 'group-a', folderId: 0 },
      { peerId: 'group-b', folderId: 0 },
    ])).resolves.toEqual(new Set(['group-a']))
    await expect(store.pinnedPeerIds('session')).resolves.toEqual(['group-b'])
    await expect(ctx.database.get('mtproto_dialog_folder_peer', { platformSessionId: 'session' }))
      .resolves.toMatchObject([{ platformConversationId: 'group-b', folderId: 0, pinnedOrder: expect.any(Number) }])
  })
})
