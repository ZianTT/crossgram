import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import compose from './docker-compose.yml'
import buildOverride from './docker-compose.build.yml'
import { migrateRuntimeConfigFile } from './migrate-runtime-config.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const deployDir = join(root, 'deploy')
const dockerDir = join(deployDir, 'docker')

const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8')
const posix = (value: string) => value.replaceAll('\\', '/')

function pluginNames(source: string) {
  return [...source.matchAll(/name: '([^']+)'/g)].map((match) => match[1])
}

function childEnvironment(binDir: string | undefined, extra: Record<string, string>) {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key]
  }
  const base = posix(process.env.PATH ?? '')
  env.PATH = binDir ? `${posix(binDir)}${delimiter}${base}` : base
  return Object.assign(env, extra)
}

function writeExecutable(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

describe('Crossgram Docker Compose deployment', () => {
  const services = (compose as any).services ?? {}

  it('declares the application, its database and the QQNT bridge', () => {
    expect((compose as any).name).toBe('crossgram')
    expect(Object.keys(services)).toEqual(['postgres', 'crossgram', 'qqnt-bridge'])
    // 部署只拉镜像：构建说明放在 override 文件里，见下一个用例。
    expect(services.crossgram.build).toBeUndefined()
    expect(services.crossgram.image).toBe('${CROSSGRAM_IMAGE:-ghcr.io/std-microblock/crossgram:latest}')
    expect(services.crossgram.depends_on).toEqual({ postgres: { condition: 'service_healthy' } })
    expect(services.crossgram.volumes).toEqual(['crossgram-state:/var/lib/crossgram'])
    expect(services.crossgram.ports).toEqual([
      '${CROSSGRAM_BIND:-0.0.0.0}:${CROSSGRAM_PORT:-4430}:${CROSSGRAM_PORT:-4430}',
      '127.0.0.1:${CROSSGRAM_WEBUI_PORT:-3140}:${CROSSGRAM_WEBUI_PORT:-3140}',
    ])
    expect(services.crossgram.healthcheck.test).toEqual(['CMD-SHELL', 'node /opt/crossgram/deploy/docker/healthcheck.mjs'])
    expect(services.crossgram.restart).toBe('unless-stopped')
    expect(services.postgres.volumes).toEqual(['crossgram-postgres:/var/lib/postgresql/data'])
    expect(services.postgres.healthcheck.test[1]).toContain('pg_isready')
    expect(services['qqnt-bridge'].profiles).toEqual(['qqnt'])
    // The bridge image belongs to the bridge repository, so this file pulls it.
    expect(services['qqnt-bridge'].image).toBe('${CROSSGRAM_QQNT_IMAGE:-ghcr.io/xuuuuan/crossgram-qqnt:latest}')
    expect(services['qqnt-bridge'].build).toBeUndefined()
    // The image declares the probe, so the compose file does not restate it.
    expect(services['qqnt-bridge'].healthcheck).toBeUndefined()
    expect(services['qqnt-bridge'].shm_size).toBe('256m')
    expect(services['qqnt-bridge'].volumes).toEqual(['crossgram-qqnt:/var/lib/qqnt-bridge'])
    expect(services['qqnt-bridge'].environment.QQNT_BRIDGE_STATE_DIR).toBe('/var/lib/qqnt-bridge')
    expect(services['qqnt-bridge'].environment.QQNT_BRIDGE_QQ_FLAGS).toBe('${CROSSGRAM_QQNT_QQ_FLAGS:-}')
    expect(services.crossgram.environment.MALLOC_ARENA_MAX).toBe('2')
    expect((compose as any).volumes).toEqual({
      'crossgram-state': null,
      'crossgram-postgres': null,
      'crossgram-qqnt': null,
    })
    // Services talk over the network compose creates for the project, and only
    // the MTProto port leaves the host; the WebUI stays on loopback.
    expect((compose as any).networks).toBeUndefined()
    for (const service of Object.values(services) as any[]) {
      expect(service.networks).toBeUndefined()
      expect(service.network_mode).toBeUndefined()
    }
    expect(services.postgres.ports).toBeUndefined()
    expect(services['qqnt-bridge'].ports).toBeUndefined()
  })

  it('leaves memory limits to the operator', () => {
    // A hard limit is a deployment decision, so it ships commented out.
    const source = read(deployDir, 'docker-compose.yml')
    for (const service of Object.values(services) as any[]) expect(service.deploy).toBeUndefined()
    for (const limit of ['768m', '2g']) expect(source).toContain(`#       memory: ${limit}`)
  })

  it('can be deployed from the compose file alone, without a checkout', () => {
    // `docker compose up -d` only pulls images and named volumes, so a lone
    // compose file works; the build override is read only with --build.
    for (const [name, service] of Object.entries(services) as [string, any][]) {
      expect(service.env_file, name).toBeUndefined()
      expect(service.configs, name).toBeUndefined()
      expect(service.build, name).toBeUndefined()
      for (const volume of service.volumes ?? []) {
        expect(volume, `${name} volume`).toMatch(/^crossgram-[a-z]+:\//)
      }
    }
  })

  it('builds the application image only when the checkout is present', () => {
    const override = (buildOverride as any).services ?? {}
    expect(Object.keys(override)).toEqual(['crossgram'])
    expect(override.crossgram.build).toEqual({
      context: '..',
      dockerfile: 'deploy/docker/Dockerfile',
      args: { NODE_IMAGE: '${CROSSGRAM_NODE_IMAGE:-node:24-bookworm-slim}' },
    })
    // The override must not redefine what the deployment file already sets.
    expect(override.crossgram.image).toBeUndefined()
    expect(Object.keys(override.crossgram)).toEqual(['build'])
  })

  it('passes every secret through the environment instead of the compose file', () => {
    const source = read(deployDir, 'docker-compose.yml')
    expect(source).toContain('${CROSSGRAM_POSTGRES_PASSWORD:?required}')
    expect(source).toContain('${CROSSGRAM_PUBLIC_HOST:?required}')
    expect(source).toContain('${TELEGRAM_BOT_TOKEN_VERIFIER_SECRET:?required}')
    expect(source).not.toMatch(/PASSWORD:\s+(?![$"])/)
    expect(services.crossgram.environment.CROSSGRAM_POSTGRES_PASSWORD).toBe('${CROSSGRAM_POSTGRES_PASSWORD:?required}')
    expect(services.crossgram.environment.CROSSGRAM_POSTGRES_HOST).toBe('postgres')
    expect(services.crossgram.environment.CROSSGRAM_QQNT_ENDPOINT).toBe('${CROSSGRAM_QQNT_ENDPOINT:-http://qqnt-bridge:18767/v1}')
    expect(services.crossgram.environment.CROSSGRAM_WEBUI_HOST).toBe('0.0.0.0')
  })

  it('keeps the env example to deployment inputs and documents the rest', () => {
    const example = read(deployDir, '.env.example')
    for (const key of [
      'CROSSGRAM_PUBLIC_HOST', 'CROSSGRAM_PORT', 'CROSSGRAM_BIND', 'CROSSGRAM_WEBUI_PORT',
      'CROSSGRAM_POSTGRES_PASSWORD', 'TELEGRAM_BOT_TOKEN_VERIFIER_SECRET', 'QQNT_BRIDGE_TOKEN',
    ]) {
      expect(example, key).toMatch(new RegExp(`^${key}=`, 'm'))
    }
    expect(example).toContain('host.docker.internal')
    expect(example).toContain('deploy/README.md')

    // Only deployment inputs belong in the file every operator copies.
    const advanced = [
      'CROSSGRAM_NODE_IMAGE', 'CROSSGRAM_QQNT_QQ_FLAGS',
      'CROSSGRAM_IMAGE', 'CROSSGRAM_QQNT_IMAGE',
    ]
    for (const key of advanced) {
      expect(example, `${key} must not be in .env.example`).not.toContain(key)
    }

    // Knobs an operator may have to turn on keep a documented name.
    const readme = read(deployDir, 'README.md')
    for (const key of advanced) {
      expect(readme, `${key} must be documented`).toContain(key)
    }
  })

  it('publishes only the application image, because the bridge publishes its own', () => {
    const workflow = read(root, '.github', 'workflows', 'docker.yml')
    expect(workflow).toContain('images: ghcr.io/${{ github.repository_owner }}/crossgram\n')
    expect(workflow).not.toContain('crossgram-qqnt-bridge\n')
    expect(workflow).toContain('packages: write')
    expect(workflow).toContain("push: ${{ github.event_name != 'pull_request' }}")
    expect(workflow).toContain('file: deploy/docker/Dockerfile')
    expect(workflow).toContain('CROSSGRAM_DOCKER_E2E')
    // No bridge build arguments or release resolution are left here.
    for (const gone of ['qq-version:', 'qq-deb-url:', 'qqnt-bridge', 'QQ_DEB_URL', 'bridge-inputs.sh']) {
      expect(workflow, gone).not.toContain(gone)
    }
    // The compose file pulls the package the bridge repository publishes.
    const compose = read(deployDir, 'docker-compose.yml')
    expect(compose).toContain('ghcr.io/xuuuuan/crossgram-qqnt:latest')
    expect(compose).not.toContain('CROSSGRAM_QQNT_WITH_')
  })

  it('builds the application image from the checkout and runs it unprivileged', () => {
    const dockerfile = read(dockerDir, 'Dockerfile')
    expect(dockerfile).toContain('ARG NODE_IMAGE=node:24-bookworm-slim')
    expect(dockerfile).toContain('corepack enable')
    // `ps` is missing from the slim base.
    expect(dockerfile).toContain('install -y --no-install-recommends procps')
    expect(dockerfile).toContain('corepack yarn install --immutable')
    expect(dockerfile).toContain('corepack yarn build')
    // yarn's cache must not survive the layer that created it.
    const install = dockerfile.slice(dockerfile.indexOf('RUN corepack yarn install'))
    const layer = install.slice(0, install.indexOf('\n\n'))
    expect(layer).toContain('rm -rf /root/.yarn /root/.npm')
    expect(dockerfile).toContain('COREPACK_HOME=/opt/crossgram/.corepack')
    expect(dockerfile).toContain('chown -R crossgram:crossgram /opt/crossgram/.corepack')
    expect(dockerfile).toContain('USER crossgram')
    expect(dockerfile).toContain('HOME=/var/lib/crossgram')
    expect(dockerfile).toContain('NODE_OPTIONS="--import tsx --import @cordisjs/unyaml"')
    expect(dockerfile).toContain('EXPOSE 4430 3140')
    expect(dockerfile).toContain('ENTRYPOINT ["/opt/crossgram/deploy/docker/entrypoint.sh"]')
    expect(dockerfile).not.toMatch(/CROSSGRAM_POSTGRES_PASSWORD=|TELEGRAM_BOT_TOKEN_VERIFIER_SECRET=/)
  })

  it('keeps the container runtime config in step with the systemd one', () => {
    const systemd = read(deployDir, 'app.production.yml')
    const docker = read(dockerDir, 'app.docker.yml')
    expect(pluginNames(docker)).toEqual(pluginNames(systemd))
    expect(pluginNames(docker).length).toBeGreaterThan(10)
    expect(docker).toContain('__CROSSGRAM_STATE_DIR__/data/rsa-key.json')
    expect(docker).toContain('__CROSSGRAM_STATE_DIR__/data/auth-keys.json')
    expect(docker).toContain('__CROSSGRAM_STATE_DIR__/data/bridge-uploads')
    expect(docker).toContain('__CROSSGRAM_STATE_DIR__/debug-scripts')
    expect(docker).toContain('serverHost: __CROSSGRAM_PUBLIC_HOST__')
    expect(docker).toContain('host: __CROSSGRAM_POSTGRES_HOST__')
    expect(docker).toContain('port: __CROSSGRAM_POSTGRES_PORT__')
    expect(docker).toContain('user: __CROSSGRAM_POSTGRES_USER__')
    expect(docker).toContain('database: __CROSSGRAM_POSTGRES_DATABASE__')
    expect(docker).toContain('password:\n          __jsExpr: process.env.CROSSGRAM_POSTGRES_PASSWORD')
    expect(docker).toContain('endpoint: __CROSSGRAM_QQNT_ENDPOINT__')
    expect(docker).toContain('webSocketEndpoint: __CROSSGRAM_QQNT_WS_ENDPOINT__')
    expect(docker).toContain('host: __CROSSGRAM_WEBUI_HOST__')
    expect(docker).toContain('port: __CROSSGRAM_WEBUI_PORT__')
    expect(docker).not.toContain("'@cordisjs/plugin-database-sqlite'")
    expect(docker).not.toContain('@cordisjs/plugin-server-webui')
  })

  it('renders the runtime config from the environment, migrates it and starts cordis', () => {
    const temp = mkdtempSync(join(tmpdir(), 'crossgram-docker-entrypoint-'))
    const installDir = posix(join(temp, 'opt'))
    const stateDir = `${installDir}/state`
    const binDir = join(temp, 'bin')
    const calls = join(temp, 'calls')
    const rendered = join(temp, 'opt', '.runtime', 'app.yml')
    try {
      mkdirSync(join(installDir, 'deploy', 'docker'), { recursive: true })
      cpSync(join(dockerDir, 'app.docker.yml'), join(installDir, 'deploy', 'docker', 'app.docker.yml'))
      cpSync(join(deployDir, 'migrate-runtime-config.mjs'), join(installDir, 'deploy', 'migrate-runtime-config.mjs'))
      writeFileSync(join(installDir, 'package.json'), '{"name":"crossgram"}\n')
      mkdirSync(binDir)
      writeExecutable(join(binDir, 'corepack'), 'printf \'corepack %s\\n\' "$*" >> "$CROSSGRAM_TEST_CALLS"')

      execFileSync('sh', [join(dockerDir, 'entrypoint.sh')], {
        env: childEnvironment(binDir, {
          CROSSGRAM_INSTALL_DIR: installDir,
          CROSSGRAM_STATE_DIR: stateDir,
          CROSSGRAM_TEST_CALLS: calls,
          CROSSGRAM_PUBLIC_HOST: '203.0.113.10',
          CROSSGRAM_PORT: '4430',
          CROSSGRAM_POSTGRES_PASSWORD: 'postgres-password',
          TELEGRAM_BOT_TOKEN_VERIFIER_SECRET: 'verifier-secret',
          QQNT_BRIDGE_TOKEN: 'qqnt-token',
          CROSSGRAM_QQNT_ENDPOINT: 'http://bridge.internal:18767/v1',
          CROSSGRAM_QQNT_WS_ENDPOINT: 'ws://bridge.internal:18767/v1/events/ws',
        }),
      })

      const config = readFileSync(rendered, 'utf8')
      expect(config).not.toMatch(/__CROSSGRAM_[A-Z_]+__/)
      expect(config).toContain('serverHost: 203.0.113.10')
      expect(config).toContain('serverPort: 4430')
      expect(config).toContain(`rsaKeyPath: ${stateDir}/data/rsa-key.json`)
      expect(config).toContain(`root: ${stateDir}/debug-scripts`)
      expect(config).toContain('host: postgres')
      expect(config).toContain('port: 5432')
      expect(config).toContain('user: crossgram')
      expect(config).toContain('database: crossgram')
      expect(config).toContain('endpoint: http://bridge.internal:18767/v1')
      expect(config).toContain('webSocketEndpoint: ws://bridge.internal:18767/v1/events/ws')
      expect(config).toContain('host: 0.0.0.0')
      expect(config).toContain('port: 3140')
      expect(config).toContain('verifierSecret: ${TELEGRAM_BOT_TOKEN_VERIFIER_SECRET}')
      expect(migrateRuntimeConfigFile(rendered)).toBe(false)
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
        `corepack yarn cordis run ${posix(rendered)}`,
      ])
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('starts the cordis CLI directly so no yarn process sits in the container', () => {
    const temp = mkdtempSync(join(tmpdir(), 'crossgram-docker-cordis-'))
    const installDir = posix(join(temp, 'opt'))
    const binDir = join(temp, 'bin')
    const calls = join(temp, 'calls')
    const cordis = join(temp, 'opt', 'node_modules', 'cordis', 'bin.js')
    try {
      mkdirSync(join(installDir, 'deploy', 'docker'), { recursive: true })
      mkdirSync(join(installDir, 'node_modules', 'cordis'), { recursive: true })
      cpSync(join(dockerDir, 'app.docker.yml'), join(installDir, 'deploy', 'docker', 'app.docker.yml'))
      cpSync(join(deployDir, 'migrate-runtime-config.mjs'), join(installDir, 'deploy', 'migrate-runtime-config.mjs'))
      writeFileSync(join(installDir, 'package.json'), '{"name":"crossgram"}\n')
      writeFileSync(cordis, '// fake cordis entry\n')
      mkdirSync(binDir)
      writeExecutable(join(binDir, 'node'), 'printf \'node %s\\n\' "$*" >> "$CROSSGRAM_TEST_CALLS"')
      writeExecutable(join(binDir, 'corepack'), 'printf \'corepack %s\\n\' "$*" >> "$CROSSGRAM_TEST_CALLS"')

      execFileSync('sh', [join(dockerDir, 'entrypoint.sh')], {
        env: childEnvironment(binDir, {
          CROSSGRAM_INSTALL_DIR: installDir,
          CROSSGRAM_STATE_DIR: `${installDir}/state`,
          CROSSGRAM_TEST_CALLS: calls,
          CROSSGRAM_PUBLIC_HOST: '203.0.113.10',
          CROSSGRAM_POSTGRES_PASSWORD: 'postgres-password',
          TELEGRAM_BOT_TOKEN_VERIFIER_SECRET: 'verifier-secret',
        }),
      })

      const rendered = posix(join(temp, 'opt', '.runtime', 'app.yml'))
      // corepack never runs: the CLI starts directly.
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
        `node ${installDir}/deploy/migrate-runtime-config.mjs ${rendered}`,
        `node ${posix(cordis)} run ${rendered}`,
      ])
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('refuses to start without the public host or the bot API secret', () => {
    const temp = mkdtempSync(join(tmpdir(), 'crossgram-docker-entrypoint-fail-'))
    const installDir = posix(join(temp, 'opt'))
    try {
      mkdirSync(join(installDir, 'deploy', 'docker'), { recursive: true })
      cpSync(join(dockerDir, 'app.docker.yml'), join(installDir, 'deploy', 'docker', 'app.docker.yml'))
      const run = (extra: Record<string, string>) => execFileSync('sh', [join(dockerDir, 'entrypoint.sh')], {
        env: childEnvironment(undefined, {
          CROSSGRAM_INSTALL_DIR: installDir,
          CROSSGRAM_STATE_DIR: `${installDir}/state`,
          CROSSGRAM_POSTGRES_PASSWORD: 'postgres-password',
          ...extra,
        }),
        stdio: 'pipe',
      })
      expect(() => run({ TELEGRAM_BOT_TOKEN_VERIFIER_SECRET: 'verifier-secret' }))
        .toThrow(/CROSSGRAM_PUBLIC_HOST must be/)
      expect(() => run({ CROSSGRAM_PUBLIC_HOST: '203.0.113.10' }))
        .toThrow(/TELEGRAM_BOT_TOKEN_VERIFIER_SECRET must be/)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('keeps every deployment script valid POSIX shell and executable', () => {
    const shellScripts = [
      'deploy/docker/entrypoint.sh',
    ]
    for (const script of shellScripts) {
      expect(() => execFileSync('sh', ['-n', join(root, script)]), script).not.toThrow()
    }
    const executables = shellScripts
    const stages = execFileSync('git', ['ls-files', '--stage', ...executables], { cwd: root, encoding: 'utf8' })
      .trim().split('\n')
    expect(stages).toHaveLength(executables.length)
    expect(stages.every((stage) => stage.startsWith('100755 '))).toBe(true)
  })

  it('keeps build contexts free of ignored directories', () => {
    const ignore = read(root, '.dockerignore')
    for (const entry of ['.git', '.worktrees', 'node_modules', 'data', 'external', 'deploy/.env']) {
      expect(ignore, entry).toMatch(new RegExp(`^${entry.replaceAll('.', '\\.')}$$`, 'm'))
    }
  })
})
