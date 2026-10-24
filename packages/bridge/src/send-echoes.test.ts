import { describe, expect, it } from 'vitest'
import { SendEchoes } from './send-echoes.js'
import type { IMMessage, PlatformSession } from './platform.js'

const session: PlatformSession = {
  platformSessionId: 'send-echoes', platformId: 'qq', userId: 'self',
  credentials: {}, metadata: {},
}
const otherSession: PlatformSession = { ...session, platformSessionId: 'send-echoes-other' }

function message(id: string, sourceIds?: string[]): IMMessage {
  return {
    id, sourceIds, conversationId: 'group', senderId: 'self', outgoing: true, timestamp: 1,
    content: { parts: [{ type: 'text', text: id }] },
  }
}

describe('SendEchoes', () => {
  it('binds the echoed platform message to the auth key that is sending it', () => {
    const echoes = new SendEchoes()
    echoes.bind(session.platformSessionId, ['native-1'], 'key-a')
    expect(echoes.excludeFor(session, message('native-1'))).toBe('key-a')
  })

  it('covers every part of a multi-part message', () => {
    const echoes = new SendEchoes()
    echoes.bind(session.platformSessionId, ['part-1', 'part-2'], 'key-a')
    expect(echoes.excludeFor(session, message('part-2', ['part-1']))).toBe('key-a')
  })

  it('leaves other own messages and other sessions alone', () => {
    const echoes = new SendEchoes()
    echoes.bind(session.platformSessionId, ['native-1'], 'key-a')
    expect(echoes.excludeFor(session, message('native-2'))).toBeUndefined()
    expect(echoes.excludeFor(otherSession, message('native-1'))).toBeUndefined()
  })

  it('stops excluding once the send delivered the message', () => {
    const echoes = new SendEchoes()
    echoes.bind(session.platformSessionId, ['native-1'], 'key-a')
    echoes.release(session.platformSessionId, ['native-1'])
    expect(echoes.excludeFor(session, message('native-1'))).toBeUndefined()
  })

  it('ignores a send without an auth key', () => {
    const echoes = new SendEchoes()
    echoes.bind(session.platformSessionId, ['native-1'], undefined)
    expect(echoes.excludeFor(session, message('native-1'))).toBeUndefined()
  })
})
