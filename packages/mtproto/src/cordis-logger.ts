import type { Context, Logger as CordisLogger } from 'cordis'
import { NodePlatform } from '@mtcute/node'
import { LogManager } from '@mtcute/core/utils.js'

type LoggerFactory = Context['logger']
type LoggerMethod = 'error' | 'warn' | 'info' | 'debug'

// 将 mtcute 日志转发到 Cordis，保留 mtcute 的格式化占位符（%h/%e 等）并由 Cordis 统一控制日志级别。
export function createCordisLogManager(factory: LoggerFactory): LogManager {
  const manager = new LogManager('mtproto', new NodePlatform())
  const loggers = new Map<string, CordisLogger>()

  // 放开 mtcute 侧过滤，交由 Cordis 处理（VERBOSE 与 DEBUG 均映射为 debug）。
  manager.level = LogManager.VERBOSE
  manager.handler = (_color, level, tag, format, args) => {
    const name = tag === 'mtproto' ? 'mtproto' : `mtproto/${tag}`
    let logger = loggers.get(name)
    if (!logger) {
      logger = factory(name)
      loggers.set(name, logger)
    }
    logger[levelMethod(level)](format, ...args)
  }
  return manager
}

function levelMethod(level: number): LoggerMethod {
  if (level <= LogManager.ERROR) return 'error'
  if (level === LogManager.WARN) return 'warn'
  if (level === LogManager.INFO) return 'info'
  return 'debug'
}
