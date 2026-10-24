import { describe, expect, it } from 'vitest'
import { formatClock, formatLogTime, joinPath } from './page.js'

describe('capture page formatting', () => {
  it('formats log clock times with millisecond precision', () => {
    const timestamp = new Date(2026, 0, 2, 3, 4, 5, 6).getTime()
    expect(formatClock(timestamp)).toBe('03:04:05.006')
    expect(formatClock(timestamp, false)).toBe('03:04:05')
  })
  it('formats saved log timestamps without milliseconds', () => {
    const timestamp = new Date(2026, 11, 31, 23, 59, 58, 123).getTime()
    expect(formatLogTime(timestamp)).toBe('2026-12-31 23:59:58')
  })
  it('joins file names onto POSIX and Windows directories', () => {
    expect(joinPath('/var/lib/crossgram/logs', 'a.json')).toBe(
      '/var/lib/crossgram/logs/a.json',
    )
    expect(joinPath('/var/lib/crossgram/logs/', 'a.json')).toBe(
      '/var/lib/crossgram/logs/a.json',
    )
    expect(joinPath('D:\\data\\logs', 'a.json')).toBe(
      'D:\\data\\logs\\a.json',
    )
    expect(joinPath('D:\\data\\logs\\', 'a.json')).toBe(
      'D:\\data\\logs\\a.json',
    )
  })
})
