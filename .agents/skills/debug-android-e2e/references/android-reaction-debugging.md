# Android 回应、媒体与登录调试参考

## 1. AVD 与自定义服务器路由

Android 模拟器通过 `10.0.2.2` 访问宿主机。启用自定义服务器时，主连接与媒体连接（IPv4 类型 `0` 与 `2`）都必须使用自定义路由，避免 `FileLoader` 根据 `help.getConfig.dc_options` 回退连接到不可达的 `127.0.0.1`。

## 2. 回应面板（Reactions）探测

在真实 Activity 中构造 `ReactionsContainerLayout` 时必须按顺序执行：
1. 构造面板并设置只读 Delegate
2. 设置 `LayoutParams`
3. 调用 `setMessage(...)`
4. 挂载到窗口 DecorView 并启动进入动画

紧凑栏与展开面板（`showCustomEmojiReactionDialog()`）需分别校验 `ImageReceiver.hasImageLoaded()` 及对应的落盘文件。冷启动测试前必须清空全部回应目录缓存文件。

## 3. 媒体队列常见问题

- **`Document.size` 必须等于实际返回字节数**：若声明大小比实际多，客户端 `FileLoadOperation` 会在 EOF 处无限等待下一分片并占死下载队列。
- **原始格式自定义回应**：APNG/GIF/PNG 等无独立缩略图的自定义表情，必须直接加载 `ImageLocation.getForDocument(document)`。

## 4. 首次登录探测

测试首次登录前执行 `adb shell pm clear <package>` 并授予通知权限。按顺序确认以下 logcat 标记：
`server_config_applied` → `page_opened:login` → `login_phone_submitted` → `login_code_page_ready` → `login_code_submitted` → `state activated=true`。

## 5. 原生与 Java 构建注意

- 修改 C++ (`tgnet`) 后执行完整原生编译，并删除预编译的 `TMessagesProj/src/main/libs/x86_64/libtmessages.49.so`，防止 Gradle `pickFirst` 打入旧库。
- 仅修改 Java 代码时可设置 `NAGRAM_BUILD_ARGS=skip_buildCMakeDebug` 跳过 CMake 编译。
