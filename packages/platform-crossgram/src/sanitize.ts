import type { WireConversation, WireEvent, WireMessage, WireRequest, WireServiceAction } from './protocol.js'

/**
 * QQNT carries text QQ copied from a person: nicknames, remarks, message
 * bodies, forward titles, service notice wording. PostgreSQL stores no NUL
 * (`U+0000`) and no UTF-16 surrogate without its partner in a `text`, `json`
 * or `jsonb` column, and an event is persisted as a whole: one such unit in
 * one of those strings fails the event, the durable checkpoint never advances,
 * and the same event replays forever while every later event waits behind it.
 *
 * The units are replaced where the wire data is received, before any other
 * step reads it, and each one becomes a single `.` instead of disappearing: a
 * text part's entities measure `offset`/`length` in code units of that text,
 * so replacing one code unit with one code unit keeps every offset QQ sent
 * valid and nothing has to be re-measured.
 *
 * Only the named fields below are cleaned, and each one is a string QQ copies
 * from a person rather than a protocol value: ids, peer ids, URLs, MIME types,
 * locators, enum values and entity offsets are left exactly as sent.
 */

/**
 * NUL, or a surrogate without its partner. A valid pair is one code point
 * outside the surrogate range, so an emoji stays an emoji.
 */
const UNSTORABLE_UNIT = /\u0000|[\uD800-\uDFFF]/gu

/** Replace every code unit PostgreSQL cannot store, preserving the length. */
export function sanitizeWireText(text: string): string {
  return text.replace(UNSTORABLE_UNIT, '.')
}

/** Clean the named string fields of `value`, leaving every other field alone. */
function sanitizeFields<T extends object>(value: T, keys: readonly (keyof T & string)[]): T {
  let output: Record<string, unknown> | undefined
  for (const key of keys) {
    const item = value[key]
    if (typeof item !== 'string') continue
    const clean = sanitizeWireText(item)
    if (clean === item) continue
    output ??= { ...value } as Record<string, unknown>
    output[key] = clean
  }
  return (output as T | undefined) ?? value
}

type WirePart = WireMessage['parts'][number]

function sanitizeWirePart(part: WirePart): WirePart {
  switch (part.type) {
    case 'text':
      // Entities keep the offsets and lengths QQ measured on this same text,
      // which the one-code-unit-for-one-code-unit replacement leaves correct.
      return sanitizeFields(part, ['text'])
    case 'markdown':
      return sanitizeFields(part, ['content'])
    case 'multi-forward':
      return sanitizeFields(part, ['title', 'preview'])
    case 'card': {
      const card = sanitizeFields(part.card, ['title', 'description'])
      return card === part.card ? part : { ...part, card }
    }
    case 'sticker': {
      const sticker = sanitizeFields(part.sticker, ['title'])
      return sticker === part.sticker ? part : { ...part, sticker }
    }
    case 'media': {
      const media = sanitizeFields(part.media, ['name', 'transcript'])
      return media === part.media ? part : { ...part, media }
    }
    // A keyboard is a bot's protocol payload, not text a person typed.
    case 'inline-keyboard':
      return part
  }
}

function sanitizeServiceAction(action: WireServiceAction): WireServiceAction {
  if (action.type === 'custom') return sanitizeFields(action, ['text'])
  if (action.type !== 'members-joined') return action
  const named = sanitizeFields(action, ['text'])
  const members = action.members.map((member) => sanitizeFields(member, ['name']))
  const actor = action.actor && sanitizeFields(action.actor, ['name'])
  const membersChanged = members.some((member, index) => member !== action.members[index])
  if (named === action && !membersChanged && actor === action.actor) return action
  return {
    ...named,
    ...(membersChanged ? { members } : {}),
    ...(actor === action.actor ? {} : { actor }),
  } as WireServiceAction
}

/** A message: the sender's nickname and remark, and everything the message carries as text. */
export function sanitizeWireMessage(message: WireMessage): WireMessage {
  const sender = message.sender && sanitizeFields(message.sender, ['name', 'alias'])
  const parts = message.parts.map(sanitizeWirePart)
  const partsChanged = parts.some((part, index) => part !== message.parts[index])
  const serviceAction = message.serviceAction && sanitizeServiceAction(message.serviceAction)
  if (sender === message.sender && !partsChanged && serviceAction === message.serviceAction) return message
  return {
    ...message,
    sender,
    ...(partsChanged ? { parts } : {}),
    ...(serviceAction === message.serviceAction ? {} : { serviceAction }),
  }
}

/** A conversation: its title, which is a group's name or a contact's remark. */
export function sanitizeWireConversation(conversation: WireConversation): WireConversation {
  return sanitizeFields(conversation, ['title'])
}

/** A friend or group request: the requester's name, the group's name and the note they wrote. */
export function sanitizeWireRequest(request: WireRequest): WireRequest {
  const requester = sanitizeFields(request.requester, ['name'])
  const group = request.group && sanitizeFields(request.group, ['name'])
  const message = request.message === undefined ? undefined : sanitizeWireText(request.message)
  if (requester === request.requester && group === request.group && message === request.message) return request
  return {
    ...request,
    requester,
    ...(group === request.group ? {} : { group }),
    ...(message === request.message ? {} : { message }),
  }
}

/** A profile: the nickname and signature carried by a contact, member or user lookup. */
export function sanitizeWireUser<T extends { name: string, alias?: string, signature?: string }>(user: T): T {
  return sanitizeFields(user, ['name', 'alias', 'signature'])
}

/** Every event QQNT delivers, cleaned before the stream reads any field of it. */
export function sanitizeWireEvent<Event extends WireEvent>(event: Event): Event {
  if (event.type === 'native-avsdk') return event
  if (event.type === 'request') {
    const request = sanitizeWireRequest(event.request)
    return (request === event.request ? event : { ...event, request }) as Event
  }
  const conversation = sanitizeWireConversation(event.conversation)
  let cleaned: Event = conversation === event.conversation ? event : { ...event, conversation }
  if (cleaned.type === 'message' || cleaned.type === 'message-edit') {
    const message = sanitizeWireMessage(cleaned.message)
    if (message !== cleaned.message) cleaned = { ...cleaned, message }
  } else if (cleaned.type === 'voice-transcript') {
    const transcript = sanitizeWireText(cleaned.transcript)
    if (transcript !== cleaned.transcript) cleaned = { ...cleaned, transcript }
  }
  return cleaned
}
