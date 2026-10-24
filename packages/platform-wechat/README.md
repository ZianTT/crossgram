# `@mtproto-relay/platform-wechat`

对接 Windows 端 **ComWeChat** HTTP 与本地 TCP 回调接口的微信适配器。

## 配置

```yaml
- id: wechat
  name: '@mtproto-relay/platform-wechat'
  disabled: true
  config:
    endpoint: http://127.0.0.1:18888/api/
    callbackHost: 127.0.0.1
    callbackPort: 23456
    requestTimeoutMs: 30000
    maxCallbackBytes: 1048576
    maxCallbackConnections: 32
```

## 能力与安全边界

- **只读接收**：仅支持账号信息、联系人与群会话同步、群成员列表和实时文本消息接收；媒体消息（图片、文件、语音、视频、动画表情）统一渲染为文本说明，不支持发送消息或拉取历史。
- **安全隔离**：ComWeChat 自身无鉴权机制，切勿将其端口暴露到公网。回调监听默认绑定 `127.0.0.1`，限制请求体大小，并拒绝读取回调中携带的本地磁盘文件路径。

跨主机部署时，把 `callbackHost` 设为 CrossGram 的指定局域网 IP，把 `callbackAllowedAddress` 设为 Windows 主机的局域网 IP。适配器拒绝通配地址监听；回调协议没有鉴权令牌，还应在主机防火墙上只允许这台 Windows 主机访问回调端口。

ComWeChat 的消息 Hook 只接受回调**端口**，并连接其本机地址。需要先在 Windows 管理员 PowerShell 中将该端口转发到 CrossGram，例如：

```powershell
netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=23456 connectaddress=10.21.0.213 connectport=23456
```

随后配置 `endpoint: http://10.21.0.51:8000/api/`、`callbackHost: 10.21.0.213` 和 `callbackAllowedAddress: 10.21.0.51`。请替换示例地址。`portproxy` 依赖 Windows IP Helper 服务，且规则会一直保留，直到手动删除。
