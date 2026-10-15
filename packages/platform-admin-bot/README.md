# `@mtproto-relay/platform-admin-bot`

在客户端内提供 `@CrossGramAdminBot` 本地管理会话，用于查看服务器状态、平台账号、TOTP 登录码、客户端会话、服务器配置 JSON，以及管理贴纸包关联与扫码登录审批。

## 配置

在 `app.yml` 中启用（或通过 WebUI 插件页开启）：

```yaml
- id: platform-admin-bot
  name: '@mtproto-relay/platform-admin-bot'
  disabled: false
  config:
    allowedPlatformSessionIds: [] # 为空时所有账号可用但仅能管理自身；非空时仅白名单账号可用
    crossAccountAccess: false     # 设为 true 允许白名单账号跨账号管理
    showLoginCodes: true          # 是否显示 6 位实时登录码
    webuiUrl: https://admin.example.com/
    pageSize: 6
```

## 命令

| 命令 | 说明 |
|---|---|
| `/start`、`/menu` | 打开交互菜单 |
| `/help` | 查看帮助 |
| `/status` | 查看服务器运行时间、内存与连接数 |
| `/accounts [页码]` | 查看平台账号状态 |
| `/identities [页码]` | 查看虚拟手机号与实时登录码 |
| `/sessions [页码]` | 查看已登录的客户端设备 |
| `/server`、`/server_json` | 输出客户端导入用的服务器配置 JSON |
| `/stickers [页码]` | 查看并切换贴纸包绑定 |
| `/refresh` | 刷新平台账号与贴纸包 |
| `/approve <平台ID> <登录令牌>` | 批准二维码登录 |
| `/sticker <providerId> <packId> <on\|off> [身份ID]` | 绑定或解绑贴纸包 |
