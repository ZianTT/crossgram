# Crossgram Voice Worker

独立的 Rust 本地语音通话进程，负责 Telegram 1v1 语音通话的 DH 密钥交换、信令转发与 48 kHz 单声道 PCM 帧收发：

- 长度前缀的本地二进制 IPC，DH 私钥指数仅在 Worker 进程内部生成，不通过 IPC 暴露；
- 单路通话状态机，支持主叫（`PrepareCaller` → `CompleteCaller`）与被叫（`PrepareRecipient` → `CompleteRecipient`）完整握手及 Telegram 2048-bit DH 参数校验；
- 可选启用 `tgcalls-backend` 特性对接原生 `tgcalls` 会话（参见 `native/tgcalls-shim`）。

Worker 默认从标准输入/输出收发二进制帧；传入 `--unix <path>` 时监听本地 Unix Socket（父目录权限 `0700`，Socket 权限 `0600`，Linux 下通过 `SO_PEERCRED` 校验同 UID 进程，每次连接处理单次请求/响应，读写超时 5 秒）。

## 启动

使用 Nix 一键启动：

```sh
nix run .#voice-worker
```

未传参数时，按以下优先级选择 Socket 路径（需将 Bridge 的 `voiceWorkerSocketPath` 配为同一路径）：

1. `$CROSSGRAM_VOICE_WORKER_SOCKET`
2. `$XDG_RUNTIME_DIR/crossgram/voice-worker.sock`
3. `${TMPDIR:-/tmp}/crossgram-voice-worker-$UID/worker.sock`

也可显式指定路径：

```sh
nix run .#voice-worker -- --unix /custom/path/worker.sock
```

## IPC 帧格式

每条消息由 4 字节大端长度前缀 + 负载组成，负载首字节为 protocol version (`3`)，次字节为消息 Tag。除特别注明小端（LE）的字段外，整数字段均为大端（BE）。

### 请求帧

| Tag | 负载字段 | 说明 |
|---|---|---|
| `0x01` | `call_id: u64` | 主叫准备（生成 `ga_hash`） |
| `0x02` | `call_id: u64`, `ga_hash: [u8; 32]` | 被叫准备（生成 `gb`） |
| `0x03` | `call_id: u64`, `gb: [u8; 256]` | 主叫完成握手 |
| `0x04` | `call_id: u64`, `ga: [u8; 256]`, `expected_fingerprint: i64` (LE) | 被叫完成握手 |
| `0x05` | `call_id: u64`, `request_id: u64`, `signal_length: u16`, `signal: [u8; len]` | 转发信令（上限 32 KiB） |
| `0x06` | `call_id: u64` | 挂断通话 |
| `0x07` | `call_id: u64`, `request_id: u64` | 绑定单次 PCM 端点令牌 |
| `0x08` | `call_id: u64`, `capability: [u8; 32]`, `pcm: [u8; 1920]` | 发送一帧 20 ms PCM（48 kHz 单声道 s16le） |
| `0x09` | `call_id: u64`, `capability: [u8; 32]` | 拉取一帧下行 PCM |
| `0x0a` | `call_id: u64`, `capability: [u8; 32]` | 关闭 PCM 端点并结束通话 |

### 响应帧

| Tag | 负载字段 | 说明 |
|---|---|---|
| `0x81` | `ga_hash: [u8; 32]` | 主叫准备完成 |
| `0x82` | `gb: [u8; 256]` | 被叫准备完成 |
| `0x83` | `ga: [u8; 256]`, `fingerprint: i64` (LE) | 主叫握手完成 |
| `0x84` | `fingerprint: i64` (LE) | 被叫握手完成 |
| `0x85` | `request_id: u64` | 信令已转发 |
| `0x86` | 无 | 已挂断 |
| `0x87` | `request_id: u64`, `capability: [u8; 32]` | 返回 PCM 端点令牌 |
| `0x88` | 无 | 已接收上行 PCM 帧 |
| `0x89` | `pcm: [u8; 1920]` | 返回下行 PCM 帧 |
| `0x8a` | 无 | 当前无可用下行 PCM 帧 |
| `0x8b` | 无 | PCM 端点与通话已关闭 |
| `0xff` | `error_code: u8` | 错误（`1` 请求非法、`2` 忙、`3` 状态错误、`4` 密码学校验失败、`5` 媒体后端不可用） |

## 测试与检查

```sh
cargo fmt --check --manifest-path packages/voice-worker/Cargo.toml
cargo test --locked --manifest-path packages/voice-worker/Cargo.toml
cargo clippy --locked --manifest-path packages/voice-worker/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path packages/voice-worker/Cargo.toml --features tgcalls-backend
```
