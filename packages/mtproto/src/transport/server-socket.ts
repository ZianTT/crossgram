import type { Duplex } from 'node:stream'

/**
 * MTProto 服务端传输层所需的底层流接口。
 * `net.Socket` 原生满足该结构；WebSocket 桥接层基于 `Duplex` 实现它，使浏览器客户端能通过 WS 承载同样的 MTProto 字节流。
 */
export interface ServerTransportSocket extends Duplex {
  remoteAddress?: string
  remotePort?: number
  setNoDelay?(noDelay: boolean): unknown
  setKeepAlive?(enable: boolean, initialDelayMs: number): unknown
  setTimeout?(timeoutMs: number): unknown
}
