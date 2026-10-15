---
name: lock-main-workspace
description: 通过 Git 公共目录维护跨 worktree 的 FIFO 互斥锁，协调多个 Agent 对主工作区的独占访问（如测试、构建、切换分支或合并）。
---

# Lock Main Workspace

使用零依赖脚本 `.agents/skills/lock-main-workspace/scripts/workspace-lock.mjs` 获取与释放主工作区锁。

## 用法

```sh
# 1. 排队获取锁（返回 ACQUIRED 后锁保持持有，直到显式 release）
node .agents/skills/lock-main-workspace/scripts/workspace-lock.mjs acquire --agent "<agent-id>" --label "run tests"

# 2. 完成工作后（无论成功或失败）立即释放锁
node .agents/skills/lock-main-workspace/scripts/workspace-lock.mjs release --agent "<agent-id>"

# 查看当前锁状态与等待队列
node .agents/skills/lock-main-workspace/scripts/workspace-lock.mjs status
```

仅在确认原持有者已异常退出且无法自行释放时，才可使用 `--force` 强制解锁。
