# Telegram API Schema 镜像

本目录由 `yarn schema:sync` 从 `https://core.telegram.org/schema` 自动抓取生成，请勿手动编辑。

- `manifest.json`：记录各 Layer 的版本号、大小与 SHA-256 校验值。
- `layer-*.tl`：各历史 Layer 的原始 TL 文本定义。MTProto 运行时会在校验 SHA-256 后，通过 `@mtcute/tl-utils` 为旧版本客户端按需生成读写映射。
