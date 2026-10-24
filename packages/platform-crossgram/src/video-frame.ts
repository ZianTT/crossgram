import { spawn } from 'node:child_process'

export interface RemoteVideoFrame {
  /** 已应用旋转元数据的首帧 JPEG。 */
  bytes: Uint8Array
  /** 视频容器时长（秒）。 */
  duration?: number
}

export type RemoteVideoFrameExtractor = (url: string, signal?: AbortSignal) => Promise<RemoteVideoFrame>

const MAX_FRAME_BYTES = 32 * 1024 * 1024
const MAX_STDERR_CHARS = 32_768
const FRAME_TIMEOUT_MS = 30_000
// ffmpeg socket 超时单位为微秒。
const SOCKET_TIMEOUT_US = '15000000'

/**
 * 通过 HTTP Range 直接从视频 URL 抽取首帧。
 * 即使 MP4 的 `moov` 位于文件末尾，ffmpeg 也只拉取索引与首个关键帧，并保留旋转后的原始分辨率以供调用方恢复显示宽高。
 */
export async function extractRemoteVideoFrame(
  url: string,
  signal?: AbortSignal,
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
): Promise<RemoteVideoFrame> {
  const protocol = safeProtocol(url)
  if (!protocol) throw new Error('remote video frame source must be an HTTP(S) URL')
  if (signal?.aborted) throw signal.reason ?? new Error('video frame extraction aborted')
  const child = spawn(ffmpegPath, [
    '-hide_banner', '-nostdin', '-loglevel', 'info',
    '-protocol_whitelist', 'http,https,tcp,tls',
    '-rw_timeout', SOCKET_TIMEOUT_US,
    '-i', url,
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-frames:v', '1',
    '-q:v', '5', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.slice(0, MAX_STDERR_CHARS - stderr.length)
  })
  // 超时或取消时立即 reject，避免子进程句柄被孙进程继承导致等待 `close` 挂起。
  const cancelled = Promise.withResolvers<never>()
  const timeout = setTimeout(() => {
    child.kill()
    cancelled.reject(new Error('video frame extraction timed out'))
  }, FRAME_TIMEOUT_MS)
  timeout.unref()
  const abort = () => {
    child.kill()
    cancelled.reject(signal?.reason ?? new Error('video frame extraction aborted'))
  }
  signal?.addEventListener('abort', abort, { once: true })
  const output = collect(child.stdout)
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code))
  })
  const completed = Promise.all([output, exit])
  completed.catch(() => undefined)
  try {
    const [bytes, code] = await Promise.race([completed, cancelled.promise])
    if (code !== 0 || !bytes.length) {
      throw new Error(`ffmpeg video frame extraction failed (${code ?? 'spawn'}): ${lastLines(stderr)}`)
    }
    return { bytes, duration: parseFfmpegDuration(stderr) }
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
    if (child.exitCode === null && child.signalCode === null) child.kill()
    child.stdout.destroy()
    child.stderr.destroy()
  }
}

export function parseFfmpegDuration(stderr: string): number | undefined {
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr)
  if (!match) return
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

function safeProtocol(value: string): string | undefined {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:' ? protocol : undefined
  } catch {
    return
  }
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of source) {
    size += chunk.length
    if (size > MAX_FRAME_BYTES) throw new Error('extracted video frame is too large')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, size)
}

function lastLines(value: string): string {
  return value.trim().split(/\r?\n/).slice(-3).join(' | ')
}
