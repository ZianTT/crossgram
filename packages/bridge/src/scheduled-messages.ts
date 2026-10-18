import type { Database } from '@cordisjs/plugin-database'
import { CronJob } from 'cron'
import type {
  ScheduledMessageRow, ScheduledMessageStateRow,
} from './models.js'
import type { IMConversationKind, JsonValue } from './platform.js'

/** How long one dispatcher may hold a row before another pass may steal it. */
export const SCHEDULED_MESSAGE_LEASE_MS = 60_000
/**
 * Node timers cannot wait longer than 2^31-1 ms (about 24.8 days) and fire
 * immediately when they overflow, so long schedule dates are truncated and
 * re-armed when the truncated timer wakes.
 */
export const SCHEDULED_MESSAGE_MAX_DELAY_MS = 24 * 60 * 60 * 1_000
/** Retry delays after a failed send; the sixth failure parks the row. */
export const SCHEDULED_MESSAGE_RETRY_MS = [
  30_000, 120_000, 600_000, 3_600_000, 21_600_000, 86_400_000,
]
/** How often the safety sweep looks for rows the timer missed. */
export const SCHEDULED_MESSAGE_FALLBACK_MS = 120_000
/** Rows claimed by one pass; keeps one burst from blocking the event loop. */
export const SCHEDULED_MESSAGE_BATCH = 50

export type ScheduledMessageStatus = ScheduledMessageStateRow['status']

/** One scheduled message joined with its scheduling state. */
export interface ScheduledMessage extends ScheduledMessageRow {
  dueAt: number
  status: ScheduledMessageStatus
  attempts: number
  nextAttemptAt: number
  leaseOwner: string | null
  leaseUntil: number | null
  randomId: string
  sentTlMessageId: number | null
  lastError: string | null
}

export interface CreateScheduledMessageInput {
  platformSessionId: string
  platformConversationId: string
  conversationKind: IMConversationKind
  tlMessageId: number
  text: string
  entities?: JsonValue[] | null
  replyToMsgId?: number
  /** Absolute send time in Unix seconds. */
  dueAt: number
  randomId: string
}

/**
 * Durable half of scheduled messages.
 *
 * The message body and its scheduling state live in separate tables: editing a
 * body never touches the state machine, and retries/leases never rewrite the
 * body.
 */
export class ScheduledMessageStore {
  constructor(private readonly _database: Database) {}

  async create(input: CreateScheduledMessageInput): Promise<ScheduledMessage> {
    const now = new Date()
    return this._database.withTransaction(async (database) => {
      const message = await database.create('mtproto_scheduled_message', {
        platformSessionId: input.platformSessionId,
        platformConversationId: input.platformConversationId,
        conversationKind: input.conversationKind,
        tlMessageId: input.tlMessageId,
        text: input.text,
        entities: input.entities ?? null,
        replyToMsgId: input.replyToMsgId ?? null,
        createdAt: now,
      })
      await database.create('mtproto_scheduled_state', {
        messageId: message.id,
        dueAt: input.dueAt,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: input.dueAt,
        leaseOwner: null,
        leaseUntil: null,
        randomId: input.randomId,
        sentTlMessageId: null,
        lastError: null,
        updatedAt: now,
      })
      const [row] = await this._join(database, { messageId: message.id })
      return row
    })
  }

  async list(
    platformSessionId: string,
    platformConversationId: string,
  ): Promise<ScheduledMessage[]> {
    const states = await this._database.select('mtproto_scheduled_state').execute()
    const rows = await this._joinRows(states.filter((state) =>
      state.status !== 'sent' && state.status !== 'cancelled') as unknown as ScheduledMessageStateRow[])
    return rows.filter((row) => row.platformSessionId === platformSessionId
      && row.platformConversationId === platformConversationId)
  }

  async byTlIds(
    platformSessionId: string,
    platformConversationId: string,
    tlMessageIds: readonly number[],
  ): Promise<ScheduledMessage[]> {
    const wanted = new Set(tlMessageIds)
    return (await this.list(platformSessionId, platformConversationId))
      .filter((row) => wanted.has(row.tlMessageId))
  }

  async get(messageId: number): Promise<ScheduledMessage | undefined> {
    const [row] = await this._join(this._database, { messageId })
    return row
  }

  /** Earliest row that may still be sent, across every session. */
  async nextPending(now = Math.floor(Date.now() / 1_000)): Promise<ScheduledMessage | undefined> {
    const states = await this._database.select('mtproto_scheduled_state', { status: 'pending' })
      .execute()
    const rows = await this._joinRows(states as unknown as ScheduledMessageStateRow[])
    return rows.sort((left, right) => left.nextAttemptAt - right.nextAttemptAt)[0]
  }

  /** Rows due at `now`, oldest first. */
  async due(now: number, limit = SCHEDULED_MESSAGE_BATCH): Promise<ScheduledMessage[]> {
    const states = await this._database.select('mtproto_scheduled_state', { status: 'pending' })
      .execute()
    const rows = (await this._joinRows(states as unknown as ScheduledMessageStateRow[]))
      .filter((row) => row.nextAttemptAt <= now)
    return rows.sort((left, right) => left.nextAttemptAt - right.nextAttemptAt).slice(0, limit)
  }

  /**
   * Atomically move one due row to `sending`.
   *
   * A single conditional UPDATE is the portable lock: SQLite has no
   * `SELECT ... FOR UPDATE SKIP LOCKED`, and this statement is atomic on every
   * supported driver. `modified === 1` means this process won the row.
   */
  async claim(
    messageId: number,
    owner: string,
    now: number,
    leaseMs = SCHEDULED_MESSAGE_LEASE_MS,
  ): Promise<boolean> {
    // `@cordisjs/plugin-database` implements `set()` as SELECT-then-UPDATE, so
    // two in-process claimers can both observe the same row. Serialize claims
    // per database instance; the lease columns still guard crashed senders.
    return serializeClaim(this._database, () => this._claimUnlocked(messageId, owner, now, leaseMs))
  }

  private async _claimUnlocked(
    messageId: number,
    owner: string,
    now: number,
    leaseMs: number,
  ): Promise<boolean> {
    const claimLease = {
      status: 'sending' as const,
      leaseOwner: owner,
      leaseUntil: now + Math.ceil(leaseMs / 1_000),
      updatedAt: new Date(),
    }
    // Two single-statement conditional updates instead of one `$or`: each is a
    // plain `UPDATE ... WHERE` and therefore atomic on every driver.
    const due = await this._database.set('mtproto_scheduled_state', {
      messageId, status: 'pending', nextAttemptAt: { $lte: now },
    }, claimLease)
    if (writeCount(due) > 0) return true
    const expired = await this._database.set('mtproto_scheduled_state', {
      messageId, status: 'sending', leaseUntil: { $lt: now },
    }, claimLease)
    return writeCount(expired) > 0
  }

  async markSent(messageId: number, sentTlMessageId?: number): Promise<void> {
    await this._database.set('mtproto_scheduled_state', { messageId }, {
      status: 'sent',
      sentTlMessageId: sentTlMessageId ?? null,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
      updatedAt: new Date(),
    })
  }

  /** Put a row back for a later attempt (or park it after too many). */
  async reschedule(
    messageId: number,
    attempts: number,
    nextAttemptAt: number,
    status: ScheduledMessageStatus,
    error?: string,
  ): Promise<void> {
    await this._database.set('mtproto_scheduled_state', { messageId }, {
      status,
      attempts,
      nextAttemptAt,
      leaseOwner: null,
      leaseUntil: null,
      lastError: error ?? null,
      updatedAt: new Date(),
    })
  }

  async cancel(platformSessionId: string, platformConversationId: string, tlMessageId: number): Promise<boolean> {
    const [message] = await this._database.get('mtproto_scheduled_message', {
      platformSessionId, platformConversationId, tlMessageId,
    })
    if (!message) return false
    let modified = 0
    for (const status of ['pending', 'sending', 'failed'] as const) {
      const result = await this._database.set('mtproto_scheduled_state', {
        messageId: message.id, status,
      }, {
        status: 'cancelled', leaseOwner: null, leaseUntil: null, updatedAt: new Date(),
      })
      modified += writeCount(result)
    }
    return modified > 0
  }

  /** Rows whose lease expired while their sender was running (crash recovery). */
  async requeueExpired(now: number): Promise<number> {
    const result = await this._database.set('mtproto_scheduled_state', {
      status: 'sending',
      leaseUntil: { $lt: now },
    }, {
      status: 'pending', leaseOwner: null, leaseUntil: null, updatedAt: new Date(),
    })
    return writeCount(result)
  }

  private async _join(
    database: Database,
    query: { messageId: number },
  ): Promise<ScheduledMessage[]> {
    const [state] = await database.get('mtproto_scheduled_state', query)
    if (!state) return []
    return this._joinRows([state as unknown as ScheduledMessageStateRow])
  }

  private async _joinRows(states: ScheduledMessageStateRow[]): Promise<ScheduledMessage[]> {
    if (!states.length) return []
    const ids = new Set(states.map((state) => state.messageId))
    const byId = new Map((await this._database.select('mtproto_scheduled_message').execute())
      .filter((message) => ids.has(message.id))
      .map((message) => [message.id, message]))
    return states.flatMap((state): ScheduledMessage[] => {
      const message = byId.get(state.messageId)
      if (!message) return []
      return [{
        ...message,
        dueAt: state.dueAt,
        status: state.status,
        attempts: state.attempts,
        nextAttemptAt: state.nextAttemptAt,
        leaseOwner: state.leaseOwner,
        leaseUntil: state.leaseUntil,
        randomId: state.randomId,
        sentTlMessageId: state.sentTlMessageId,
        lastError: state.lastError,
      }]
    })
  }
}

const claimLocks = new WeakMap<object, Promise<void>>()

/** Run `fn` after every earlier claim on the same database settled. */
async function serializeClaim<T>(key: object, fn: () => Promise<T>): Promise<T> {
  const previous = claimLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  claimLocks.set(key, previous.then(() => current))
  await previous
  try {
    return await fn()
  } finally {
    release()
  }
}

export interface ScheduledDispatcherOptions {
  owner?: string
  fallbackMs?: number
  maxDelayMs?: number
  leaseMs?: number
  now?: () => number
  /** Injected in tests; production uses `cron` + `setTimeout`. */
  schedule?: (dueMs: number, callback: () => void) => () => void
}

/**
 * Arms one timer for the earliest due message and falls back to a periodic
 * sweep.
 *
 * Polling every second is unnecessary: the timer fires exactly at the due
 * second, and the sweep exists for restart, clock jumps and a throwing
 * callback. Both paths go through `claim()`, so they cannot double-send.
 */
export class ScheduledMessageDispatcher {
  private readonly _owner: string
  private readonly _fallbackMs: number
  private readonly _maxDelayMs: number
  private readonly _leaseMs: number
  private readonly _now: () => number
  private readonly _schedule: (dueMs: number, callback: () => void) => () => void
  private _cancelTimer?: () => void
  private _fallback?: ReturnType<typeof setInterval>
  private _armedAt?: number
  private _running = false
  private _stopped = false

  constructor(
    private readonly _store: ScheduledMessageStore,
    private readonly _send: (message: ScheduledMessage) => Promise<number | undefined>,
    options: ScheduledDispatcherOptions = {},
  ) {
    this._owner = options.owner ?? `scheduler-${process.pid}`
    this._fallbackMs = options.fallbackMs ?? SCHEDULED_MESSAGE_FALLBACK_MS
    this._maxDelayMs = options.maxDelayMs ?? SCHEDULED_MESSAGE_MAX_DELAY_MS
    this._leaseMs = options.leaseMs ?? SCHEDULED_MESSAGE_LEASE_MS
    this._now = options.now ?? (() => Date.now())
    this._schedule = options.schedule ?? defaultSchedule()
  }

  async start(): Promise<void> {
    if (this._running) return
    this._stopped = false
    this._running = true
    await this._store.requeueExpired(Math.floor(this._now() / 1_000))
    await this.rescan()
    this._fallback = setInterval(() => {
      void this.sweep().catch(() => undefined)
    }, this._fallbackMs)
    this._fallback.unref?.()
  }

  stop(): void {
    this._stopped = true
    this._running = false
    this._clearTimer()
    if (this._fallback) clearInterval(this._fallback)
    this._fallback = undefined
  }

  /**
   * Re-arm only when the new earliest row is earlier than the armed one.
   *
   * Re-arming on every change is harmless but wakes the process for nothing;
   * equal or later dates leave the current timer alone.
   */
  async rescan(): Promise<void> {
    if (this._stopped) return
    const next = await this._store.nextPending(this._dueNow())
    if (!next) {
      this._clearTimer()
      this._armedAt = undefined
      return
    }
    if (this._cancelTimer && this._armedAt !== undefined && this._armedAt <= next.nextAttemptAt) return
    this._arm(next)
  }

  /** Claim and send everything that is due, then re-arm. */
  async sweep(): Promise<void> {
    if (this._stopped) return
    this._clearTimer()
    this._armedAt = undefined
    const now = this._dueNow()
    const due = await this._store.due(now)
    for (const message of due) {
      if (this._stopped) break
      await this._dispatch(message, now)
    }
    await this.rescan()
  }

  private async _dispatch(message: ScheduledMessage, now: number): Promise<void> {
    const claimed = await this._store.claim(message.id, this._owner, now, this._leaseMs)
    if (!claimed) return
    try {
      const sentTlMessageId = await this._send(message)
      await this._store.markSent(message.id, sentTlMessageId)
    } catch (error) {
      const attempts = message.attempts + 1
      const retry = SCHEDULED_MESSAGE_RETRY_MS[Math.min(attempts - 1, SCHEDULED_MESSAGE_RETRY_MS.length - 1)]
      const retryAt = now + Math.ceil(retry / 1_000)
      const parked = attempts > SCHEDULED_MESSAGE_RETRY_MS.length
      await this._store.reschedule(
        message.id, attempts, parked ? now : retryAt,
        parked ? 'failed' : 'pending',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  private _arm(message: ScheduledMessage): void {
    this._clearTimer()
    this._armedAt = message.nextAttemptAt
    const delay = message.nextAttemptAt * 1_000 - this._now()
    if (delay > this._maxDelayMs) {
      // Re-arm when the truncated wait expires; the row is still in the future.
      const timer = setTimeout(() => { void this.sweep() }, this._maxDelayMs)
      timer.unref?.()
      this._cancelTimer = () => clearTimeout(timer)
      return
    }
    this._cancelTimer = this._schedule(this._now() + Math.max(0, delay), () => {
      this._cancelTimer = undefined
      this._armedAt = undefined
      void this.sweep()
    })
  }

  private _clearTimer(): void {
    this._cancelTimer?.()
    this._cancelTimer = undefined
    this._armedAt = undefined
  }

  private _dueNow(): number {
    return Math.floor(this._now() / 1_000)
  }
}

/**
 * Clamp one timer wait to what Node can represent.
 *
 * `setTimeout` fires immediately when the delay exceeds 2^31-1 ms, so a date
 * months away must be cut down and re-armed when the truncated wait expires.
 */
export function clampScheduleDelay(delayMs: number, maxMs = SCHEDULED_MESSAGE_MAX_DELAY_MS): number {
  if (!Number.isFinite(delayMs)) return maxMs
  return Math.min(Math.max(0, Math.trunc(delayMs)), maxMs)
}

/** Drivers report a conditional UPDATE as `matched` or `modified`. */
function writeCount(result: { modified?: number, matched?: number }): number {
  return result.modified ?? result.matched ?? 0
}

function defaultSchedule(): (dueMs: number, callback: () => void) => () => void {
  return (dueMs, callback) => {
    const delay = clampScheduleDelay(dueMs - Date.now())
    // Very short waits are not worth a cron job; `cron` also rounds dates to
    // whole seconds, which would make sub-second tests and immediate rows late.
    if (delay < 1_000) {
      const timer = setTimeout(callback, Math.max(0, delay))
      timer.unref?.()
      return () => clearTimeout(timer)
    }
    const job = CronJob.from({
      cronTime: new Date(dueMs),
      onTick: callback,
      start: true,
      unrefTimeout: true,
    })
    return () => job.stop()
  }
}
