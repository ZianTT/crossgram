---
name: debug-android-e2e
description: 使用 AVD、编程式 Activity/View 探测、logcat、MTProto 抓包与文件缓存复现并排查 Android 客户端问题。适用于登录卡死、媒体/回应/贴纸加载失败、队列饥饿与自定义服务器路由问题。
---

# Debug Android E2E

直接驱动真实生产 Activity 与 View，禁止通过坐标点击或截图代替真实逻辑校验。详细排查模式见 [references/android-reaction-debugging.md](references/android-reaction-debugging.md)。

## 流程

1. 在独立 worktree 中工作；修改或构建共享源码前先获取主工作区锁。
2. 先运行常规源码补丁（`yarn patch:source`），再注入 E2E 补丁（`yarn e2e:source`）。
3. 通过 `CrossgramE2eActivity` 或真实 Activity 方法触发目标逻辑，并在 logcat 中输出结构化状态标记（禁止打印密钥、Token 或无关聊天内容）。
4. 对照 Android 内存状态、本地缓存文件、logcat 与服务端 MTProto 抓包定位问题。
5. 修复后运行单测、构建检查与 AVD E2E，并清理临时脚本与调试配置。

## UI 与媒体验证原则

- **禁止坐标点击**：直接实例化或获取真实 View，设置好 `LayoutParams` 与 Delegate 后调用业务方法。
- **RecyclerView 遍历**：逐页等待可见项加载完毕并记录位置，滚动覆盖全部条目后才算通过。
- **拒绝占位图假阳性**：网络图片必须同时满足 `ImageReceiver.hasImageLoaded()` 且 `FileLoader` 对应缓存文件已落盘。
