import type { mtp, tl } from '@mtcute/core'
import type Long from 'long'
import type { MtprotoClientInfo, ServerRpcContext } from './context.js'
import { RpcError, RpcErrors, isRpcError, toRpcError } from './errors.js'

/**
 * 裸 `Vector<X>` RPC 返回值（`0x1cb5c415` + 数量 + 元素，无外层包装对象），
 * 用于 `users.getUsers`、旧版 `messages.getDialogFilters` 等接口。
 */
export interface BareVector {
  readonly _: 'vector'
  readonly items: readonly tl.TlObject[]
}

/** 直接在 `rpc_result` 内序列化的裸 Bool 构造器 */
export interface BareBool {
  readonly _: 'boolTrue' | 'boolFalse'
}

export type RpcResult = tl.TlObject | BareBool | BareVector | mtp.RawMt_rpc_error

export function bareVector(items: readonly tl.TlObject[]): BareVector {
  return { _: 'vector', items }
}

export function isBareVector(result: unknown): result is BareVector {
  return typeof result === 'object'
    && result !== null
    && (result as { _: string })._ === 'vector'
    && Array.isArray((result as { items?: unknown }).items)
}

export interface UnwrappedRpcRequest {
  request: tl.RpcMethod
  /** `invokeWithLayer` 声明的 API layer */
  apiLayer: number | null
  /** `initConnection` 携带的客户端信息 */
  clientInfo: MtprotoClientInfo | null
  /** `invokeAfterMsg(s)` 依赖的前置消息 ID */
  afterMessageIds: readonly Long[]
}

const RPC_WRAPPER_METHODS = new Set([
  'initConnection',
  'invokeAfterMsg',
  'invokeAfterMsgs',
  'invokeWithLayer',
  'invokeWithMessagesRange',
  'invokeWithTakeout',
  'invokeWithoutUpdates',
])

export function isRpcRequestObject(method: string): boolean {
  return method.includes('.') || RPC_WRAPPER_METHODS.has(method)
}

/** 剥离外层 RPC 包装（`invokeWithLayer`、`initConnection`、`invokeAfterMsg` 等）并提取元信息 */
export function unwrapRpcRequest(request: tl.RpcMethod): UnwrappedRpcRequest {
  let req = request
  let apiLayer: number | null = null
  let clientInfo: MtprotoClientInfo | null = null
  const afterMessageIds: Long[] = []
  for (;;) {
    const method = req._
    if (method === 'invokeWithLayer') {
      const wrapper = req as unknown as { layer: number, query: tl.RpcMethod }
      if (Number.isInteger(wrapper.layer) && wrapper.layer > 0) apiLayer = wrapper.layer
      req = wrapper.query
      continue
    }
    if (method === 'initConnection') {
      const wrapper = req as unknown as tl.RawInitConnectionRequest<tl.RpcMethod>
      clientInfo = {
        apiId: wrapper.apiId,
        deviceModel: wrapper.deviceModel,
        systemVersion: wrapper.systemVersion,
        appVersion: wrapper.appVersion,
        systemLangCode: wrapper.systemLangCode,
        langPack: wrapper.langPack,
        langCode: wrapper.langCode,
      }
      req = wrapper.query
      continue
    }
    if (method === 'invokeWithoutUpdates') {
      req = (req as unknown as { query: tl.RpcMethod }).query
      continue
    }
    if (method === 'invokeAfterMsg') {
      const wrapper = req as unknown as { msgId: Long, query: tl.RpcMethod }
      afterMessageIds.push(wrapper.msgId)
      req = wrapper.query
      continue
    }
    if (method === 'invokeAfterMsgs') {
      const wrapper = req as unknown as { msgIds: Long[], query: tl.RpcMethod }
      afterMessageIds.push(...wrapper.msgIds)
      req = wrapper.query
      continue
    }
    if (method === 'invokeWithMessagesRange' || method === 'invokeWithTakeout') {
      req = (req as unknown as { query: tl.RpcMethod }).query
      continue
    }
    return { request: req, apiLayer, clientInfo, afterMessageIds }
  }
}

export type RpcHandler = (ctx: ServerRpcContext, request: tl.RpcMethod) => Promise<RpcResult>

export { RpcError, RpcErrors, toRpcError, isRpcError }
export type { ServerRpcContext }
