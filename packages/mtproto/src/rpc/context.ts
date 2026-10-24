import type { tl } from '@mtcute/core'
import type { Context } from 'cordis'
import type Long from 'long'
import type { ServerConnection } from '../transport/server-connection.js'
import type { ServerSession } from '../session/server-session.js'

/** 单个客户端连接生命周期内绑定的上下文信息 */
export interface MtprotoConnectionScope {
  id: string
  connection: ServerConnection
  session: ServerSession
  remoteAddress?: string
  remotePort?: number
  connectedAt?: number
  lastActiveAt?: number
  /** `initConnection` 上报的客户端设备与应用信息 */
  clientInfo?: MtprotoClientInfo
}

export interface MtprotoClientInfo {
  apiId: number
  deviceModel: string
  systemVersion: string
  appVersion: string
  systemLangCode: string
  langPack: string
  langCode: string
}

/** 单个传输层数据包对应的派生上下文信息 */
export interface MtprotoPacketScope {
  connection: MtprotoConnectionScope
  sequence: number
  data: Uint8Array
}

export interface MtprotoTrafficSample {
  connection: MtprotoConnectionScope
  direction: 'received' | 'sent'
  bytes: number
  timestamp: number
}

/** 单次 RPC 调用的派生上下文信息 */
export interface MtprotoRpcScope {
  connection: MtprotoConnectionScope
  request: tl.RpcMethod
  messageId: Long
  receivedAt: number
}

export interface ServerRpcContext {
  readonly cordis?: Context
  readonly mtprotoConnection?: MtprotoConnectionScope
  readonly mtprotoRpc?: MtprotoRpcScope
  connection: ServerConnection
  /** `invokeWithLayer` 协商的 API layer，在整个会话期间保留 */
  readonly apiLayer: number | null
  readonly clientInfo?: MtprotoClientInfo
  readonly connectedAt?: number
  readonly lastActiveAt?: number
  /** 8 字节永久 auth_key_id，未完成握手前为 null */
  authKeyId: Uint8Array | null
  sessionId: Long
  isAuthorized: boolean
  sendUpdate: (update: tl.TypeUpdates) => void
  /** 在当前 `rpc_result` 入队发送后执行的回调（用于依赖客户端先收到响应再处理后续 update 的场景） */
  afterResponse?: (task: () => void | Promise<void>) => void
  /** 在当前成功响应底层写入完成后执行的回调 */
  afterResponseSettled?: (task: () => void | Promise<void>) => void
  /** 读取绑定到该永久 auth key 的内存态数据（空闲超时后可能为 null） */
  getPlatformData: <T>() => T
  /** 缓存绑定到该永久 auth key 的内存态数据 */
  setPlatformData: (data: unknown) => void
}

export type CordisServerRpcContext = Context & ServerRpcContext & {
  readonly cordis: Context
  readonly mtprotoConnection: MtprotoConnectionScope
  readonly mtprotoRpc: MtprotoRpcScope
}
