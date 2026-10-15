import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import Long from 'long'
import { DialogRpc } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import type { IMMessage, IMPlatform, PlatformSession } from './platform.js'

/**
 * A dialog page is the first place a client learns about a preview message, and
 * `getDialogs` documents that "PlatformDataService has already persisted any
 * previews exposed by getDialogs". When that assumption is momentarily false
 * (cold start, or a preview the platform reconciliation has not written yet) the
 * dialog must still publish an address that later requests can resolve. Before
 * this fix the dialog carried a process-local counter id instead, so the same
 * message ended up with two identities: the one the client cached and the
 * durable one assigned when the message was finally ingested.
 */

const session: PlatformSession = {
  platformSessionId: 'dialog-preview-session',
  platformId: 'dialog-preview',
  userId: 'self',
  credentials: {},
  metadata: {},
}

// A direct dialog so `messages.getMessages` is allowed to resolve the id for a
// peer without an explicit expected peer (group ids are scoped per channel).
const conversation = { id: 'preview-peer', kind: 'direct' as const, title: 'Preview peer' }

/** A preview QQ reports for a message the store has never projected. */
const preview: IMMessage = {
  id: 'unprojected-preview',
  conversationId: conversation.id,
  senderId: session.userId,
  timestamp: 1_785_000_000,
  content: { parts: [{ type: 'text', text: 'stored only by the dialog RPC' }] },
}

const platform: IMPlatform = {
  capabilities: {
    history: true,
    send: {
      text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0,
    },
    conversations: { groups: true, channels: false, subchannels: false },  },
  async subscribe() { return () => {} },
  async getDialogs() {
    return { dialogs: [{ conversation, unreadCount: 0, lastMessage: preview }], total: 1 }
  },
  async getHistory() { return { messages: [] } },
  async sendMessage() { throw new Error('send is disabled') },
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createStore(): Promise<MessageStore> {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return new MessageStore(ctx.database)
}

function getDialogsRequest(): tl.messages.RawGetDialogsRequest {
  return {
    _: 'messages.getDialogs', excludePinned: false, offsetDate: 0, offsetId: 0,
    offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
  }
}

function dialogsOf(result: Awaited<ReturnType<DialogRpc['getDialogs']>>): tl.RawDialog[] {
  return result._ === 'messages.dialogsNotModified' ? [] : result.dialogs as tl.RawDialog[]
}

describe('dialog preview projection', () => {
  it('persists an unprojected preview so the dialog publishes a resolvable durable id', async () => {
    const store = await createStore()
    expect(await store.findProjectedByPlatformId(
      session.platformSessionId, conversation.id, preview.id,
    )).toBeUndefined()

    const dialogs = dialogsOf(await new DialogRpc(platform, session, store).getDialogs(getDialogsRequest()))

    expect(dialogs).toHaveLength(1)
    const topMessage = dialogs[0].topMessage
    // A durable id is a bucket of the sixteen ids reserved per second, never the
    // 1, 2, 3 … process-local counter `_messageId` used to hand out.
    expect(topMessage).toBeGreaterThan(0)
    expect(topMessage % 16).toBe(0)
    // The published address resolves back to the message the preview named.
    const projected = await store.findProjectedByTlId(
      session.platformSessionId, topMessage, conversation.id,
    )
    expect(projected?.source.id).toBe(preview.id)
  })

  it('keeps the preview id stable across process-local device state', async () => {
    const store = await createStore()

    const first = dialogsOf(await new DialogRpc(platform, session, store).getDialogs(getDialogsRequest()))
    // A second instance stands in for the next process: the process-local
    // counter restarts at one, so only a durable id can survive.
    const second = dialogsOf(await new DialogRpc(platform, session, store).getDialogs(getDialogsRequest()))

    expect(first[0].topMessage).toBeGreaterThan(0)
    expect(second[0].topMessage).toBe(first[0].topMessage)
    expect(await store.findProjectedByTlId(
      session.platformSessionId, second[0].topMessage, conversation.id,
    )).toMatchObject({ source: { id: preview.id } })
  })

  it('resolves the published preview id through messages.getMessages', async () => {
    const store = await createStore()
    const rpc = new DialogRpc(platform, session, store)
    const topMessage = dialogsOf(await rpc.getDialogs(getDialogsRequest()))[0].topMessage

    const messages = await rpc.getMessages({
      _: 'messages.getMessages',
      id: [{ _: 'inputMessageID', id: topMessage }],
    })
    expect(messages._ === 'messages.messagesNotModified' ? [] : messages.messages).toMatchObject([
      { _: 'message', id: topMessage },
    ])
  })

  it('does not publish a process-local id for a preview whose message was recalled', async () => {
    const store = await createStore()
    // Persist the dialog and its preview, then recall the message. The durable
    // row survives as a tombstone, so every projection read misses while the
    // stored dialog row still matches what the platform reports.
    await store.ingestDialogs(session, [{ conversation, unreadCount: 0, lastMessage: preview }])
    await store.deleteMessages(session, conversation, [preview.id])
    expect(await store.findProjectedByPlatformId(
      session.platformSessionId, conversation.id, preview.id,
    )).toBeUndefined()

    const dialogs = dialogsOf(await new DialogRpc(platform, session, store).getDialogs(getDialogsRequest()))

    expect(dialogs).toHaveLength(1)
    // A durable id is one of the sixteen buckets reserved per second; the
    // process-local counter would hand out 1, 2, 3 … instead.
    expect(dialogs[0].topMessage % 16).toBe(0)
  })
})

// QQ only knows the read boundary once it has fetched an unread window, so the
// platform reports an unread dialog without one. `messages.getPeerDialogs` used
// to answer from the store, which dropped the boundary the store had already
// learned, publishing `read_inbox_max_id = 0` ("nothing was ever read"). A
// client then treats the whole dialog as unread: its unread separator lands at
// the beginning and opening the dialog jumps to the oldest loaded message.
describe('stored dialog read boundary', () => {
  const unreadConversation = { id: 'unread-peer', kind: 'direct' as const, title: 'Unread peer' }
  const boundary: IMMessage = {
    id: 'unread-boundary', conversationId: unreadConversation.id, senderId: 'alice', timestamp: 1_785_100_000,
    content: { parts: [{ type: 'text', text: 'read so far' }] },
  }
  const latest: IMMessage = {
    id: 'unread-latest', conversationId: unreadConversation.id, senderId: 'bob', timestamp: 1_785_100_100,
    content: { parts: [{ type: 'text', text: 'still unread' }] },
  }
  const unreadPlatform: IMPlatform = {
    ...platform,
    async getDialogs() {
      return {
        dialogs: [{ conversation: unreadConversation, unreadCount: 2, lastMessage: latest }],
        total: 1,
      }
    },
  }

  it('publishes the boundary the store already learned', async () => {
    const store = await createStore()
    await store.ingestDialogs(session, [{
      conversation: unreadConversation, unreadCount: 2, lastMessage: latest, readInboxMaxMessage: boundary,
    }])
    const rpc = new DialogRpc(unreadPlatform, session, store)
    const [listed] = dialogsOf(await rpc.getDialogs(getDialogsRequest()))
    const peer = listed.peer._ === 'peerUser'
      ? { _: 'inputPeerUser' as const, userId: listed.peer.userId, accessHash: Long.ZERO }
      : undefined
    expect(peer).toBeTruthy()

    const result = await rpc.getPeerDialogs({
      _: 'messages.getPeerDialogs', peers: [{ _: 'inputDialogPeer', peer: peer! }],
    })
    const dialog = result.dialogs[0] as tl.RawDialog

    expect(dialog).toMatchObject({ unreadCount: 2 })
    expect(dialog.readInboxMaxId).toBeGreaterThan(0)
    expect(dialog.readInboxMaxId).toBeLessThan(dialog.topMessage)
    expect(await store.findProjectedByTlId(
      session.platformSessionId, dialog.readInboxMaxId, unreadConversation.id,
    )).toMatchObject({ source: { id: boundary.id } })
  })
})
