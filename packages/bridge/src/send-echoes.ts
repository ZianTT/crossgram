import type { IMMessage, PlatformSession } from './platform.js'

/**
 * 平台对「自己刚发出去的消息」的回显。
 *
 * 发送 RPC 的回包已经用 `updateMessageID` 把发送端的乐观消息原地升级；如果平台
 * 再把同一条消息作为普通事件推回发送端，客户端就会多出一份服务端副本（桌面端
 * 合并时必然销毁一条并播放消息粉碎动画，Android 则是占位气泡消失）。
 *
 * 这里按**平台消息 id** 精确记录这条回显属于哪个 auth key，而不是按发送时间段
 * 屏蔽整个 auth key：同一时间从 QQ 手机端发出的别的消息、或并发的其他发送都不受影响。
 *
 * 发送响应返回前的回显由平台按 `originRequestId` 过滤（`platform-crossgram`
 * 的 own-origin 规则）；这里补的是响应返回之后、本方投递完成之前的那一段。
 */
export class SendEchoes {
  private readonly _bySession = new Map<string, Map<string, string>>()

  /** 记录本次发送产生的平台消息（含多段消息的 `sourceIds`）属于哪个 auth key。 */
  bind(platformSessionId: string, messageIds: readonly string[], authKeyId?: string): void {
    if (!authKeyId || !messageIds.length) return
    let bound = this._bySession.get(platformSessionId)
    if (!bound) this._bySession.set(platformSessionId, bound = new Map())
    for (const id of messageIds) bound.set(id, authKeyId)
  }

  /** 本方投递完成（或发送失败）后解绑；此后的回显会被事件去重挡掉。 */
  release(platformSessionId: string, messageIds: readonly string[]): void {
    const bound = this._bySession.get(platformSessionId)
    if (!bound) return
    for (const id of messageIds) bound.delete(id)
    if (!bound.size) this._bySession.delete(platformSessionId)
  }

  /**
   * 这条消息的发送回显该排除哪个 auth key：命中本方发送记录时返回它的 auth key。
   * 同一会话里别人发的、或从别的客户端同步过来的消息不会命中。
   */
  excludeFor(session: PlatformSession, message: IMMessage): string | undefined {
    const bound = this._bySession.get(session.platformSessionId)
    if (!bound) return undefined
    for (const id of [message.id, ...(message.sourceIds ?? [])]) {
      const authKeyId = bound.get(id)
      if (authKeyId) return authKeyId
    }
    return undefined
  }
}
