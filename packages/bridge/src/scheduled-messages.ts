import type { Database } from '@cordisjs/plugin-database'
import { CronJob } from 'cron'
import type {
  ScheduledMessageRow, ScheduledMessageStateRow,
} from './models.js'
import type { IMConversationKind, JsonValue } from './platform.js'

/** 一个调度器持有某行的租约时长，超时后其他轮次可以抢占。 */
export const SCHEDULED_MESSAGE_LEASE_MS = 60_000
/**
 * 单个定时器的最长等待（24 小时）。Node 定时器最多只能等 2^31-1 ms（约 24.8 天），
 * 溢出会立即触发，所以较远的定时时间会被截断，截断的定时器醒来后再重新挂载。
 */
export const SCHEDULED_MESSAGE_MAX_DELAY_MS = 24 * 60 * 60 * 1_000
/** 发送失败后的重试间隔；第七次失败后把该行置为 failed 搁置。 */
export const SCHEDULED_MESSAGE_RETRY_MS = [
  30_000, 120_000, 600_000, 3_600_000, 21_600_000, 86_400_000,
]
/** 兜底扫描的间隔，用来捞回定时器漏掉的行。 */
export const SCHEDULED_MESSAGE_FALLBACK_MS = 120_000
/** 单轮最多认领的行数，避免一次突发堵住事件循环。 */
export const SCHEDULED_MESSAGE_BATCH = 50

export type ScheduledMessageStatus = ScheduledMessageStateRow['status']

/** 一条定时消息与其调度状态 join 后的结果。 */
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
  /** 绝对发送时间，Unix 秒。 */
  dueAt: number
  randomId: string
}

/**
 * 定时消息的持久化部分。
 *
 * 消息内容和调度状态分表存放：编辑内容不会碰状态机，重试/租约也不会改写内容。
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

  /** 所有会话中最早的、仍可能发送的行。 */
  async nextPending(now = Math.floor(Date.now() / 1_000)): Promise<ScheduledMessage | undefined> {
    const states = await this._database.select('mtproto_scheduled_state', { status: 'pending' })
      .execute()
    const rows = await this._joinRows(states as unknown as ScheduledMessageStateRow[])
    return rows.sort((left, right) => left.nextAttemptAt - right.nextAttemptAt)[0]
  }

  /** 在 `now` 时已到期的行，按时间从早到晚。 */
  async due(now: number, limit = SCHEDULED_MESSAGE_BATCH): Promise<ScheduledMessage[]> {
    const states = await this._database.select('mtproto_scheduled_state', { status: 'pending' })
      .execute()
    const rows = (await this._joinRows(states as unknown as ScheduledMessageStateRow[]))
      .filter((row) => row.nextAttemptAt <= now)
    return rows.sort((left, right) => left.nextAttemptAt - right.nextAttemptAt).slice(0, limit)
  }

  /**
   * 把一条到期的行切到 `sending`（认领）。
   *
   * 用条件 UPDATE 充当可移植的锁：SQLite 没有 `SELECT ... FOR UPDATE SKIP LOCKED`。
   * 写入计数大于 0 表示本进程抢到了这一行。
   */
  async claim(
    messageId: number,
    owner: string,
    now: number,
    leaseMs = SCHEDULED_MESSAGE_LEASE_MS,
  ): Promise<boolean> {
    // `@cordisjs/plugin-database` 的 `set()` 实现是先 SELECT 再 UPDATE，进程内两个认领者
    // 可能同时看到同一行。因此按数据库实例串行化认领；租约字段仍负责兜底崩溃的发送者。
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
    // 拆成两次条件更新而不是一个 `$or`：到期的 pending 行，以及租约已过期的 sending 行。
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

  /** 把一行放回去等待下次尝试（失败次数过多时搁置）。 */
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

  /** 把发送途中租约过期的行放回 pending（崩溃恢复）。 */
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

/** 等同一数据库上之前的认领全部结束后再执行 `fn`。 */
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
  /** 测试中注入；生产环境使用 `cron` + `setTimeout`。 */
  schedule?: (dueMs: number, callback: () => void) => () => void
}

/**
 * 只为最早到期的消息挂一个定时器，另有周期性扫描兜底。
 *
 * 不需要每秒轮询：定时器会在到期那一秒触发，扫描只负责重启、时钟跳变和回调抛错等情况。
 * 两条路径都经过 `claim()`，不会重复发送。
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
   * 只有新的最早行比当前已挂载的更早时才重新挂载。
   *
   * 每次变更都重挂虽然无害，但会白白唤醒进程；相同或更晚的时间保持当前定时器不动。
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

  /** 认领并发送所有到期的行，然后重新挂载。 */
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
      // 截断的等待结束后重新挂载；该行仍在未来。
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
 * 把单次定时器等待限制在 Node 能表示的范围内。
 *
 * 延迟超过 2^31-1 ms 时 `setTimeout` 会立即触发，所以几个月后的时间必须截断，
 * 等截断的等待结束后再重新挂载。
 */
export function clampScheduleDelay(delayMs: number, maxMs = SCHEDULED_MESSAGE_MAX_DELAY_MS): number {
  if (!Number.isFinite(delayMs)) return maxMs
  return Math.min(Math.max(0, Math.trunc(delayMs)), maxMs)
}

/** 不同驱动用 `matched` 或 `modified` 报告条件 UPDATE 的结果。 */
function writeCount(result: { modified?: number, matched?: number }): number {
  return result.modified ?? result.matched ?? 0
}

function defaultSchedule(): (dueMs: number, callback: () => void) => () => void {
  return (dueMs, callback) => {
    const delay = clampScheduleDelay(dueMs - Date.now())
    // 很短的等待不值得开 cron job；而且 `cron` 会把时间取整到秒，
    // 导致亚秒级的测试和需立即发送的行延迟。
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
