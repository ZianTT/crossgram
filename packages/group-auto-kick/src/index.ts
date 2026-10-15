import type { Context, Logger } from 'cordis'
import { Service } from 'cordis'
import z from 'schemastery'
import { $ } from '@cordisjs/plugin-database'
import type {
  ActivePlatformSession, IMConversationMember, IMMessageContent, IMPlatform, PlatformSession,
} from '@mtproto-relay/bridge'
import {
  conversationIdMatches,
  planKicks,
  rankSilentMembers,
  type KickCandidate,
  type UnknownLastSpoke,
} from './plan.js'

export * from './plan.js'

export const name = 'group-auto-kick'

export const inject = ['imPlatform', 'database']

/** 单群监控规则。`conversationId` 支持平台会话 ID（QQ 群号）或投影后的 Telegram 群 `chatId`（`-100…`）。 */
export interface GroupRule {
  conversationId: string | number
  label?: string
  platformSessionId?: string
  maxMembers?: number
  targetMembers?: number
  maxKicksPerRound?: number
  protectAdministrators?: boolean
  /** 从未发言成员的排序策略：`oldest`（默认）优先踢出，`newest` 排在已测得沉默时长的成员之后。 */
  unknownLastSpoke?: UnknownLastSpoke
  rejectAddRequest?: boolean
}

export interface Config {
  groups?: GroupRule[]
  dryRun?: boolean
  intervalMs?: number
  startupDelayMs?: number
  kickIntervalMs?: number
  rankingTtlMs?: number
  memberPageSize?: number
  maxMemberScan?: number
  scanDeadlineMs?: number
  maxRankingScan?: number
}

export const Config: z<Config> = z.object({
  groups: z.array(z.object({
    conversationId: z.union([z.string(), z.number()]).required()
      .description('平台会话 ID（QQ 群号）或 Telegram 群 chat id（-100…）。'),
    label: z.string().description('仅用于日志的群名，默认取会话标题。'),
    platformSessionId: z.string().description('限定某个平台会话，默认对所有在线会话生效。'),
    maxMembers: z.natural().default(2000)
      .description('达到该人数时开始踢人。与 targetMembers 配成同一数值即把群稳定在该人数。'),
    targetMembers: z.natural().default(1995)
      .description('一轮踢人后要降到的人数，不得大于 maxMembers；两者相等时只踢掉超出阈值的部分。'),
    maxKicksPerRound: z.natural().default(10)
      .description('单轮最多踢出多少人。'),
    protectAdministrators: z.boolean().default(true)
      .description('保护管理员（群主始终受保护）。'),
    unknownLastSpoke: z.union([z.const('oldest'), z.const('newest')]).default('oldest')
      .description('relay 记录中从未发言的成员排序：oldest 视为最久未发言（默认），newest 排在最后。'),
    rejectAddRequest: z.boolean().default(false)
      .description('同时拒绝被踢成员再次加群。'),
  })).default([]),
  dryRun: z.boolean().default(false)
    .description('只记录将要踢出的成员，不真正执行。'),
  intervalMs: z.natural().role('ms').default(5 * 60 * 1000)
    .description('巡检间隔。'),
  startupDelayMs: z.natural().role('ms').default(30 * 1000)
    .description('启动后（以及平台会话上线后）首次巡检的延迟。'),
  kickIntervalMs: z.natural().role('ms').default(1000)
    .description('同一轮内两次踢人之间的间隔。'),
  rankingTtlMs: z.natural().role('ms').default(30 * 60 * 1000)
    .description('“最后发言时间”排行的缓存时长。'),
  memberPageSize: z.natural().min(1).default(500)
    .description('扫描群成员时分页请求的条数。'),
  maxMemberScan: z.natural().min(1).default(5000)
    .description('单次扫描群成员的上限。'),
  scanDeadlineMs: z.natural().role('ms').default(60 * 1000)
    .description('单次扫描群成员的超时时间。'),
  maxRankingScan: z.natural().min(1).default(2_000_000)
    .description('回退扫描消息时的行数上限。'),
})

/** 队首候选人在排行快照之后又有新发言时，向后多预留的替补候选人数。 */
const STALE_LOOKAHEAD = 20

const DEFAULTS = {
  dryRun: false,
  intervalMs: 5 * 60 * 1000,
  startupDelayMs: 30 * 1000,
  kickIntervalMs: 1000,
  rankingTtlMs: 30 * 60 * 1000,
  memberPageSize: 500,
  maxMemberScan: 5000,
  scanDeadlineMs: 60 * 1000,
  maxRankingScan: 2_000_000,
  maxMembers: 2000,
  targetMembers: 1995,
  maxKicksPerRound: 10,
  unknownLastSpoke: 'oldest',
} as const

export interface GroupAutoKickResult {
  rule: string
  platformSessionId: string
  conversationId: string
  title: string
  total: number
  scanned: number
  partial: boolean
  dryRun: boolean
  planned: KickCandidate[]
  kicked: KickCandidate[]
  /** 在排行快照生成后又有新发言而被跳过的候选人。 */
  skippedStale: KickCandidate[]
  failures: Array<{ userId: string, error: string }>
  skipped?: 'no-session' | 'unresolved' | 'invalid' | 'below-threshold' | 'scan-failed'
  reason: string
}

export class GroupAutoKickService extends Service {
  constructor(ctx: Context, readonly runner: GroupAutoKickRunner) {
    super(ctx, 'groupAutoKick')
  }

  run(reason = 'manual'): Promise<GroupAutoKickResult[]> {
    return this.runner.run(reason)
  }

  invalidate(): void {
    this.runner.invalidate()
  }
}

declare module 'cordis' {
  interface Context {
    groupAutoKick: GroupAutoKickService
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const logger = ctx.logger('group-auto-kick')
  const rules = normalizeRules(config, (message) => logger.error('%s', message))
  if (!rules.length) {
    logger.info('未配置任何群，插件保持空闲')
    return
  }
  const runner = new GroupAutoKickRunner(ctx, config)
  new GroupAutoKickService(ctx, runner)
  logger.info('已启用：%s', rules.map(describeRule).join('；'))

  const intervalMs = config.intervalMs ?? DEFAULTS.intervalMs
  const startupDelayMs = config.startupDelayMs ?? DEFAULTS.startupDelayMs
  let pending: ReturnType<typeof setTimeout> | undefined
  const schedule = (reason: string, delay: number) => {
    if (pending !== undefined) return
    pending = setTimeout(() => {
      pending = undefined
      void runner.run(reason).catch((error) => logger.error('巡检失败：%s', errorText(error)))
    }, delay)
    unref(pending)
  }

  const interval = setInterval(() => schedule('interval', 0), intervalMs)
  unref(interval)
  const stopSessions = ctx.imPlatform.onSessionChange((event) => {
    if (event === 'activate') schedule('session', startupDelayMs)
  })
  schedule('startup', startupDelayMs)

  ctx.effect(() => () => {
    clearInterval(interval)
    if (pending !== undefined) clearTimeout(pending)
    pending = undefined
    void stopSessions()
    runner.dispose()
  }, 'group-auto-kick.timers')
}

export class GroupAutoKickRunner {
  private readonly logger: Logger
  private readonly rankings = new Map<string, { at: number, ranking: Map<string, number> }>()
  private readonly unresolved = new Set<string>()
  private running = false
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config = {},
  ) {
    this.logger = ctx.logger('group-auto-kick')
  }

  dispose(): void {
    this.disposed = true
    this.rankings.clear()
  }

  invalidate(): void {
    this.rankings.clear()
    this.unresolved.clear()
  }

  async run(reason = 'manual'): Promise<GroupAutoKickResult[]> {
    if (this.running || this.disposed) return []
    const rules = normalizeRules(this.config, (message) => this.logger.error('%s', message))
    if (!rules.length) return []
    this.running = true
    const results: GroupAutoKickResult[] = []
    try {
      for (const rule of rules) {
        const bindings = this.bindings(rule)
        if (!bindings.length) {
          results.push(emptyResult(rule, reason, { skipped: 'no-session' }))
          continue
        }
        for (const binding of bindings) {
          results.push(await this.round(rule, binding, reason))
        }
      }
    } finally {
      this.running = false
    }
    return results
  }

  private bindings(rule: GroupRule): ActivePlatformSession[] {
    return this.ctx.imPlatform.sessions.filter((binding) =>
      !rule.platformSessionId || binding.session.platformSessionId === rule.platformSessionId)
  }

  private async round(
    rule: GroupRule,
    binding: ActivePlatformSession,
    reason: string,
  ): Promise<GroupAutoKickResult> {
    const { platform, session } = binding
    const conversation = await this.resolve(rule, binding)
    if (!conversation) {
      const key = `${session.platformSessionId}\0${ruleKey(rule)}`
      if (!this.unresolved.has(key)) {
        this.unresolved.add(key)
        this.logger.error(
          '未在会话 %s 中找到群 %s，该规则保持等待',
          session.platformSessionId, ruleKey(rule),
        )
      }
      return emptyResult(rule, reason, { skipped: 'unresolved' })
    }
    this.unresolved.delete(`${session.platformSessionId}\0${ruleKey(rule)}`)
    const title = conversation.title || rule.label || conversation.platformConversationId
    const context = {
      platformSessionId: session.platformSessionId,
      conversationId: conversation.platformConversationId,
      title,
      dryRun: this.config.dryRun ?? DEFAULTS.dryRun,
    }

    const maxMembers = rule.maxMembers ?? DEFAULTS.maxMembers
    const targetMembers = rule.targetMembers ?? DEFAULTS.targetMembers
    const maxKicksPerRound = rule.maxKicksPerRound ?? DEFAULTS.maxKicksPerRound
    if (targetMembers > maxMembers) {
      this.logger.error(
        '群 %s 的配置无效：targetMembers(%d) 不得大于 maxMembers(%d)',
        title, targetMembers, maxMembers,
      )
      return emptyResult(rule, reason, { ...context, skipped: 'invalid' })
    }

    let scan: { members: IMConversationMember<unknown>[], partial: boolean } | undefined
    let total = await this.memberCount(platform, session, conversation.platformConversationId)
    if (total === undefined) {
      scan = await this.scanMembers(platform, session, conversation.platformConversationId)
      total = scan.members.length
    }
    if (!(total >= maxMembers)) {
      return emptyResult(rule, reason, { ...context, skipped: 'below-threshold', total })
    }
    scan ??= await this.scanMembers(platform, session, conversation.platformConversationId)
    if (!scan.members.length) {
      this.logger.error('群 %s 的成员列表为空，跳过本轮', title)
      return emptyResult(rule, reason, { ...context, skipped: 'scan-failed', total })
    }

    const ranking = await this.ranking(binding, conversation.id)
    // 入群视为一次活跃：邀请入群通知的 `sender` 是邀请人，需额外从通知内的 `members` 提取被邀请成员的入群时间。
    const joins = await this.joined(conversation.id)
    const ranked = rankSilentMembers(scan.members, mergeRanking(ranking, joins), {
      selfUserId: session.userId,
      protectAdministrators: rule.protectAdministrators ?? true,
      unknownLastSpoke: rule.unknownLastSpoke ?? DEFAULTS.unknownLastSpoke,
    })
    const planned = planKicks(ranked, { total, targetMembers, maxKicksPerRound })

    this.logger.info(
      '群 %s：共 %d 人（已扫描 %d），阈值 %d，计划踢出 %d 人%s',
      title, total, scan.members.length, maxMembers, planned.length, context.dryRun ? '（dry-run）' : '',
    )
    const kicked: KickCandidate[] = []
    const skippedStale: KickCandidate[] = []
    const failures: Array<{ userId: string, error: string }> = []
    const kickIntervalMs = this.config.kickIntervalMs ?? DEFAULTS.kickIntervalMs
    // 排行快照会缓存 `rankingTtlMs`，每次踢人前重新查询该候选人是否有新发言，避免误踢刚回群发言的成员。
    const candidates = context.dryRun
      ? planned
      : ranked.slice(0, Math.min(ranked.length, planned.length + STALE_LOOKAHEAD))
    for (const candidate of candidates) {
      if (!context.dryRun && kicked.length >= planned.length) break
      const label = describeCandidate(candidate)
      const lastSpoke = describeLastSpoke(candidate.lastSpokeAt)
      const spokeAt = await this.spokeSince(conversation.id, session.platformId, candidate)
      if (spokeAt !== undefined) {
        skippedStale.push(candidate)
        this.logger.info(
          '跳过 %s：排名快照（%s）之后又有新发言（%s）',
          label, lastSpoke, describeLastSpoke(spokeAt),
        )
        continue
      }
      if (context.dryRun) {
        this.logger.info('[dry-run] 将踢出 %s（最后活跃：%s）', label, lastSpoke)
        continue
      }
      try {
        await platform.moderateConversationMember(session, {
          id: conversation.platformConversationId,
        }, candidate.userId, {
          type: 'kick',
          ...(rule.rejectAddRequest ? { rejectAddRequest: true } : {}),
        })
        kicked.push(candidate)
        this.logger.info('已踢出 %s（最后活跃：%s）', label, lastSpoke)
      } catch (error) {
        failures.push({ userId: candidate.userId, error: errorText(error) })
        // 生产环境控制台日志过滤了 `warn`，踢人失败需用 `error` 级别输出。
        this.logger.error('踢出 %s 失败：%s', label, errorText(error))
      }
      if (kickIntervalMs > 0 && kicked.length < planned.length) await delay(kickIntervalMs)
    }
    if (!context.dryRun && planned.length) {
      this.logger.info(
        '群 %s：本轮踢出 %d/%d 人%s%s',
        title, kicked.length, planned.length,
        skippedStale.length ? `，跳过 ${skippedStale.length} 人（排行快照后又有活跃）` : '',
        failures.length ? `，${failures.length} 人失败` : '',
      )
    }

    return {
      rule: ruleKey(rule),
      ...context,
      total,
      scanned: scan.members.length,
      partial: scan.partial,
      planned,
      kicked,
      skippedStale,
      failures,
      reason,
    }
  }

  private async resolve(rule: GroupRule, binding: ActivePlatformSession): Promise<{
    id: number
    platformConversationId: string
    title: string
  } | undefined> {
    const rows = await this.ctx.database.get('mtproto_im_conversation', {
      platformSessionId: binding.session.platformSessionId,
    })
    for (const row of rows) {
      if (row.kind !== 'group') continue
      if (!conversationIdMatches(rule.conversationId, binding.session.platformSessionId, row.platformConversationId)) continue
      return { id: Number(row.id), platformConversationId: row.platformConversationId, title: row.title }
    }
  }

  private async memberCount(
    platform: IMPlatform,
    session: PlatformSession,
    conversationId: string,
  ): Promise<number | undefined> {
    try {
      const page = await platform.getConversationMembers(session, { id: conversationId }, { limit: 1 })
      const total = Number(page.total)
      return Number.isFinite(total) && total >= 0 ? total : undefined
    } catch (error) {
      this.logger.error('读取群 %s 人数失败：%s', conversationId, errorText(error))
      return undefined
    }
  }

  private async scanMembers(
    platform: IMPlatform,
    session: PlatformSession,
    conversationId: string,
  ): Promise<{ members: IMConversationMember<unknown>[], partial: boolean }> {
    const pageSize = this.config.memberPageSize ?? DEFAULTS.memberPageSize
    const maxMembers = this.config.maxMemberScan ?? DEFAULTS.maxMemberScan
    const deadline = Date.now() + (this.config.scanDeadlineMs ?? DEFAULTS.scanDeadlineMs)
    const members: IMConversationMember<unknown>[] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    let partial = false
    try {
      for (;;) {
        const page = await platform.getConversationMembers(session, { id: conversationId }, {
          ...(cursor ? { cursor } : {}),
          limit: Math.max(1, Math.min(pageSize, maxMembers - members.length)),
        })
        members.push(...page.members)
        const next = page.nextCursor
        if (!next || !page.members.length) break
        if (seenCursors.has(next)) {
          partial = true
          this.logger.warn('群 %s 的成员游标未推进，已停止扫描', conversationId)
          break
        }
        seenCursors.add(next)
        cursor = next
        if (members.length >= maxMembers) {
          partial = true
          this.logger.warn('群 %s 的成员数超过 %d，已停止扫描', conversationId, maxMembers)
          break
        }
        if (Date.now() > deadline) {
          partial = true
          this.logger.warn('群 %s 的成员扫描超时，已停止扫描', conversationId)
          break
        }
      }
    } catch (error) {
      this.logger.error('扫描群 %s 成员失败：%s', conversationId, errorText(error))
      return { members, partial: true }
    }
    return { members, partial }
  }

  /** 提取每个成员最新的入群通知时间戳，使重新加群的成员按最新入群时间参与排序。 */
  private async joined(conversationRowId: number): Promise<Map<string, number>> {
    const rows = await this.ctx.database.get('mtproto_im_message', {
      conversationId: conversationRowId,
      deleted: false,
      content: { serviceAction: { type: 'members-joined' } },
    }, { fields: ['id', 'timestamp', 'content'] })
    const joins = new Map<string, number>()
    for (const row of rows) {
      const action = (row.content as unknown as IMMessageContent | undefined)?.serviceAction
      if (action?.type !== 'members-joined') continue
      const at = Number(row.timestamp)
      if (!Number.isFinite(at) || at <= 0) continue
      for (const member of action.members) {
        const id = member?.id
        if (!id || at <= (joins.get(id) ?? 0)) continue
        joins.set(id, at)
      }
    }
    return joins
  }

  /** 检查候选人在排行快照的 `lastSpokeAt` 之后是否有更新的发言记录。 */
  private async spokeSince(
    conversationRowId: number,
    platformId: string,
    candidate: KickCandidate,
  ): Promise<number | undefined> {
    const users = await this.ctx.database.get('mtproto_im_user', {
      platformId,
      platformUserId: candidate.userId,
    }, { fields: ['id'], limit: 1 })
    const senderUserId = users.length ? Number(users[0]!.id) : NaN
    if (!Number.isFinite(senderUserId)) return
    const rows = await this.ctx.database.get('mtproto_im_message', {
      conversationId: conversationRowId,
      senderUserId,
      deleted: false,
      timestamp: { $gt: candidate.lastSpokeAt },
    }, { fields: ['timestamp'], sort: { timestamp: 'desc' }, limit: 1 })
    if (!rows.length) return
    const newest = Number(rows[0]!.timestamp)
    return Number.isFinite(newest) ? newest : undefined
  }

  private async ranking(binding: ActivePlatformSession, conversationRowId: number): Promise<Map<string, number>> {
    const key = rankKey(binding, conversationRowId)
    const ttl = this.config.rankingTtlMs ?? DEFAULTS.rankingTtlMs
    const cached = this.rankings.get(key)
    if (cached && Date.now() - cached.at < ttl) return cached.ranking
    const ranking = await this.computeRanking(binding.session, conversationRowId)
    this.rankings.set(key, { at: Date.now(), ranking })
    return ranking
  }

  private async computeRanking(session: PlatformSession, conversationRowId: number): Promise<Map<string, number>> {
    let bySender: Map<number, number>
    try {
      bySender = await this.aggregateLastSpoke(conversationRowId)
    } catch (error) {
      this.logger.warn('聚合最后发言时间失败，改用逐条扫描：%s', errorText(error))
      bySender = await this.scanLastSpoke(conversationRowId)
    }
    if (!bySender.size) return new Map()
    const userIds = [...bySender.keys()]
    const ranking = new Map<string, number>()
    for (let offset = 0; offset < userIds.length; offset += 500) {
      const batch = userIds.slice(offset, offset + 500)
      const users = await this.ctx.database.get('mtproto_im_user', {
        platformId: session.platformId,
        id: { $in: batch },
      })
      for (const user of users) {
        const lastSpokeAt = bySender.get(Number(user.id))
        if (lastSpokeAt !== undefined) ranking.set(user.platformUserId, lastSpokeAt)
      }
    }
    return ranking
  }

  private async aggregateLastSpoke(conversationRowId: number): Promise<Map<number, number>> {
    const rows = await this.ctx.database
      .select('mtproto_im_message', {
        conversationId: conversationRowId,
        deleted: false,
        timestamp: { $gt: 0 },
      })
      .groupBy('senderUserId', (row) => ({ lastAt: $.max(row.timestamp) }))
      .execute() as unknown as Array<{ senderUserId: number, lastAt: number | string | null }>
    const result = new Map<number, number>()
    for (const row of rows) {
      const lastAt = Number(row.lastAt)
      if (Number.isFinite(lastAt) && lastAt > 0) result.set(Number(row.senderUserId), lastAt)
    }
    return result
  }

  private async scanLastSpoke(conversationRowId: number): Promise<Map<number, number>> {
    const pageSize = 5000
    const maxRows = this.config.maxRankingScan ?? DEFAULTS.maxRankingScan
    const result = new Map<number, number>()
    for (let offset = 0; offset < maxRows; offset += pageSize) {
      const rows = await this.ctx.database.get('mtproto_im_message', {
        conversationId: conversationRowId,
        deleted: false,
        timestamp: { $gt: 0 },
      }, {
        fields: ['senderUserId', 'timestamp'],
        sort: { timestamp: 'desc' },
        limit: pageSize,
        offset,
      })
      if (!rows.length) break
      for (const row of rows) {
        const sender = Number(row.senderUserId)
        const timestamp = Number(row.timestamp)
        if (timestamp > 0 && !result.has(sender)) result.set(sender, timestamp)
      }
      if (rows.length < pageSize) break
    }
    return result
  }
}

function normalizeRules(config: Config, warn: (message: string) => void): GroupRule[] {
  const rules: GroupRule[] = []
  for (const [index, raw] of (config.groups ?? []).entries()) {
    if (raw?.conversationId === undefined || raw.conversationId === null || String(raw.conversationId).trim() === '') {
      warn(`第 ${index + 1} 条群规则缺少 conversationId，已忽略`)
      continue
    }
    const maxMembers = raw.maxMembers ?? DEFAULTS.maxMembers
    const targetMembers = raw.targetMembers ?? DEFAULTS.targetMembers
    if (targetMembers > maxMembers) {
      warn(`第 ${index + 1} 条群规则 (${ruleKey(raw)}) 的 targetMembers(${targetMembers}) 不得大于 maxMembers(${maxMembers})，已忽略`)
      continue
    }
    rules.push({
      ...raw,
      maxMembers,
      targetMembers,
      maxKicksPerRound: raw.maxKicksPerRound ?? DEFAULTS.maxKicksPerRound,
    })
  }
  return rules
}

function ruleKey(rule: GroupRule): string {
  return String(rule.conversationId).trim()
}

function rankKey(binding: ActivePlatformSession, conversationRowId: number): string {
  return `${binding.session.platformSessionId}\0${conversationRowId}`
}

/** 合并缓存的发言时间与最新入群通知时间（返回新 Map，不修改缓存）。 */
function mergeRanking(
  ranking: ReadonlyMap<string, number>,
  joins: ReadonlyMap<string, number>,
): Map<string, number> {
  const merged = new Map(ranking)
  for (const [userId, at] of joins) {
    if (at > (merged.get(userId) ?? 0)) merged.set(userId, at)
  }
  return merged
}

function describeRule(rule: GroupRule): string {
  const label = rule.label ? `${rule.label} ` : ''
  return `${label}${ruleKey(rule)}（${rule.maxMembers}/${rule.targetMembers}）`
}

function describeCandidate(candidate: KickCandidate): string {
  const account = candidate.account ? ` QQ ${candidate.account}` : ''
  return `${candidate.name}${account} [${candidate.userId}]`
}

function describeLastSpoke(lastSpokeAt: number): string {
  if (!lastSpokeAt) return 'relay 记录中从未发言'
  return new Date(lastSpokeAt * 1000).toISOString()
}

function emptyResult(
  rule: GroupRule,
  reason: string,
  extra: Partial<GroupAutoKickResult> & { skipped?: GroupAutoKickResult['skipped'] } = {},
): GroupAutoKickResult {
  return {
    rule: ruleKey(rule),
    platformSessionId: '',
    conversationId: '',
    title: rule.label ?? ruleKey(rule),
    total: 0,
    scanned: 0,
    partial: false,
    dryRun: false,
    planned: [],
    kicked: [],
    skippedStale: [],
    failures: [],
    reason,
    ...extra,
  }
}

function unref(timer: unknown): void {
  const candidate = timer as { unref?: () => void } | undefined
  if (typeof candidate?.unref === 'function') candidate.unref()
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    unref(timer)
  })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
