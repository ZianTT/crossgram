---
name: debug-mtproto-e2e
description: 使用真实 mtcute MTProto 客户端连接本地或生产 Crossgram 服务，自动完成扫码令牌批准并执行 TypeScript 探测脚本。用于复现客户端可见的 RPC、会话、历史、媒体与更新推送问题。
---

# Debug MTProto E2E

通过 `yarn mtproto:e2e` 运行 `@mtproto-relay/mtproto-e2e-client`，会话凭据保存在 `data/mtproto-e2e/<profile>/credentials.json`。常用探测脚本写法见 [references/probes.md](references/probes.md)。

## 流程

1. **首次认证**：
   - 生产服（通过 SSH 转发本地 WebUI 批准扫码登录）：
     ```sh
     yarn mtproto:e2e auth --profile production --ssh root@118.89.184.208 --platform qqnt
     ```
   - 本地服：
     ```sh
     yarn mtproto:e2e auth --profile local --host 127.0.0.1 --port 4430 --rsa-key data/rsa-key.json --approval-origin http://127.0.0.1:3140 --platform qqnt
     ```
2. **编写并运行探测脚本**（放在 `work/mtproto-e2e/` 下）：
   ```sh
   yarn mtproto:e2e run work/mtproto-e2e/issue.ts --profile production
   ```
3. **补充回归测试**：定位并修复问题后，补充对应的单元测试与端到端测试。

## 安全约定

- 禁止打印、提交或复制 `credentials.json`。
- 除非用户明确授权写操作并指定测试会话，对生产服保持只读探测。
