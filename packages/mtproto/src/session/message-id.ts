import Long from 'long'

/**
 * 服务端 MTProto `msg_id` 与 `seq_no` 生成器。
 * - `msg_id`：高 32 位为 `(unix_time + timeOffset)`，低 32 位为亚秒计数且保持严格递增；
 *   服务端生成的消息低两位固定为 `≡ 1 (mod 4)`（客户端消息为 `≡ 0 (mod 4)`）。
 * - `seq_no`：content-related 消息为 `count * 2 + 1`（随后 `count++`），非 content 消息为 `count * 2`。
 */
export class ServerMessageIdGenerator {
  private _timeOffset = 0
  private _lastMsgId = Long.ZERO
  private _contentCount = 0

  updateTimeOffset(offset: number): void {
    this._timeOffset = offset
  }

  observeClientMsgId(msgId: Long): void {
    if (msgId.greaterThan(this._lastMsgId)) this._lastMsgId = msgId
  }

  getMessageId(_isContentRelated = true): Long {
    const now = Date.now() / 1000 + this._timeOffset
    const secs = Math.floor(now)
    const frac = Math.floor((now - secs) * 0x1_0000_0000)
    const low = ((frac & ~3) | 1) >>> 0
    let msgId = new Long(low, secs, false)
    if (msgId.lessThanOrEqual(this._lastMsgId)) {
      // _lastMsgId 可能是客户端的 msg_id（0 mod 4），直接 +4 会保留错误的奇偶位导致客户端拒收，需步进到下一个 ≡ 1 (mod 4) 的值
      const remainder = this._lastMsgId.getLowBitsUnsigned() & 3
      const delta = ((1 - remainder) & 3) || 4
      msgId = this._lastMsgId.add(delta)
    }
    this._lastMsgId = msgId
    return msgId
  }

  getSeqNo(isContentRelated: boolean): number {
    if (isContentRelated) {
      const seq = this._contentCount * 2 + 1
      this._contentCount++
      return seq
    }
    return this._contentCount * 2
  }
}
