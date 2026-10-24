import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildRecordingDocument, createRecordingId, isRecordingId, normalizeRecordingLabel,
  RecordingError, RecordingStore, recordingAttachmentFileName, recordingFileName,
  RECORDING_FORMAT, RECORDING_VERSION, resolveConfiguredPath, slugifyRecordingLabel,
} from './recordings.js'
import type { CapturedMtprotoEvent } from './types.js'

const temporaryDirectories: string[] = []

async function temporaryStore(maxRecordings = 50) {
  const directory = await mkdtemp(join(tmpdir(), 'crossgram-recordings-'))
  temporaryDirectories.push(directory)
  return { directory, store: new RecordingStore(directory, maxRecordings) }
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

function event(id: number): CapturedMtprotoEvent {
  return {
    id,
    timestamp: 1_700_000_000_000 + id,
    direction: 'client->server',
    phase: 'message',
    connectionId: 'conn-1',
    name: 'messages.sendMessage',
    messageId: '0x' + id.toString(16),
    payload: { _: 'messages.sendMessage', peer: { userId: id }, message: 'hello-' + id },
    searchText: 'private-search-' + id,
  }
}

function input(events: CapturedMtprotoEvent[], label?: unknown) {
  return { events, capturing: true, dropped: 2, maxEvents: 2_000, ...(label === undefined ? {} : { label }) }
}

async function expectRecordingError(promise: Promise<unknown>, status: number, message?: RegExp) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(RecordingError)
  expect((error as RecordingError).status).toBe(status)
  if (message) expect((error as RecordingError).message).toMatch(message)
  return error as RecordingError
}

const stamp = Date.UTC(2026, 9, 20, 10, 5, 0, 123)

describe('MTProto capture recordings', () => {
  it('creates timestamped, filesystem-safe recording ids', () => {
    const id = createRecordingId(stamp, () => 'abcdef')
    expect(id).toBe('mtproto-20261020-100500-123-abcdef')
    expect(isRecordingId(id)).toBe(true)
    expect(isRecordingId('mtproto-20261020-100500-123-abcde')).toBe(false)
    expect(isRecordingId('../etc/passwd')).toBe(false)
    expect(isRecordingId('current')).toBe(false)
    expect(() => createRecordingId(Date.now(), () => 'not-hex')).toThrow(/Invalid recording id/)
  })

  it('normalizes labels and rejects non-string or oversized labels', () => {
    expect(normalizeRecordingLabel(undefined)).toBeUndefined()
    expect(normalizeRecordingLabel('   ')).toBeUndefined()
    expect(normalizeRecordingLabel('  Nightly\u0000  repro\n case ')).toBe('Nightly repro case')
    expect(normalizeRecordingLabel('x'.repeat(120))).toHaveLength(120)
    expect(() => normalizeRecordingLabel('x'.repeat(121))).toThrow(/at most 120/)
    expect(() => normalizeRecordingLabel(42)).toThrow(/must be a string/)
  })

  it('slugs labels into a safe file name fragment', () => {
    expect(slugifyRecordingLabel('Nightly repro case')).toBe('Nightly-repro-case')
    expect(slugifyRecordingLabel('  spaced   out  ')).toBe('spaced-out')
    expect(slugifyRecordingLabel('a/b\\c:d')).toBe('a-b-c-d')
    expect(slugifyRecordingLabel('keep.Dots_and-dashes1')).toBe('keep.Dots_and-dashes1')
    expect(slugifyRecordingLabel('UPPER stays UPPER')).toBe('UPPER-stays-UPPER')
    // Anything unsafe collapses into separators, which are then trimmed away.
    expect(slugifyRecordingLabel('../evil"\n.json')).toBe('evil-.json')
    expect(slugifyRecordingLabel('..hidden..')).toBe('hidden')
    expect(slugifyRecordingLabel('!!!')).toBe('')
    expect(slugifyRecordingLabel('---...')).toBe('')
    expect(slugifyRecordingLabel('保留中文')).toBe('')
    expect(slugifyRecordingLabel('')).toBe('')
    // Cap at 64 characters, then re-trim the cut edge.
    expect(slugifyRecordingLabel('x'.repeat(100))).toBe('x'.repeat(64))
    expect(slugifyRecordingLabel('a'.repeat(63) + '-b')).toBe('a'.repeat(63))
  })

  it('builds labelled file names and sanitizes the /current attachment name', () => {
    const id = 'mtproto-20261020-100500-123-abcdef'
    expect(recordingFileName(undefined, id)).toBe(id + '.json')
    expect(recordingFileName('', id)).toBe(id + '.json')
    expect(recordingFileName('!!!', id)).toBe(id + '.json')
    expect(recordingFileName('Nightly repro', id)).toBe(`Nightly-repro-${id}.json`)

    expect(recordingAttachmentFileName(undefined, stamp)).toBe('mtproto-capture-20261020-100500.json')
    expect(recordingAttachmentFileName('', stamp)).toBe('mtproto-capture-20261020-100500.json')
    expect(recordingAttachmentFileName('Nightly repro', stamp)).toBe('Nightly-repro-20261020-100500.json')
    const hostile = recordingAttachmentFileName('../evil"\n.json', stamp)
    expect(hostile).toBe('evil-.json-20261020-100500.json')
    for (const name of [hostile, recordingAttachmentFileName('a/b"c\r\nd', stamp)]) {
      expect(name).not.toMatch(/["'/\r\n]/)
      expect(name).toMatch(/^[A-Za-z0-9._-]+$/)
    }
  })

  it('builds the same self-describing document the store writes', () => {
    const events = [event(1)]
    const document = buildRecordingDocument({
      createdAt: stamp,
      label: '  Nightly   repro ',
      capturing: false,
      dropped: 3,
      maxEvents: 10,
      events,
    })
    expect(document).toEqual({
      format: RECORDING_FORMAT,
      version: RECORDING_VERSION,
      createdAt: stamp,
      label: 'Nightly repro',
      capturing: false,
      dropped: 3,
      maxEvents: 10,
      events: [event(1)],
    })
    // The caller's buffer must not be aliased by the document.
    events.push(event(2))
    expect(document.events).toHaveLength(1)

    const unlabelled = buildRecordingDocument({
      createdAt: stamp,
      capturing: true,
      dropped: 0,
      maxEvents: 10,
      events: [],
    })
    expect(unlabelled).not.toHaveProperty('label')
    expect(unlabelled.format).toBe(RECORDING_FORMAT)
    expect(unlabelled.version).toBe(RECORDING_VERSION)
  })

  it('writes a self-describing recording and its listing metadata', async () => {
    const { directory, store } = await temporaryStore()
    const summary = await store.save(input([event(1), event(2)], '  Nightly   repro '), stamp)

    expect(summary.id).toMatch(/^mtproto-20261020-100500-123-[0-9a-f]{6}$/)
    expect(summary).toMatchObject({
      label: 'Nightly repro',
      fileName: `Nightly-repro-${summary.id}.json`,
      createdAt: stamp,
      eventCount: 2,
      dropped: 2,
      maxEvents: 2_000,
      firstTimestamp: 1_700_000_000_001,
      lastTimestamp: 1_700_000_000_002,
    })
    expect(summary.bytes).toBeGreaterThan(0)

    const text = await readFile(join(directory, summary.fileName), 'utf8')
    expect(Buffer.byteLength(text)).toBe(summary.bytes)
    const recording = JSON.parse(text)
    expect(recording).toMatchObject({
      format: RECORDING_FORMAT,
      version: RECORDING_VERSION,
      createdAt: stamp,
      label: 'Nightly repro',
      capturing: true,
      dropped: 2,
      maxEvents: 2_000,
    })
    expect(recording.events).toHaveLength(2)
    expect(recording.events[0]).toMatchObject({
      name: 'messages.sendMessage',
      payload: { message: 'hello-1' },
      searchText: 'private-search-1',
    })
    const meta = JSON.parse(await readFile(join(directory, summary.id + '.meta.json'), 'utf8'))
    expect(meta).toEqual(summary)
    expect(meta.fileName).toBe(summary.fileName)
    expect(await store.list()).toEqual([summary])
    expect(await store.fileName(summary.id)).toBe(summary.fileName)
    expect(await store.readText(summary.id)).toBe(text)
  })

  it('keeps distinct files when two labels slug to the same value', async () => {
    const { directory, store } = await temporaryStore()
    const first = await store.save(input([event(1)], 'Nightly repro'), stamp)
    const second = await store.save(input([event(2)], 'Nightly/repro'), stamp + 1_000)

    expect(first.id).not.toBe(second.id)
    expect(first.fileName).toBe(`Nightly-repro-${first.id}.json`)
    expect(second.fileName).toBe(`Nightly-repro-${second.id}.json`)
    expect(first.fileName).not.toBe(second.fileName)
    expect((await readdir(directory)).sort()).toEqual([
      first.fileName, first.id + '.meta.json',
      second.fileName, second.id + '.meta.json',
    ].sort())
    expect(await store.readText(first.id)).toContain('hello-1')
    expect(await store.readText(second.id)).toContain('hello-2')
    expect((await store.list()).map(item => item.fileName)).toEqual([second.fileName, first.fileName])
  })

  it('exposes the absolute recordings directory', async () => {
    const { directory, store } = await temporaryStore()
    expect(store.directory).toBe(resolve(directory))
    expect(isAbsolute(store.directory)).toBe(true)
    expect(new RecordingStore('./relative-recordings').directory).toBe(resolve('relative-recordings'))
  })

  it('lists newest first, reads, downloads and deletes recordings', async () => {
    const { directory, store } = await temporaryStore()
    const older = await store.save(input([event(1)], 'first run'), stamp)
    const newer = await store.save(input([event(2), event(3)]), stamp + 1_000)

    expect((await store.list()).map(item => item.id)).toEqual([newer.id, older.id])
    expect((await store.read(newer.id)).events.map(item => item.id)).toEqual([2, 3])
    expect(await store.readText(older.id)).toContain('hello-1')

    // Unlabelled and labelled recordings resolve through the meta sidecar.
    expect(newer.fileName).toBe(newer.id + '.json')
    expect(older.fileName).toBe(`first-run-${older.id}.json`)

    await store.remove(older.id)
    const files = (await readdir(directory)).sort()
    expect(files).toEqual([newer.fileName, newer.id + '.meta.json'].sort())
    await expectRecordingError(store.read(older.id), 404, /not found/)
    await expectRecordingError(store.remove(older.id), 404, /not found/)
    await expectRecordingError(store.read('../secret'), 400, /Invalid recording id/)
    await expectRecordingError(store.fileName('../secret'), 400, /Invalid recording id/)
  })

  it('prunes the oldest recordings past the retained limit', async () => {
    const { directory, store } = await temporaryStore(2)
    const first = await store.save(input([event(1)]), stamp)
    const second = await store.save(input([event(2)]), stamp + 1_000)
    const third = await store.save(input([event(3)]), stamp + 2_000)

    expect((await store.list()).map(item => item.id)).toEqual([third.id, second.id])
    await expectRecordingError(store.read(first.id), 404, /not found/)
    expect((await readdir(directory)).sort()).toEqual([
      second.fileName, second.id + '.meta.json',
      third.fileName, third.id + '.meta.json',
    ].sort())
  })

  it('refuses to save an empty capture', async () => {
    const { store } = await temporaryStore()
    await expectRecordingError(store.save(input([])), 409, /No captured events/)
  })

  it('skips corrupt listing metadata instead of breaking the list', async () => {
    const { directory, store } = await temporaryStore()
    const summary = await store.save(input([event(1)]))
    await writeFile(join(directory, 'mtproto-20261020-100500-123-abcdef.meta.json'), '{not json')
    await writeFile(join(directory, 'mtproto-20261020-100500-124-abcdef.meta.json'), JSON.stringify(summary))
    expect(await store.list()).toEqual([summary])
  })

  it('resolves legacy metas without fileName and rejects escaping names', async () => {
    const { directory, store } = await temporaryStore()
    const id = 'mtproto-20261020-100500-123-abcdef'
    const recording = {
      format: RECORDING_FORMAT,
      version: RECORDING_VERSION,
      createdAt: 1,
      capturing: true,
      dropped: 0,
      maxEvents: 10,
      events: [],
    }
    await writeFile(join(directory, id + '.json'), JSON.stringify(recording))
    const legacy = { id, createdAt: 1, eventCount: 0, dropped: 0, maxEvents: 10, bytes: 5 }
    await writeFile(join(directory, id + '.meta.json'), JSON.stringify(legacy))
    expect(await store.list()).toEqual([{ ...legacy, fileName: id + '.json' }])
    expect(await store.fileName(id)).toBe(id + '.json')
    expect((await store.read(id)).format).toBe(RECORDING_FORMAT)

    // A tampered meta must never escape the recordings directory.
    const escaped = { ...legacy, fileName: '../escape.json' }
    await writeFile(join(directory, id + '.meta.json'), JSON.stringify(escaped))
    expect(await store.fileName(id)).toBe(id + '.json')
    expect((await store.read(id)).format).toBe(RECORDING_FORMAT)
    expect(await store.list()).toEqual([{ ...escaped, fileName: id + '.json' }])

    await store.remove(id)
    expect(await readdir(directory)).toEqual([])
  })

  it('rejects files that are not recordings', async () => {
    const { directory, store } = await temporaryStore()
    const id = 'mtproto-20261020-100500-123-abcdef'
    await writeFile(join(directory, id + '.json'), '{broken')
    await expectRecordingError(store.read(id), 500, /not valid JSON/)
    await writeFile(join(directory, id + '.json'), JSON.stringify({ format: 'other', events: [] }))
    await expectRecordingError(store.read(id), 500, /unsupported format/)
  })

  it('resolves configured recording paths against the config base URL', () => {
    expect(resolveConfiguredPath(undefined, './data/recordings')).toBe(resolve('data/recordings'))
    expect(resolveConfiguredPath('http://example.test/app.yml', './data/recordings')).toBe(resolve('data/recordings'))
    const base = pathToFileURL(join(process.cwd(), 'app.yml')).href
    expect(resolveConfiguredPath(base, './data/recordings')).toBe(resolve('data/recordings'))
    const absolute = resolve('data/elsewhere')
    expect(resolveConfiguredPath(undefined, absolute)).toBe(absolute)
  })
})
