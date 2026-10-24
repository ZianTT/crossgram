# `@mtproto-relay/platform-qqnt`

对接 `qqnt-bridge` 本地服务的 QQ 平台适配器（源码目录 `packages/platform-crossgram`）。

## 配置

```yaml
- id: qqnt
  name: '@mtproto-relay/platform-qqnt'
  config:
    endpoint: http://127.0.0.1:18767/v1
    # 可选：单独指定 WebSocket 事件流地址（默认从 endpoint 推导为 ws://.../v1/events/ws）
    # webSocketEndpoint: ws://127.0.0.1:18767/v1/events/ws
    # 可选：访问令牌，省略时读取环境变量 QQNT_BRIDGE_TOKEN
    # token: your-secret-token
    # 屏蔽包含指定文字的灰条提示，设为 [] 则保留全部灰条
    grayTipFilters:
      - 回应了你的消息
    # 是否在消息送达后异步生成 40px 内联模糊缩略图（photoStrippedSize）
    generatePreviews: false
    previewConcurrency: 2
```

## 核心机制

- **媒体直链与原始格式**：图片、视频、文件、贴纸与回应图标均保持 QQ 原始格式，不在服务端做 GIF/APNG/WebM 转码。支持直连的客户端通过 `crossgram.getFileUrl` 向 `/v1/files/direct-url` 刷新 RKey 后，直接以 HTTP Range 从 QQ CDN 拉取；用户与群头像直连 qlogo CDN。
- **秒传与 Highway 流式上传**：客户端调用 `crossgram.prepareMediaUpload*` 提交文件哈希。若命中 QQ 秒传则直接跳过上传；未命中时，Bridge 将客户端上传的分片在内存窗口内按序拼成 1 MiB 分块，直接流式推送至 QQ Highway 服务器，无需落盘中转。
- **语音消息（PTT）**：QQ 语音投影为 Telegram 语音消息（`audio/ogg`），发送 Telegram 语音消息时流式转码为原生 QQ PTT 语音条。
- **会话与联系人分离**：会话列表来自 QQ `RecentContact`，联系人列表来自完整好友列表，避免将全部好友和群塞进聊天列表；群成员昵称与群名片分别映射为 Telegram 用户名和群头衔（tag）。
- **表情回应（Reaction）**：Unicode 表情映射为 Telegram 标准回应，QQ 系统黄脸（SysFace）映射为自定义 Emoji 文档；默认过滤冗余的「回应了你的消息」灰条。

## 测试

```sh
yarn vitest run packages/platform-crossgram
```

针对运行中的真实 `qqnt-bridge` 执行端到端测试（仅向白名单测试号/测试群发信）：

```sh
QQNT_BRIDGE_E2E=1 yarn vitest run packages/platform-crossgram/src/e2e.test.ts
```
