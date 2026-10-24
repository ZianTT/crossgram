# `@mtproto-relay/platform-discord`

Discord 普通用户账号（Userbot）适配器，将私聊、群组、服务器文字/公告频道及子线程桥接到 Telegram 客户端。

> [!CAUTION]
> 使用普通用户 Token 自动化操作违反 Discord 服务条款，可能导致账号受限或封禁，请使用独立账号。

## 配置

```yaml
- id: discord
  name: '@mtproto-relay/platform-discord'
  config:
    token: YOUR_USER_TOKEN
    # 可选 HTTP(S) 代理（同时作用于 REST、Gateway WebSocket 与 CDN 媒体下载）
    proxy: http://127.0.0.1:7890
```

## 端到端测试

```bash
DISCORD_USER_TOKEN=... DISCORD_E2E_CHANNEL_ID=... yarn workspace @mtproto-relay/platform-discord test:e2e
```
