import type { mtp } from '@mtcute/core'

/** 映射为 MTProto `rpc_error` 的业务异常（如 `PHONE_CODE_INVALID`） */
export class RpcError extends Error {
  constructor(public readonly code: number, public readonly text: string) {
    super(`[${code}] ${text}`)
    this.name = 'RpcError'
  }
}

export const RpcErrors = {
  notImplemented: (method: string): RpcError => new RpcError(500, `METHOD_NOT_IMPLEMENTED: ${method}`),
  internal: (detail?: string): RpcError => new RpcError(500, detail ? `INTERNAL: ${detail}` : 'INTERNAL'),
  badRequest: (text: string): RpcError => new RpcError(400, text),
}

export function isRpcError(e: unknown): e is RpcError {
  return e instanceof RpcError
}

export function toRpcError(e: RpcError): mtp.RawMt_rpc_error {
  return {
    _: 'mt_rpc_error',
    errorCode: e.code,
    errorMessage: e.text,
  }
}
