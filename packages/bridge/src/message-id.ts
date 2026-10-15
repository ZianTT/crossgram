import type { JsonObject, JsonValue } from './platform.js'

export const TELEGRAM_MESSAGE_ID_MAX = 0x7fffffff
export const TIMESTAMP_MESSAGE_ID_SLOTS = 16
export const TIMESTAMP_MESSAGE_ID_MAX_SECOND = Math.floor(
  (TELEGRAM_MESSAGE_ID_MAX - TIMESTAMP_MESSAGE_ID_SLOTS + 1) / TIMESTAMP_MESSAGE_ID_SLOTS,
)
export const TIMESTAMP_MESSAGE_ID_INITIAL_SECOND = 0x40000000 / TIMESTAMP_MESSAGE_ID_SLOTS

export function qqMessageSequenceFromMetadata(metadata?: JsonObject): number | undefined {
  return positiveSequence(metadata?.qqMsgSeq)
}

export function qqReplySequenceFromMetadata(metadata?: JsonObject): number | undefined {
  return positiveSequence(metadata?.qqReplyToMsgSeq)
    ?? (metadata?.qqMsgSeq === undefined ? undefined : positiveSequence(metadata.telegramReplyToMessageId))
}

/** 将首条消息的时间戳置于约 4.25 年的 int32 窗口正中。 */
export function initialTimestampMessageIdEpoch(timestamp: number): number {
  assertTimestamp(timestamp)
  return timestamp - TIMESTAMP_MESSAGE_ID_INITIAL_SECOND
}

/** 相对于作用域 epoch，每秒预留 16 个 Telegram 消息 ID 槽位。 */
export function timestampMessageIdBucket(epoch: number, timestamp: number): number {
  assertTimestamp(epoch)
  assertTimestamp(timestamp)
  const relativeSecond = timestamp - epoch
  if (relativeSecond <= 0 || relativeSecond > TIMESTAMP_MESSAGE_ID_MAX_SECOND) {
    throw new RangeError('message timestamp is outside the Telegram message ID time window')
  }
  return relativeSecond * TIMESTAMP_MESSAGE_ID_SLOTS
}

/** 返回最接近的合法时间桶；超出约 4.25 年的 int32 窗口边界时钳制到边界，避免长周期会话读取失败。 */
export function clampedTimestampMessageIdBucket(epoch: number, timestamp: number): number {
  assertTimestamp(epoch)
  assertTimestamp(timestamp)
  const relativeSecond = Math.max(1, Math.min(TIMESTAMP_MESSAGE_ID_MAX_SECOND, timestamp - epoch))
  return relativeSecond * TIMESTAMP_MESSAGE_ID_SLOTS
}

export function messageIdBucketStart(messageId: number): number {
  return Math.floor(messageId / TIMESTAMP_MESSAGE_ID_SLOTS) * TIMESTAMP_MESSAGE_ID_SLOTS
}

function positiveSequence(value: JsonValue | undefined): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value)) throw new RangeError('message timestamp must be a safe integer number of seconds')
}
