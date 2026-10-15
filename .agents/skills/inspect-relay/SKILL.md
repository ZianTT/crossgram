---
name: inspect-relay
description: 通过 debug-scripts 在运行中的 Crossgram/Cordis 进程内热加载一次性 TypeScript 探针，查询数据库、内存日志、服务状态或监听实时事件。
---

# Inspect Relay

使用 `.agents/skills/inspect-relay/scripts/probe-relay.mjs` 向运行中的进程下发短期探针，避免直接拷库或改动生产代码。

## 常用命令

```sh
# 检查运行器状态与当前探针（默认连接 root@118.89.184.208，可用 --host 覆盖）
node .agents/skills/inspect-relay/scripts/probe-relay.mjs doctor
node .agents/skills/inspect-relay/scripts/probe-relay.mjs list

# 一键读取实时 MTProto RPC 统计
node .agents/skills/inspect-relay/scripts/probe-relay.mjs statistics

# 运行单次自定义探针（自动上传、等待一条结果、输出 JSON 并清理探针）
node .agents/skills/inspect-relay/scripts/probe-relay.mjs run work/probe.ts
```

## 编写探针

在 `work/` 下编写 `.ts` 文件，导出 `apply(ctx)` 并通过 `ctx.debugScript.publish()` 输出结构化结果；所有事件监听和定时器必须绑定在 `ctx` 或 `ctx.effect()` 上：

```ts
export async function apply(ctx: any) {
  const rows = await ctx.database.select('mtproto_im_message', { id: 42 }).execute()
  await ctx.debugScript.publish({ count: rows.length })
}
```

## 安全准则

- 只输出排查所需的字段与统计值，严禁输出密钥、Token、Auth Key 或无关消息正文。
- 默认保持只读，禁止在生产机上执行构建、全表扫描或高负载任务。
