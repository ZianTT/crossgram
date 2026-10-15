# `@mtproto-relay/platform-wechat`

对接 Windows 端 **ComWeChat** HTTP 与本地 TCP 回调接口的微信适配器。

## 配置

```yaml
- id: wechat
  name: '@mtproto-relay/platform-wechat'
  disabled: true
  config:
    endpoint: http://127.0.0.1:18888/api/
    callbackPort: 23456
    requestTimeoutMs: 30000
    maxCallbackBytes: 1048576
    maxCallbackConnections: 32
```

## 能力与安全边界

- **只读接收**：仅支持账号信息、联系人与群会话同步、群成员列表和实时文本消息接收；媒体消息（图片、文件、语音、视频、动画表情）统一渲染为文本说明，不支持发送消息或拉取历史。
- **安全隔离**：ComWeChat 自身无鉴权机制，切勿将其端口暴露到公网。本适配器的回调监听仅绑定 `127.0.0.1`，且拒绝读取回调中携带的本地磁盘文件路径，防止任意文件读取风险。
