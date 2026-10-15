import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const composeFile = join(root, 'deploy', 'docker-compose.yml')
// The deployment file only pulls images, so building adds the override.
const buildFile = join(root, 'deploy', 'docker-compose.build.yml')
const project = 'crossgram-e2e'
// Unique ports per run, so a leftover deployment cannot fail the test.
const port = 44_000 + (process.pid % 1000)
const webuiPort = 40_000 + (process.pid % 1000)

// `docker compose`, or whatever CROSSGRAM_DOCKER_RUNTIME names.
function detectRuntime(): string[] | undefined {
  if (process.env.CROSSGRAM_DOCKER_E2E !== '1') return undefined
  if (process.env.CROSSGRAM_DOCKER_RUNTIME) return process.env.CROSSGRAM_DOCKER_RUNTIME.split(' ')
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' })
    return ['docker', 'compose']
  } catch {}
  return undefined
}

async function waitForPort(value: number, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await new Promise((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port: value })
        socket.setTimeout(5000)
        socket.once('connect', () => {
          socket.end()
          resolve(undefined)
        })
        socket.once('timeout', () => {
          socket.destroy()
          reject(new Error(`timed out connecting to 127.0.0.1:${value}`))
        })
        socket.once('error', reject)
      })
      return
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
}

const runtime = detectRuntime()
const suite = runtime ? describe : describe.skip

suite('Crossgram Docker Compose deployment E2E', () => {
  const temp = mkdtempSync(join(tmpdir(), 'crossgram-compose-e2e-'))
  const envFile = join(temp, '.env')
  // Forward the ambient knobs so this run uses the images it was asked to.
  const forwarded = [
    'CROSSGRAM_NODE_IMAGE', 'CROSSGRAM_IMAGE', 'CROSSGRAM_QQNT_IMAGE', 'CROSSGRAM_POSTGRES_IMAGE_TAG',
  ].filter((key) => process.env[key]).map((key) => `${key}=${process.env[key]}`)
  writeFileSync(envFile, [
    'CROSSGRAM_PUBLIC_HOST=203.0.113.10',
    `CROSSGRAM_PORT=${port}`,
    `CROSSGRAM_WEBUI_PORT=${webuiPort}`,
    'CROSSGRAM_POSTGRES_USER=crossgram',
    'CROSSGRAM_POSTGRES_DATABASE=crossgram',
    'CROSSGRAM_POSTGRES_PASSWORD=e2e-postgres-password',
    'TELEGRAM_BOT_TOKEN_VERIFIER_SECRET=e2e-verifier-secret',
    'QQNT_BRIDGE_TOKEN=e2e-qqnt-token',
    ...forwarded,
  ].join('\n'))

  const withBridge = process.env.CROSSGRAM_DOCKER_E2E_QQNT === '1'
  const services = withBridge ? ['postgres', 'crossgram', 'qqnt-bridge'] : ['postgres', 'crossgram']

  const command = (action: string[]) => [
    ...runtime!,
    '--file', composeFile,
    '--file', buildFile,
    '--project-name', project,
    '--env-file', envFile,
    ...action,
  ]

  const tearDown = () => {
    if (!runtime) return
    const argv = command(['down', '--volumes'])
    spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', timeout: 300_000 })
  }

  // Clear state a previous interrupted run may have left behind.
  beforeAll(() => {
    tearDown()
  }, 300_000)

  afterAll(() => {
    tearDown()
    rmSync(temp, { recursive: true, force: true })
  }, 300_000)

  it('builds the application image, starts it behind PostgreSQL and publishes a reachable MTProto port', async () => {
    // No --wait-timeout: docker compose takes integer seconds and other compose
    // implementations take a duration, so the timeouts below bound the wait.
    const argv = command([
      'up', '--detach', '--build', '--wait',
      ...(withBridge ? ['--profile', 'qqnt'] : []),
      ...services,
    ])
    execFileSync(argv[0], argv.slice(1), { stdio: 'inherit', timeout: 40 * 60_000 })
    await waitForPort(port)
    await waitForPort(webuiPort)
    expect(runtime).toEqual(expect.any(Array))
  }, 45 * 60_000)
})
