# `@mtproto-relay/group-auto-kick`

群满员自动踢人插件：当指定群的人数达到 `maxMembers` 时，自动移出最久未发言的成员，将人数降到 `targetMembers`（若 `maxMembers` 与 `targetMembers` 设为同一数值，则仅踢出刚超出阈值的成员）。

## 行为规则

- 每隔 `intervalMs`（默认 5 分钟）巡检一次，启动或会话上线后延迟 `startupDelayMs` 触发首轮巡检。
- 仅当 `群当前人数 >= maxMembers` 时拉取完整成员列表并按最后活跃时间从旧到新排序：
  - 活跃时间取 `mtproto_im_message` 中该成员在本群的最新消息时间；
  - 入群系统提示（如「A 邀请 B 加入了群聊」）计入被邀请人 B 的活跃时间；
  - 没有任何发言或入群记录的成员默认排在最前（可通过 `unknownLastSpoke: 'newest'` 改为排在最后）；
  - 群主、当前登录账号与管理员（`protectAdministrators: true` 时）永不踢出。
- 单轮最多踢出 `maxKicksPerRound` 人，每次间隔 `kickIntervalMs`。执行踢出前会再次核对最新发言时间，避免误踢刚发言的成员。

## 配置

```yaml
- id: group-auto-kick
  name: '@mtproto-relay/group-auto-kick'
  config:
    dryRun: true # 建议先设为 true 观察日志名单，确认无误后改为 false
    intervalMs: 300000
    groups:
      - conversationId: 1002974327 # QQ 群号或 Telegram chat id (-100...)
        label: 示例群
        maxMembers: 2000
        targetMembers: 1995
        maxKicksPerRound: 10
        protectAdministrators: true
        rejectAddRequest: false
```

### 群规则项

| 字段 | 默认值 | 说明 |
|---|---|---|
| `conversationId` | 必填 | 平台群号或 Telegram 群 ID（`-100...`） |
| `label` | 会话标题 | 日志显示名称 |
| `platformSessionId` | 全部在线会话 | 限定所属平台账号 |
| `maxMembers` | `2000` | 触发踢人的人数阈值 |
| `targetMembers` | `1995` | 踢人后保留的目标人数（`<= maxMembers`） |
| `maxKicksPerRound` | `10` | 单轮最多踢出人数 |
| `protectAdministrators` | `true` | 是否跳过群管理员 |
| `unknownLastSpoke` | `'oldest'` | 无记录成员的排序位置（`'oldest'` 优先踢 / `'newest'` 排最后） |
| `rejectAddRequest` | `false` | 踢出后是否禁止再次加群 |

### 全局配置项

| 字段 | 默认值 | 说明 |
|---|---|---|
| `dryRun` | `false` | 仅打印拟踢名单，不实际踢人 |
| `intervalMs` | `300000` | 巡检间隔（毫秒） |
| `startupDelayMs` | `30000` | 启动后首次巡检延迟（毫秒） |
| `kickIntervalMs` | `1000` | 连续踢人间隔（毫秒） |
| `rankingTtlMs` | `1800000` | 消息活跃度排行缓存时间（毫秒） |
| `memberPageSize` | `500` | 成员分页拉取大小 |
| `maxMemberScan` | `5000` | 单次扫描成员数上限 |
| `scanDeadlineMs` | `60000` | 扫描群成员超时时间（毫秒） |
| `maxRankingScan` | `2000000` | 扫描历史消息行数上限 |

## 手动触发

可通过 `ctx.groupAutoKick` 服务手动执行或清理缓存：

```ts
export function apply(ctx: any) {
  void ctx.groupAutoKick.run('manual')
  void ctx.groupAutoKick.invalidate()
}
```
