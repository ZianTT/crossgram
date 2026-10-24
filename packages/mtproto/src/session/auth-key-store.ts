import {
  readFileSync, writeFileSync, writeSync, mkdirSync, existsSync, renameSync, openSync, fsyncSync, closeSync,
  ftruncateSync,
} from 'node:fs'
import { dirname } from 'node:path'

export class AuthKeyStorePublishedError extends Error {
  constructor(readonly cause: unknown, readonly phase: 'post-rename' | 'windows-journal') {
    super('auth key snapshot may have been published before durability failed')
  }
}

export interface StoredAuthKey {
  /** 256 字节 MTProto auth key */
  key: Uint8Array
  /** 临时 PFS key 所绑定的永久 auth_key_id */
  permanentKeyId?: Uint8Array
  /** 临时 key 的过期 Unix 时间戳（秒） */
  expiresAt?: number
  /** 永久 key 最近一次协商的 API layer */
  apiLayer?: number
}

export interface AuthKeyStore {
  get(id: Uint8Array): Promise<StoredAuthKey | undefined> | StoredAuthKey | undefined
  save(id: Uint8Array, record: StoredAuthKey): Promise<void> | void
  /** 在吊销永久 key 前写入持久化 tombstone，防止并发连接或崩溃恢复时重新启用旧 key */
  beginRevocation(id: Uint8Array): Promise<void> | void
  /** 清理被吊销的 key 及其绑定的临时 key，完成后移除 tombstone */
  finishRevocation(id: Uint8Array): Promise<boolean> | boolean
  /** 完成进程重启前未走完的吊销流程 */
  recoverPendingRevocations(): Promise<void> | void
  delete(id: Uint8Array): Promise<boolean> | boolean
}

function toHex(u: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u.length; i++) s += u[i].toString(16).padStart(2, '0')
  return s
}

function fromHex(s: string): Uint8Array {
  const u = new Uint8Array(s.length / 2)
  for (let i = 0; i < u.length; i++) u[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return u
}

export class MemoryAuthKeyStore implements AuthKeyStore {
  private _keys = new Map<string, StoredAuthKey>()
  private _revoked = new Set<string>()

  get(id: Uint8Array): StoredAuthKey | undefined {
    const idHex = toHex(id)
    const record = this._keys.get(idHex)
    if (this._revoked.has(idHex) || (record?.permanentKeyId && this._revoked.has(toHex(record.permanentKeyId)))) {
      return undefined
    }
    if (record?.expiresAt !== undefined && record.expiresAt <= Date.now() / 1000) {
      this._keys.delete(idHex)
      return undefined
    }
    return record
  }

  save(id: Uint8Array, record: StoredAuthKey): void {
    const idHex = toHex(id)
    const existing = this._keys.get(idHex)
    const permanentId = record.permanentKeyId
      ? toHex(record.permanentKeyId)
      : (existing?.permanentKeyId ? toHex(existing.permanentKeyId) : idHex)
    if (this._revoked.has(permanentId)) throw new Error('auth key is being revoked')
    this._keys.set(idHex, record)
  }

  beginRevocation(id: Uint8Array): void {
    this._revoked.add(toHex(id))
  }

  finishRevocation(id: Uint8Array): boolean {
    const idHex = toHex(id)
    let deleted = this._keys.delete(idHex)
    for (const [key, record] of this._keys) {
      if (record.permanentKeyId && toHex(record.permanentKeyId) === idHex) {
        this._keys.delete(key)
        deleted = true
      }
    }
    this._revoked.delete(idHex)
    return deleted
  }

  recoverPendingRevocations(): void {
    for (const id of [...this._revoked]) this.finishRevocation(fromHex(id))
  }

  delete(id: Uint8Array): boolean {
    this.beginRevocation(id)
    return this.finishRevocation(id)
  }
}

interface SerializedAuthKey {
  key: string
  permanentKeyId?: string
  expiresAt?: number
  apiLayer?: number
}

interface SerializedAuthKeyEnvelope {
  version: 1
  keys: Record<string, string | SerializedAuthKey>
  revoked: string[]
}

export interface FileAuthKeyStoreFileSystem {
  readFileSync: typeof readFileSync
  writeFileSync: typeof writeFileSync
  mkdirSync: typeof mkdirSync
  existsSync: typeof existsSync
  renameSync: typeof renameSync
  openSync: typeof openSync
  fsyncSync: typeof fsyncSync
  closeSync: typeof closeSync
  writeSync: typeof writeSync
  ftruncateSync: typeof ftruncateSync
}

const nativeFileSystem: FileAuthKeyStoreFileSystem = {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  writeSync,
  ftruncateSync,
}

function isEnvelope(value: unknown): value is SerializedAuthKeyEnvelope {
  return Boolean(value && typeof value === 'object'
    && (value as { version?: unknown }).version === 1
    && typeof (value as { keys?: unknown }).keys === 'object'
    && Array.isArray((value as { revoked?: unknown }).revoked))
}

/** 基于 JSON 文件的持久化存储，通过临时文件原子替换落盘后再更新内存状态 */
export class FileAuthKeyStore implements AuthKeyStore {
  private _keys = new Map<string, SerializedAuthKey>()
  private _revoked = new Set<string>()
  private _pendingRevocations = new Set<string>()

  constructor(
    private readonly _path: string,
    private readonly _fs: FileAuthKeyStoreFileSystem = nativeFileSystem,
    private readonly _platform: NodeJS.Platform = process.platform,
  ) {
    if (!_fs.existsSync(_path)) {
      if (this._platform === 'win32') this._loadWindowsJournal()
      return
    }
    try {
      const raw = JSON.parse(_fs.readFileSync(_path, 'utf-8')) as unknown
      const keys = isEnvelope(raw)
        ? raw.keys
        : raw as Record<string, string | SerializedAuthKey>
      for (const [id, value] of Object.entries(keys)) {
        // 兼容旧版直接将永久 key 存为裸 hex 字符串的格式
        this._keys.set(id, typeof value === 'string' ? { key: value } : value)
      }
      if (isEnvelope(raw)) this._revoked = new Set(raw.revoked)
    } catch {
      // 主快照损坏时忽略
    }
    if (this._platform === 'win32') this._loadWindowsJournal()
  }

  get(id: Uint8Array): StoredAuthKey | undefined {
    const idHex = toHex(id)
    const value = this._keys.get(idHex)
    if (!value || this._revoked.has(idHex) || (value.permanentKeyId && this._revoked.has(value.permanentKeyId))) {
      return undefined
    }
    if (value.expiresAt !== undefined && value.expiresAt <= Date.now() / 1000) return undefined
    return {
      key: fromHex(value.key),
      permanentKeyId: value.permanentKeyId ? fromHex(value.permanentKeyId) : undefined,
      expiresAt: value.expiresAt,
      apiLayer: value.apiLayer,
    }
  }

  save(id: Uint8Array, record: StoredAuthKey): void {
    const idHex = toHex(id)
    const existing = this._keys.get(idHex)
    const permanentId = record.permanentKeyId
      ? toHex(record.permanentKeyId)
      : existing?.permanentKeyId ?? idHex
    if (this._revoked.has(permanentId)) throw new Error('auth key is being revoked')
    const keys = new Map(this._keys)
    keys.set(idHex, {
      key: toHex(record.key),
      permanentKeyId: record.permanentKeyId ? toHex(record.permanentKeyId) : undefined,
      expiresAt: record.expiresAt,
      apiLayer: record.apiLayer,
    })
    this._commit(keys, new Set(this._revoked))
  }

  beginRevocation(id: Uint8Array): void {
    const idHex = toHex(id)
    if (this._platform === 'win32') {
      this._appendWindowsJournal('begin', idHex)
      this._revoked.add(idHex)
      this._pendingRevocations.add(idHex)
      try {
        this._commit(new Map(this._keys), new Set(this._revoked))
      } catch (error) {
        throw new AuthKeyStorePublishedError(error, 'windows-journal')
      }
      return
    }
    const revoked = new Set(this._revoked)
    revoked.add(idHex)
    this._commit(new Map(this._keys), revoked)
  }

  finishRevocation(id: Uint8Array): boolean {
    const idHex = toHex(id)
    const keys = new Map(this._keys)
    let deleted = keys.delete(idHex)
    for (const [key, record] of keys) {
      if (record.permanentKeyId === idHex) {
        keys.delete(key)
        deleted = true
      }
    }
    // 先在保留 tombstone 的前提下把删除后的 key 列表落盘，再清理 tombstone
    this._commit(keys, new Set(this._revoked))
    if (this._platform === 'win32') {
      this._appendWindowsJournal('done', idHex)
      this._pendingRevocations.delete(idHex)
      return deleted
    }
    const revoked = new Set(this._revoked)
    revoked.delete(idHex)
    this._commit(new Map(this._keys), revoked)
    return deleted
  }

  recoverPendingRevocations(): void {
    const pending = this._platform === 'win32' ? this._pendingRevocations : this._revoked
    for (const id of [...pending]) this.finishRevocation(fromHex(id))
  }

  delete(id: Uint8Array): boolean {
    this.beginRevocation(id)
    return this.finishRevocation(id)
  }

  private _commit(keys: Map<string, SerializedAuthKey>, revoked: Set<string>): void {
    this._flush(keys, revoked, () => {
      this._keys = keys
      this._revoked = revoked
    })
  }

  private _flush(
    keys: Map<string, SerializedAuthKey>,
    revoked: Set<string>,
    onPublished: () => void,
  ): void {
    this._fs.mkdirSync(dirname(this._path), { recursive: true })
    const temporaryPath = `${this._path}.tmp`
    const snapshot: SerializedAuthKeyEnvelope = {
      version: 1,
      keys: Object.fromEntries(keys),
      revoked: [...revoked],
    }
    const serialized = JSON.stringify(snapshot)
    this._fs.writeFileSync(temporaryPath, serialized)
    this._syncPath(temporaryPath)
    this._fs.renameSync(temporaryPath, this._path)
    onPublished()
    if (this._platform === 'win32') return
    try {
      this._syncPath(dirname(this._path))
    } catch (error) {
      throw new AuthKeyStorePublishedError(error, 'post-rename')
    }
  }

  private _loadWindowsJournal(): void {
    const path = `${this._path}.revocations`
    this._fs.mkdirSync(dirname(path), { recursive: true })
    this._syncWindowsJournal(path)
    const bytes = this._fs.readFileSync(path) as Buffer
    const lastNewline = bytes.lastIndexOf(0x0a)
    if (lastNewline + 1 < bytes.length) this._truncateWindowsJournal(path, lastNewline + 1)
    const complete = bytes.subarray(0, Math.max(0, lastNewline + 1)).toString('utf8')
    for (const line of complete.split('\n')) {
      if (!line) continue
      const match = /^v1 (begin|done) ([0-9a-f]{16})$/.exec(line)
      if (!match) throw new Error('invalid auth key revocation journal')
      const [, action, id] = match
      this._revoked.add(id!)
      if (action === 'begin') this._pendingRevocations.add(id!)
      else this._pendingRevocations.delete(id!)
    }
  }

  private _appendWindowsJournal(action: 'begin' | 'done', id: string): void {
    const path = `${this._path}.revocations`
    const event = Buffer.from(`v1 ${action} ${id}\n`)
    const fd = this._fs.openSync(path, 'a')
    try {
      let offset = 0
      while (offset < event.length) {
        const written = this._fs.writeSync(fd, event, offset, event.length - offset)
        if (written <= 0) throw new Error('auth key revocation journal write made no progress')
        offset += written
      }
      this._fs.fsyncSync(fd)
    } finally {
      this._fs.closeSync(fd)
    }
  }

  private _truncateWindowsJournal(path: string, length: number): void {
    const fd = this._fs.openSync(path, 'r+')
    try {
      this._fs.ftruncateSync(fd, length)
      this._fs.fsyncSync(fd)
    } finally {
      this._fs.closeSync(fd)
    }
  }

  private _syncWindowsJournal(path: string): void {
    const fd = this._fs.openSync(path, 'a')
    try {
      this._fs.fsyncSync(fd)
    } finally {
      this._fs.closeSync(fd)
    }
  }

  private _syncPath(path: string): void {
    // Windows 下对只读句柄调用 FlushFileBuffers/fsync 会报 EPERM，需以 r+ 打开临时文件
    const fd = this._fs.openSync(path, this._platform === 'win32' ? 'r+' : 'r')
    try {
      this._fs.fsyncSync(fd)
    } finally {
      this._fs.closeSync(fd)
    }
  }
}
