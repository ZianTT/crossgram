import type { Context } from 'cordis'
import { readFile, stat } from 'node:fs/promises'
import { extname, normalize, resolve, sep } from 'node:path'
import z from 'schemastery'

export interface Config {
  /** 已构建站点的目录（含 `index.html` 与静态资源）。 */
  root: string
  /** 挂载 URL 前缀（默认 `''`）。 */
  path?: string
  /** 未知路径是否回退到 `index.html` 以支持前端路由（默认 `true`）。 */
  spa?: boolean
}

export const Config = z.object({
  root: z.string().required(),
  path: z.string().default(''),
  spa: z.boolean().default(true),
})

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.tgs': 'application/gzip',
  '.webmanifest': 'application/manifest+json',
}

function apply(ctx: Context, config: Config): void {
  const root = resolve(config.root)
  const prefix = normalizePrefix(config.path ?? '')
  const spa = config.spa ?? true

  ctx.server.get('{/*path}', async (req, res, next) => {
    if (prefix && req.path !== prefix && !req.path.startsWith(`${prefix}/`)) return next()
    if (!prefix) {
      // 挂载在根路径时先让其他同级插件尝试处理。
      const prior = await next()
      if (prior || res.claimed) return prior
    }

    // 相对路径资源（`./assets/...`）依赖末尾斜杠，裸前缀访问时先重定向到 `${prefix}/`。
    if (prefix && req.path === prefix) return redirect(`${prefix}/`)

    const route = req.path.slice(prefix.length) || '/'
    const target = resolveFile(root, route)
    let file = target
    try {
      if (!file || !(await stat(file)).isFile()) throw new Error('not a file')
    } catch {
      file = spa ? resolve(root, 'index.html') : undefined
      try {
        if (!file || !(await stat(file)).isFile()) throw new Error('no index')
      } catch {
        return new Response('Not Found', { status: 404 })
      }
    }

    const body = await readFile(file)
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': cacheControl(file),
      },
    })
  })
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } })
}

function resolveFile(root: string, route: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(route)
  } catch {
    return undefined
  }
  const candidate = resolve(root, `.${normalize(decoded)}`)
  if (candidate !== root && !candidate.startsWith(root + sep)) return undefined
  return candidate
}

function cacheControl(file: string): string {
  return file.endsWith('.html')
    ? 'no-cache'
    : 'public, max-age=31536000, immutable'
}

function normalizePrefix(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed || trimmed === '/') return ''
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

apply.inject = ['server']

export const inject = ['server']
export default apply
export { apply }
