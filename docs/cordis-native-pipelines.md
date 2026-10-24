# Cordis 管线与生命周期

CrossGram 将连接、请求与平台事件建模为 Cordis 树状作用域（Fiber），不维护全局回调表，连接断开或插件卸载时自动回收关联资源。

## MTProto 生命周期树

```text
Mtproto service fiber
└─ connectionFiber (每个 TCP/WS 连接一个)
   ├─ ctx.mtprotoConnection
   ├─ ctx.mtprotoPacket
   └─ rpcInvocationFiber (每个解码后的 RPC 一个)
      └─ ctx.mtprotoRpc + ServerRpcContext
```

- 关闭底层连接会自动销毁 `connectionFiber` 及其下属所有进行中的子任务与监听器。
- `mtproto/packet`：原始帧处理拦截链（Waterfall），用于追踪、校验或限流。观察者若不拒绝数据包，必须调用 `next()`。
- `mtproto/rpc`：RPC 路由拦截链（Waterfall），用于挂载跨切面策略。
- `mtproto/rpc/method`：串行路由事件。`ctx.mtproto.register()` 基于此事件注册处理函数，后注册的路由优先生效，所属插件卸载后自动恢复旧路由。
- `mtproto/connection` 与 `mtproto/debug`：连接与调试观测事件。

## 平台事件生命周期树

```text
bridge plugin fiber
└─ platformSessionFiber (每个在线平台会话一个)
   ├─ ctx.bridgeSession
   └─ platformEventFiber (每个消息/编辑/撤回/已读/回应/通话事件一个)
      └─ ctx.bridgeEvent
```

每个会话 Fiber 独立持有平台订阅和保序事件队列：不同会话可并发处理，同一会话内部严格按上游顺序串行处理。停止适配器或卸载 Bridge 时，会先等待当前事件处理完毕再取消订阅。

事件处理分为四步：

1. `bridge/platform-event`（Waterfall）：平台事件入库前置拦截。
2. `MessageStore`：事务写入数据库并生成 `CommittedPlatformEvent`。
3. `bridge/platform-event/publish`（Waterfall）：投影为 MTProto 更新并推送给客户端。
4. `im-platform/event-committed`：入库并发布完成后的广播通知。

## 作用域规则

- 进程级状态放在 Cordis `Service`。
- 连接级与会话级状态放在对应的长生命周期子 Fiber。
- 单次数据包、RPC、平台事件的上下文放在派生 `Context`。
- 所有路由注册与外部资源监听都必须绑定为 `ctx.effect`。
