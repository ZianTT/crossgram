# MTProto E2E 探测脚本示例

## 基础状态检查

```ts
import type { MtprotoE2eProbeContext } from '@mtproto-relay/mtproto-e2e-client'

export default async function ({ call, profile, user }: MtprotoE2eProbeContext) {
  const state = await call({ _: 'updates.getState' }, 10_000)
  return {
    endpoint: `${profile.config.host}:${profile.config.port}`,
    userId: user.id,
    state: { pts: state.pts, qts: state.qts, date: state.date, seq: state.seq },
  }
}
```

## 拉取会话与历史

```ts
import { Long } from '@mtcute/node'
import type { MtprotoE2eProbeContext } from '@mtproto-relay/mtproto-e2e-client'

export async function run({ call, publish }: MtprotoE2eProbeContext) {
  const dialogs = await call({
    _: 'messages.getDialogs',
    excludePinned: false,
    offsetDate: 0,
    offsetId: 0,
    offsetPeer: { _: 'inputPeerEmpty' },
    limit: 50,
    hash: Long.ZERO,
  })
  if (dialogs._ === 'messages.dialogsNotModified') return { result: dialogs._ }
  publish({ stage: 'dialogs', count: dialogs.dialogs.length })

  const peer = dialogs.dialogs[0]?.peer
  if (!peer) return { result: 'empty' }
  const history = await call({
    _: 'messages.getHistory',
    peer,
    offsetId: 0,
    offsetDate: 0,
    addOffset: 0,
    limit: 20,
    maxId: 0,
    minId: 0,
    hash: Long.ZERO,
  })
  return {
    result: history._,
    messages: history._ === 'messages.messagesNotModified' ? 0 : history.messages.length,
  }
}
```

## 断线重连探测

```ts
import type { MtprotoE2eProbeContext } from '@mtproto-relay/mtproto-e2e-client'

export async function run({ client, call }: MtprotoE2eProbeContext) {
  const before = await call({ _: 'updates.getState' })
  await client.disconnect()
  await client.connect()
  const after = await call({ _: 'updates.getState' })
  return { before: before.pts, after: after.pts }
}
```

## 常用 CLI 参数

| 参数 | 说明 |
|---|---|
| `--profile <name>` | 会话配置名（默认存储在 `data/mtproto-e2e`） |
| `--ssh <target>` | 通过远端 SSH 获取公钥并批准扫码登录 |
| `--platform <id>` | 绑定到的平台账号 ID（如 `qqnt`、`static`） |
| `--host <host>` / `--port <n>` | MTProto 服务端地址与端口 |
| `--rsa-key <path>` | 本地 RSA 密钥文件路径 |
| `--approval-origin <url>` | 本地 WebUI 审批地址 |
| `--fresh` | 归档旧凭据并强制重新登录 |
