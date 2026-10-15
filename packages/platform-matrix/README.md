# `@mtproto-relay/platform-matrix`

Matrix Client-Server API 适配器，将已加入的 Matrix 房间桥接到 Telegram 客户端。

## 配置

```yaml
- id: matrix
  name: '@mtproto-relay/platform-matrix'
  config:
    homeserver: https://matrix.example.com
    accessToken: replace-with-your-access-token
    userId: '@alice:example.com' # 可选，省略时通过 /account/whoami 自动获取
    proxy: http://127.0.0.1:7890 # 可选 HTTP(S) 代理
    syncTimeoutMs: 30000
    requestTimeoutMs: 30000
```

## 支持范围与限制

- **已支持**：私聊与群聊房间、Matrix Space、历史记录、增量 `/sync`、文字/图片/文件/音视频收发、回复、已读标记、纯文本编辑、撤回（Redaction）、成员列表与权限映射、头像。
- **暂不支持**：端到端加密（加密事件会显示为显式占位提示）、表情回应（Reaction）、贴纸与原生转发。

## 测试

```bash
yarn workspace @mtproto-relay/platform-matrix test
yarn workspace @mtproto-relay/platform-matrix test:e2e
```
