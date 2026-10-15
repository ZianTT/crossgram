import type { IMConversationMember, IMConversationRole, IMUser } from '@mtproto-relay/bridge'
import { stableId } from '@mtproto-relay/bridge'

/** Telegram 频道/超级群 `chatId` 的 `-100` 前缀偏移量。 */
export const TELEGRAM_CHANNEL_OFFSET = 1_000_000_000_000

export const MAX_STABLE_ID = 0x7ffffffe

export function telegramChannelId(value: string | number): number | undefined {
  const text = String(value).trim()
  if (!/^-\d+$/u.test(text)) return
  const chatId = Number(text)
  if (!Number.isSafeInteger(chatId) || chatId >= -TELEGRAM_CHANNEL_OFFSET) return
  const channelId = -chatId - TELEGRAM_CHANNEL_OFFSET
  return channelId > 0 && channelId <= MAX_STABLE_ID ? channelId : undefined
}

export function telegramChannelIdFor(platformSessionId: string, platformConversationId: string): number {
  return stableId(`peer:${platformSessionId}:${platformConversationId}`)
}

/** 判断配置的群选择器（平台会话 ID 或 `-100…` Telegram `chatId`）是否匹配当前平台会话。 */
export function conversationIdMatches(
  configured: string | number,
  platformSessionId: string,
  platformConversationId: string,
): boolean {
  const raw = String(configured).trim()
  if (!raw || !platformConversationId) return false
  if (raw === platformConversationId) return true
  const channelId = telegramChannelId(raw)
  return channelId !== undefined && telegramChannelIdFor(platformSessionId, platformConversationId) === channelId
}

export interface KickCandidate {
  userId: string
  name: string
  account?: string
  role: IMConversationRole
  /** 最新发言的 Unix 秒级时间戳；`0` 表示从未在 relay 记录中发言。 */
  lastSpokeAt: number
}

export type UnknownLastSpoke = 'oldest' | 'newest'

export interface RankOptions {
  selfUserId?: string
  protectAdministrators?: boolean
  unknownLastSpoke?: UnknownLastSpoke
}

export function rankSilentMembers(
  members: readonly IMConversationMember<unknown>[],
  lastSpokeAt: ReadonlyMap<string, number>,
  options: RankOptions = {},
): KickCandidate[] {
  const protectedRoles = new Set<IMConversationRole>(['owner'])
  if (options.protectAdministrators !== false) protectedRoles.add('administrator')
  const unknownsLast = options.unknownLastSpoke === 'newest'
  const ranked: KickCandidate[] = []
  for (const member of members) {
    const userId = member.user?.id
    if (!userId || userId === options.selfUserId) continue
    if (protectedRoles.has(member.role)) continue
    ranked.push({
      userId,
      name: displayName(member.user),
      ...(member.user.username ? { account: member.user.username } : {}),
      role: member.role,
      lastSpokeAt: lastSpokeAt.get(userId) ?? 0,
    })
  }
  return ranked.sort((left, right) => {
    if (left.lastSpokeAt !== right.lastSpokeAt) {
      if (unknownsLast && (!left.lastSpokeAt || !right.lastSpokeAt)) {
        return left.lastSpokeAt ? -1 : 1
      }
      return left.lastSpokeAt - right.lastSpokeAt
    }
    return left.userId.localeCompare(right.userId)
  })
}

export interface KickBudget {
  total: number
  targetMembers: number
  maxKicksPerRound: number
}

export function kickBudget(budget: KickBudget): number {
  const wanted = Math.floor(budget.total) - Math.floor(budget.targetMembers)
  if (!Number.isFinite(wanted) || wanted <= 0) return 0
  return Math.max(0, Math.min(wanted, Math.floor(budget.maxKicksPerRound)))
}

export function planKicks(
  ranked: readonly KickCandidate[],
  budget: KickBudget,
): KickCandidate[] {
  return ranked.slice(0, Math.min(kickBudget(budget), ranked.length))
}

function displayName(user: IMUser<unknown>): string {
  return [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.id
}
