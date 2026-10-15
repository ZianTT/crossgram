import type { Context } from 'cordis'
import type { Request, Response } from '@cordisjs/plugin-server'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import z from 'schemastery'

export interface Config {
  password: string
  /** 允许匿名访问的路径前缀（默认放行 `/webz`）。 */
  publicPaths?: string[]
  sessionTtlMs?: number
  /** 用于签名登录 Cookie 的密钥；未配置时每次重启随机生成（重启后登录失效）。 */
  sessionSecret?: string
}

export const Config = z.object({
  password: z.string().required(),
  publicPaths: z.array(z.string()).default(['/webz']),
  sessionTtlMs: z.natural().default(7 * 24 * 3600_000),
  sessionSecret: z.string(),
})

const COOKIE_NAME = 'crossgram_auth'
const LOGIN_PATH = '/__auth'

function apply(ctx: Context, config: Config): void {
  const password = config.password
  const publicPaths = config.publicPaths ?? ['/webz']
  const maxAgeSec = Math.floor((config.sessionTtlMs ?? 7 * 24 * 3600_000) / 1000)
  // Cookie 是基于密钥与当前密码的无状态 HMAC，修改密码后已签发的 Cookie 自动失效。
  const secret = config.sessionSecret
    ? Buffer.from(config.sessionSecret)
    : randomBytes(32)
  const token = createHmac('sha256', secret).update(`crossgram-webui-auth:${password}`).digest('base64url')

  // 末尾带 `*` 时按裸前缀匹配（如 `/bot*`），否则必须匹配到路径边界（`/webz` 不会匹配 `/webzanything`）。
  const isPublic = (path: string) => publicPaths.some((entry) => (
    entry.endsWith('*')
      ? path.startsWith(entry.slice(0, -1))
      : path === entry || path.startsWith(`${entry}/`)
  ))

  const isAuthed = (req: Request): boolean => {
    const header = req.headers.get('cookie') ?? ''
    return header.split(';').some((pair) => pair.trim() === `${COOKIE_NAME}=${token}`)
  }

  ctx.server.use(async (req, res, next) => {
    if (isPublic(req.path)) return next()

    if (req.path === LOGIN_PATH) {
      if (req.method === 'POST') {
        const submitted = await readPassword(req)
        if (submitted !== undefined && matches(submitted, password)) {
          res.status = 303
          res.headers.set('set-cookie',
            `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`)
          res.headers.set('location', '/')
          res.body = ''
          return
        }
        return renderLogin(res, 401, 'Wrong password')
      }
      if (req.method === 'GET') return renderLogin(res, 200)
      res.status = 405
      res.body = 'Method Not Allowed'
      return
    }

    if (isAuthed(req)) return next()

    if (req.method === 'GET' && (req.headers.get('accept') ?? '').includes('text/html')) {
      return renderLogin(res, 200)
    }
    res.status = 401
    res.headers.set('content-type', 'text/plain; charset=utf-8')
    res.body = 'Unauthorized'
  })
}

apply.inject = ['server']

async function readPassword(req: Request): Promise<string | undefined> {
  try {
    if ((req.headers.get('content-type') ?? '').includes('application/json')) {
      const body = await req.json() as { password?: unknown }
      return typeof body.password === 'string' ? body.password : undefined
    }
    const form = new URLSearchParams(await req.text())
    const value = form.get('password')
    return value ?? undefined
  } catch {
    return undefined
  }
}

function matches(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function renderLogin(res: Response, status: number, error = ''): void {
  res.status = status
  res.headers.set('content-type', 'text/html; charset=utf-8')
  res.headers.set('cache-control', 'no-store')
  res.body = loginPage(error)
}

function loginPage(error: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Crossgram</title>
<style>
  :root { color-scheme: light dark }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background:#f4f4f5 }
  @media (prefers-color-scheme: dark) { body { background:#18181b; color:#e4e4e7 } }
  form { display:flex; flex-direction:column; gap:.75rem; width:min(20rem, calc(100vw - 3rem)) }
  h1 { font-size:1.125rem; font-weight:600; margin:0 0 .25rem }
  input, button { font: inherit; padding:.6rem .8rem; border-radius:.5rem; border:1px solid #d4d4d8 }
  button { background:#2563eb; border-color:#2563eb; color:#fff; cursor:pointer }
  button:hover { background:#1d4ed8 }
  .error { color:#dc2626; font-size:.875rem; margin:0 }
</style></head>
<body>
<form method="POST" action="${LOGIN_PATH}">
  <h1>Crossgram</h1>
  <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" required>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  <button type="submit">Sign in</button>
</form>
</body></html>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ))
}

export const inject = ['server']
export default apply
export { apply }
