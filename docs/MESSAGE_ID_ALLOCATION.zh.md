# Telegram 消息 ID 分配

Telegram 消息 ID 是正数 `int32`（`1..0x7fffffff`）。Bridge 需要将平台消息映射为单调递增的 Telegram 消息 ID，同时支持历史消息乱序回填、同秒多条消息以及一条平台消息拆分为多个 Telegram 消息分片。

## 唯一域（Scope）

不同会话类型使用独立的 ID 命名空间与 Epoch：

| 会话类型 | 唯一域 | 说明 |
|---|---|---|
| 私聊 `direct` | `account:<platformSessionId>` | 同一账号下所有私聊共用递增 ID 空间 |
| 群聊 `group` / 频道 `channel` | `channel:<platformSessionId>:<conversationId>` | 每个群或频道独立分配 ID |
| 话题子频道（Forum Topic） | 父频道的 `channel` 域 | 与所属 Megagroup 共用 ID 空间 |

数据库通过 `mtproto_tl_message_part(scope, tlMessageId)` 唯一索引保证域内不冲突。

## 时间戳分桶

每秒划分 16 个槽位（4 bit），剩余 27 bit 表示相对秒数：

```text
bucket = (timestampSeconds - epoch) * 16
tgid   = bucket + slot   (slot = 0..15)
```

最大相对秒数为 `134,217,727` 秒（约 4.25 年）。

每个唯一域首次分配 ID 时，将首条消息定在 ID 空间中点（`0x40000000`），前后各留约 2.13 年窗口，并将 `epoch` 持久化到 `mtproto_message_id_epoch`。

## 槽位选择与邻秒溢出

1. **同秒槽位分配**：带原生序号（如 QQ `msgSeq`）的消息优先取当前秒可用槽位的中位数，为乱序到达的同秒消息留出前后插入空间；无序号消息（如灰条）从最小空闲槽位开始分配。
2. **邻秒溢出**：当目标秒 16 个槽位占满时，实时消息优先向后一秒搜索，历史回填消息优先向前一秒搜索；多图相册分片优先向后连续分配以保持 ID 递增。
3. **序号边界约束**：首轮搜索严格限制在同一会话相邻 `msgSeq` 对应的 Telegram ID 区间内；若旧数据已将相邻序号夹紧到无空闲整数，第二轮搜索放宽序号边界并就近分配空闲槽位，优先保证消息入库不阻塞。

## QQ `msgSeq` 与持久化

- `msgSeq` 不直接编码进 ID 数值，而是作为 `nativeSequence` 持久化，用于历史分页边界判断与 `replayMsgSeq` 回复目标反查。
- 消息一旦生成当前版本的投影，其 Telegram ID 永不改变。QQ 发送回执后续修正临时 `msgSeq` 时，仅原地更新 `nativeSequence`，不重分 ID。
