# `platform-crossgram` ↔ `qqnt-bridge` 协议

本文描述 `@mtproto-relay/platform-qqnt`（`packages/platform-crossgram`）与 `qqnt-bridge` 之间的本地通信协议，包含三部分：

1. **HTTP JSON API**（默认 `http://127.0.0.1:18767/v1`）
2. **WebSocket 事件流**（`/v1/events/ws`）
3. **Unix Socket PCM 语音通道**（48 kHz 单声道 s16le 音频帧）

协议版本由 `/v1/status` 的 `protocolVersion` 返回（当前版本为 `35`，适配器最低兼容版本为 `19`）。类型定义分别见 `packages/platform-crossgram/src/protocol.ts`（`Wire*`）与 `qqnt-bridge/src/protocol.ts`（`QQ*`）。

---

## 1. 传输与认证

- **认证头**：配置 `QQNT_BRIDGE_TOKEN` 后，所有 HTTP 与 WebSocket 握手请求必须携带 `Authorization: Bearer <token>`；校验失败返回 `401 {"error": "unauthorized"}`。
- **缓存协商**：会话列表、历史记录等接口返回 `ETag`，支持 `If-None-Match` 返回 `304 Not Modified`。
- **就绪状态**：QQNT 内核未就绪时，除 `/v1/status`、`/v1/login/*` 与 `/v1/group-join/probe` 外均返回 `503 {"error": "QQNT kernel is not ready"}`。

---

## 2. HTTP 接口总览

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v1/status` | 服务状态、当前登录账号与 `protocolVersion` |
| `GET` | `/v1/login/status` | 登录状态 |
| `GET` | `/v1/login/qrcode.png` | 登录二维码 PNG |
| `GET` | `/v1/login/qrcode/url` | 登录二维码 URL 文本 |
| `POST` | `/v1/login/qrcode/refresh` | 刷新登录二维码 |
| `GET` | `/v1/dialogs` | 会话列表（`cursor`、`limit`、`afterId`） |
| `GET` | `/v1/contacts` | 好友列表（`cursor`、`limit`） |
| `GET` | `/v1/users/:uid` | 按 UID 查询用户资料 |
| `GET` | `/v1/conversations/resolve` | 按 QQ 号或群号解析会话（`kind=friend\|group&id=...`） |
| `GET` | `/v1/conversations/:id` | 会话详情 |
| `GET` | `/v1/conversations/:id/history` | 历史消息（`cursor`、`beforeId`、`afterId`、`aroundUnreadSeq`、`limit`） |
| `GET` | `/v1/conversations/:id/search` | 会话内搜索（`q`、`fromUserId`、`mediaKind` 等） |
| `GET` | `/v1/conversations/:id/members` | 群成员分页（`cursor`、`limit`） |
| `GET` | `/v1/conversations/:id/files` | 群文件与文件夹列表（`folderId`、`cursor`、`limit`） |
| `POST` | `/v1/conversations/:id/members/:userId/moderate` | 群成员管理（设置管理员、禁言、踢人） |
| `POST` | `/v1/conversations/:chatType/:peerUin/notification-mask` | 设置群消息通知策略（`msgMask: 0..4`） |
| `POST` | `/v1/users/:userId/block` | 拉黑或解除拉黑用户 |
| `POST` | `/v1/uploads/prepare` | 预检媒体上传（秒传判定与 Highway 计划） |
| `POST` | `/v1/flash-transfers` | 创建 QQ 闪传文件集（已有媒体秒传 / 新文件流式上传） |
| `POST` | `/v1/messages` | 发送消息（请求头 `x-qqnt-manifest` 传 base64url JSON） |
| `POST` | `/v1/messages/delete` | 撤回消息 |
| `POST` | `/v1/messages/get` | 按 ID 获取单条消息 |
| `POST` | `/v1/messages/forward` | 逐条或合并转发消息 |
| `POST` | `/v1/messages/multi-forward` | 展开合并转发聊天记录 |
| `POST` | `/v1/messages/read` | 标记会话已读 |
| `POST` | `/v1/messages/poke` | 发送戳一戳 |
| `POST` | `/v1/messages/transcribe` | 语音转文字 |
| `POST` | `/v1/messages/inline-callback` | 触发机器人内联按钮回调 |
| `GET` | `/v1/reactions/catalog` | 可用表情回应目录 |
| `GET` | `/v1/messages/reactions` | 获取单条消息的回应状态 |
| `GET` | `/v1/messages/reactions/list` | 获取某条消息的回应成员列表 |
| `POST` | `/v1/messages/reactions` | 设置消息表情回应 |
| `POST` | `/v1/reactions/asset` | 获取自定义回应图标字节（支持 `Range`） |
| `GET` | `/v1/stickers/packs` | 贴纸包列表 |
| `GET` | `/v1/stickers/packs/:packId` | 贴纸包详情 |
| `GET` | `/v1/stickers/saved` | 收藏表情列表 |
| `GET` | `/v1/stickers/:stickerId` | 单个贴纸元数据 |
| `POST` | `/v1/stickers/saved` | 添加或移除收藏表情 |
| `POST` | `/v1/stickers/asset` | 获取贴纸文件字节（支持 `Range`） |
| `POST` | `/v1/files/direct-url` | 刷新 RKey 并返回 QQ CDN 直链 |
| `POST` | `/v1/files/asset` | 流式读取本地/远端媒体字节（支持 `Range`） |
| `GET` | `/v1/requests` | 好友与加群申请列表 |
| `POST` | `/v1/requests/:id/resolve` | 同意或拒绝申请 |
| `POST` | `/v1/calls/media-lease` | 申请语音通话 PCM 通道租约 |
| `POST` | `/v1/calls/control` | 控制语音通话（`accept` / `reject` / `hangup`） |

---

## 3. 关键流程说明

### 3.1 媒体上传与发送（`/v1/uploads/prepare` + `/v1/messages`）

1. **预检（Prepare）**：适配器向 `POST /v1/uploads/prepare` 提交目标会话与文件大小、MD5、SHA-1、前 10 MiB MD5（视频可附带首帧缩略图与分块 SHA-1 状态）。
2. **直传（Highway）**：若返回结果包含 `highway` 计划，适配器直接连接 QQ Highway 服务器上传 1 MiB 数据块；若不含 `highway`，说明已命中 QQ 服务端秒传。
3. **发送（Send）**：适配器调用 `POST /v1/messages`，在 `x-qqnt-manifest` 头中传入 `uploadedMedia`（或有序的 `parts`），请求体为空；仅当发送流式语音（PTT）且 `mediaFraming: 'length-prefixed-v1'` 时，通过请求体流式传输音频数据。

### 3.2 QQ 闪传（`POST /v1/flash-transfers`）

请求头 `x-qqnt-flash-manifest` 携带文件列表，分为三类来源：
- `qq-media`：引用已有 QQ 消息中的文件 Locator，直接复用远端哈希秒传。
- `uploaded`：引用已通过预检上传到 QQ CDN 的文件哈希。
- `upload`：在请求体中按 4 字节大端长度分帧（以 0 长度帧结尾）流式上传的新文件。

服务端通过原生协议创建文件集并返回 `{ fileSetId, shareLink, expiresAt? }`。

### 3.3 媒体下载（`/v1/files/direct-url` 与 `/v1/files/asset`）

- **直链优先**：图片（`imageSpec`: `0` 原图、`198`/`720` 缩略图）、视频与文件优先调用 `/v1/files/direct-url`（内部通过 `OidbSvcTrpcTcp.0x9067_202` 刷新 RKey 或调用 `getVideoPlayUrl`），由客户端或适配器直接向 QQ CDN 发起 HTTP `Range` 请求。
- **流式回退**：语音（PTT 解码为 OGG）或本地缓存资源通过 `/v1/files/asset` 流式读取。

---

## 4. WebSocket 事件流（`/v1/events/ws`）

服务端每 15 秒发送一次 Ping，推送消息格式为：

```json
{ "id": "<eventId>", "event": { "type": "...", ... } }
```

事件类型包括：
- `message`：新消息（含完整 `conversation` 与 `message`）
- `message-delete`：消息撤回
- `message-reactions`：表情回应变更
- `request`：好友或加群申请变更
- `call-signal` / `native-avsdk`：语音通话信令与状态

支持在连接时附加 `?lastEventId=<id>` 从断点之后重放缓存事件。

---

## 5. 语音通话 PCM 通道

1. 调用 `POST /v1/calls/media-lease` 获取 `{ socketPath, leaseId, token, expiry }`。
2. 连接 `socketPath` 对应的本地 Unix Socket，发送认证帧：
   - 格式：`[type: 1B][length: 4B BE][payload]`
   - 认证帧（`type = 0x01`）：`[version=1 (1B)][leaseId hex (16B)][token (32B)]`
   - 服务端就绪后返回 `type = 0x80`。
3. 双向收发 20 ms 音频帧（48 kHz、单声道、s16le，固定 1920 字节）：
   - 上行（`type = 0x02`）：客户端 → Bridge
   - 下行（`type = 0x81`）：Bridge → 客户端
