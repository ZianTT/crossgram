import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ServerTransportSocket } from './server-socket.js'

/**
 * 将 WebSocket 连接桥接为 MTProto 传输层所需的 `Duplex` 字节流。
 * 二进制帧承载与 TCP 相同的混淆/分帧字节流，MTProto 报文边界由接收缓冲区重组。
 */
export class WebSocketBridge extends Duplex implements ServerTransportSocket {
  readonly remoteAddress: string | undefined
  readonly remotePort: number | undefined
  private _ended = false

  constructor(
    private readonly _ws: WebSocket,
    request: IncomingMessage,
  ) {
    super()
    this.remoteAddress = request.socket.remoteAddress
    this.remotePort = request.socket.remotePort
    this._ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (this._ended || !isBinary) return
      // ws 会在回调返回后复用底层 buffer，异步解码前需拷贝一份
      if (!this.push(new Uint8Array(data))) this._ws.pause()
    })
    this._ws.on('close', () => this._endStream())
    this._ws.on('error', () => this._endStream())
  }

  private _endStream(): void {
    if (this._ended) return
    this._ended = true
    this.push(null)
    this.destroy()
  }

  override _write(
    chunk: Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this._ws.send(chunk, { binary: true }, (error) => callback(error ?? null))
  }

  override _final(callback: (error?: Error | null) => void): void {
    this._ws.close()
    callback()
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this._ws.terminate()
    callback(error)
  }

  override _read(): void {
    this._ws.resume()
  }

  setNoDelay(): void {}
  setKeepAlive(): void {}
  setTimeout(): void {}
}

export interface WebSocketServerHandle {
  port: number
  close(): Promise<void>
}

/** 监听 MTProto over WebSocket 连接（接受任意路径以兼容 mtcute `/` 与 Telegram Web `/apiws`） */
export async function listenWebSocketServer(
  options: { host: string, port: number },
  onConnection: (socket: ServerTransportSocket) => void,
): Promise<WebSocketServerHandle> {
  const httpServer: HttpServer = createServer((_request, response) => {
    response.writeHead(426, { 'content-type': 'text/plain' })
    response.end('WebSocket required')
  })
  const wss = new WebSocketServer({ server: httpServer })
  wss.on('connection', (ws, request) => onConnection(new WebSocketBridge(ws, request)))

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    httpServer.once('error', onError)
    httpServer.listen(options.port, options.host, () => {
      httpServer.off('error', onError)
      resolve()
    })
  })

  const address = httpServer.address()
  return {
    port: address && typeof address === 'object' ? address.port : options.port,
    close: async () => {
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve) => {
        wss.close(() => resolve())
      })
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve())
      })
    },
  }
}
