import { describe, expect, it } from 'vitest'
import {
  sanitizeWireConversation, sanitizeWireEvent, sanitizeWireMessage, sanitizeWireRequest, sanitizeWireText,
} from './sanitize.js'
import type { WireConversation, WireEvent, WireMessage, WireRequest, WireTextPart } from './protocol.js'

const locator = {
  messageId: 'message', elementId: 'element', chatType: 2 as const,
  peerUid: 'group', kind: 'file' as const, fileName: 'a\u0000b.bin',
}

const conversation: WireConversation = {
  id: 'group', kind: 'group', title: 'Group', peerUid: 'group', peerUin: '42', chatType: 2,
}

function textPart(message: WireMessage, index = 0): WireTextPart {
  const part = message.parts[index]
  if (part.type !== 'text') throw new Error('expected a text part')
  return part
}

describe('QQNT wire text sanitizing', () => {
  it('replaces a NUL and a lone surrogate with one dot each and leaves valid text alone', () => {
    expect(sanitizeWireText('a\u0000b')).toBe('a.b')
    expect(sanitizeWireText('a\uD800b')).toBe('a.b')
    expect(sanitizeWireText('a\uDC00b')).toBe('a.b')
    expect(sanitizeWireText('\u0000😀')).toBe('.😀')
    // A surrogate pair is one code point, not two unstorable surrogates.
    expect(sanitizeWireText('😀')).toBe('😀')
    expect(sanitizeWireText('plain')).toBe('plain')
  })

  it('keeps every replaced text exactly as long as it was', () => {
    for (const text of ['\u0000', 'x\u0000y', 'pre\uD800', 'a\uDC00\u0000b', '😀\uD800😀']) {
      expect(sanitizeWireText(text)).toHaveLength(text.length)
    }
  })

  it('leaves a mention range pointing at the same text after a NUL in the body', () => {
    const part = textPart(sanitizeWireMessage({
      id: 'message', conversationId: 'group', senderId: 'peer', timestamp: 1, outgoing: false,
      parts: [{
        type: 'text',
        text: '@alice\u0000 hello',
        entities: [{ type: 'mention', offset: 0, length: 6, userId: 'alice' }],
      }],
    }))
    expect(part).toMatchObject({
      text: '@alice. hello',
      entities: [{ type: 'mention', offset: 0, length: 6, userId: 'alice' }],
    })
    const entity = part.entities![0]
    expect(part.text.slice(entity.offset, entity.offset + entity.length)).toBe('@alice')
  })

  it('cleans the nickname and remark of a message sender', () => {
    const message = sanitizeWireMessage({
      id: 'message', conversationId: 'group', senderId: 'peer', timestamp: 1, outgoing: false,
      sender: { id: 'peer', numericId: '10001', name: 'Bad\u0000Name', alias: 're\uD800mark' },
      parts: [],
    })
    expect(message.sender).toMatchObject({
      id: 'peer', numericId: '10001', name: 'Bad.Name', alias: 're.mark',
    })
  })

  it('cleans the text a message carries, and nothing else', () => {
    const parts: WireMessage['parts'] = [
      { type: 'text', text: 'bo\u0000dy', entities: [{ type: 'qq-face', offset: 0, length: 2, faceId: '1', faceType: 1 }] },
      { type: 'markdown', content: '# head\uD800line' },
      { type: 'multi-forward', title: 'chats\u0000', preview: 'pre\u0000view', locator: {
        conversationId: 'group', rootMessageId: 'root',
      } },
      { type: 'card', card: {
        kind: 'link', title: 'a\u0000 title', description: 'de\u0000sc',
        url: 'https://example.com/\u0000', thumbnailUrl: 'https://example.com/t.png',
      } },
      { type: 'sticker', sticker: {
        stickerId: 'sticker', title: 'pack\u0000title', format: 'static', mimeType: 'image/png',
        reference: { kind: 'sysface', faceId: '1', faceType: 1, name: 'n', animated: true },
      } },
      { type: 'media', media: {
        id: 'media', kind: 'file', name: 'a\u0000b.bin', mimeType: 'application/octet-stream',
        transcript: 'said\uD800it', locator,
      } },
    ]
    const cleaned = sanitizeWireMessage({
      id: 'message', conversationId: 'group', senderId: 'peer', timestamp: 1, outgoing: false,
      sender: { id: 'peer', name: 'Name' },
      parts,
      serviceAction: { type: 'custom', text: 'joined\u0000the group' },
    })

    expect(cleaned.parts[0]).toEqual({
      type: 'text', text: 'bo.dy', entities: [{ type: 'qq-face', offset: 0, length: 2, faceId: '1', faceType: 1 }],
    })
    expect(cleaned.parts[1]).toEqual({ type: 'markdown', content: '# head.line' })
    expect(cleaned.parts[2]).toMatchObject({ title: 'chats.', preview: 'pre.view' })
    // A card's URL is a protocol value, not text QQ copied from a person.
    expect(cleaned.parts[3]).toEqual({
      type: 'card',
      card: {
        kind: 'link', title: 'a. title', description: 'de.sc',
        url: 'https://example.com/\u0000', thumbnailUrl: 'https://example.com/t.png',
      },
    })
    expect(cleaned.parts[4]).toMatchObject({ sticker: { title: 'pack.title', mimeType: 'image/png' } })
    expect(cleaned.parts[5]).toMatchObject({
      media: { name: 'a.b.bin', transcript: 'said.it', mimeType: 'application/octet-stream', locator },
    })
    expect(cleaned.serviceAction).toEqual({ type: 'custom', text: 'joined.the group' })
    expect(cleaned.id).toBe('message')
  })

  it('cleans the names a join notice carries beside its wording', () => {
    const cleaned = sanitizeWireMessage({
      id: 'message', conversationId: 'group', senderId: 'peer', timestamp: 1, outgoing: false, parts: [],
      serviceAction: {
        type: 'members-joined', text: 'A\u0000B joined',
        members: [{ id: 'a', name: 'Al\u0000ice' }, { id: 'b', name: 'Bob' }],
        actor: { id: 'a', name: 'Al\u0000ice' },
      },
    })
    expect(cleaned.serviceAction).toEqual({
      type: 'members-joined', text: 'A.B joined',
      members: [{ id: 'a', name: 'Al.ice' }, { id: 'b', name: 'Bob' }],
      actor: { id: 'a', name: 'Al.ice' },
    })
  })

  it('cleans a conversation title, which is a group name or a contact remark', () => {
    const cleaned = sanitizeWireConversation({ ...conversation, title: 'Gr\u0000oup\uD800' })
    expect(cleaned.title).toBe('Gr.oup.')
    expect(cleaned.id).toBe('group')
    expect(cleaned.chatType).toBe(2)
  })

  it('cleans a request note and both names it names', () => {
    const request: WireRequest = {
      id: 'request', kind: 'friend', status: 'pending',
      requester: { id: 'peer', name: 'Frie\u0000nd' },
      group: { id: 'group', name: 'Gr\u0000oup' },
      message: 'let me in\u0000',
      timestamp: 1,
    }
    expect(sanitizeWireRequest(request)).toMatchObject({
      id: 'request', kind: 'friend', status: 'pending',
      requester: { id: 'peer', name: 'Frie.nd' },
      group: { id: 'group', name: 'Gr.oup' },
      message: 'let me in.',
    })
  })

  it('cleans every event kind before the stream reads it', () => {
    const message: WireMessage = {
      id: 'message', conversationId: 'group', senderId: 'peer', timestamp: 1, outgoing: false,
      sender: { id: 'peer', name: 'Na\u0000me' },
      parts: [{ type: 'text', text: 'bo\u0000dy' }],
    }
    expect(sanitizeWireEvent({
      type: 'message', conversation: { ...conversation, title: 'Gr\u0000oup' }, message,
    })).toMatchObject({
      conversation: { title: 'Gr.oup' },
      message: { sender: { name: 'Na.me' }, parts: [{ text: 'bo.dy' }] },
    })
    expect(sanitizeWireEvent({
      type: 'message-edit', eventId: 'edit', conversation, message,
    })).toMatchObject({ message: { parts: [{ text: 'bo.dy' }] } })
    expect(sanitizeWireEvent({
      type: 'request',
      request: { id: 'request', kind: 'group-join', status: 'pending', requester: { id: 'peer', name: 'Na\u0000me' }, message: 'no\u0000te' },
    })).toMatchObject({ request: { requester: { name: 'Na.me' }, message: 'no.te' } })
    expect(sanitizeWireEvent({
      type: 'voice-transcript', eventId: 'voice', conversation, messageId: 'm', transcript: 'sa\u0000id', timestamp: 1,
    })).toMatchObject({ transcript: 'sa.id' })
    // An event that carries no text of its own is handed on untouched.
    const deletion: WireEvent = { type: 'message-delete', eventId: 'delete', conversation, messageIds: ['m'], timestamp: 1 }
    expect(sanitizeWireEvent(deletion)).toBe(deletion)
  })

  it('returns the event itself when nothing in it needed cleaning', () => {
    const message: WireMessage = {
      id: 'message', conversationId: 'group', senderId: 'peer', timestamp: 1, outgoing: false,
      sender: { id: 'peer', name: 'Name' }, parts: [{ type: 'text', text: 'body' }],
    }
    const event: WireEvent = { type: 'message', conversation, message }
    expect(sanitizeWireEvent(event)).toBe(event)
    expect(sanitizeWireConversation(conversation)).toBe(conversation)
    expect(sanitizeWireMessage(message)).toBe(message)
    const request: WireRequest = { id: 'r', kind: 'friend', status: 'pending', requester: { id: 'p', name: 'N' } }
    expect(sanitizeWireRequest(request)).toBe(request)
  })

  it('leaves an absent alias, request group and note absent', () => {
    const message = sanitizeWireMessage({
      id: 'message', conversationId: 'group', senderId: 'peer', timestamp: 1, outgoing: false,
      sender: { id: 'peer', name: 'Na\u0000me' }, parts: [],
    })
    expect(message.sender).not.toHaveProperty('alias')
    expect(sanitizeWireRequest({
      id: 'request', kind: 'friend', status: 'pending', requester: { id: 'peer', name: 'Na\u0000me' },
    })).not.toHaveProperty('group')
  })
})
