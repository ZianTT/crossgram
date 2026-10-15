# Linux 生产部署

Crossgram 以低权限用户 `crossgram` 运行。代码检出位于 `/opt/crossgram`，Auth Key、RSA 密钥、上传分片与媒体缓存位于 `/var/lib/crossgram/data`，运行时配置位于 `/opt/crossgram/.runtime/app.yml`（不受 Git 跟踪，更新时不会被覆盖）。

生产环境默认使用 PostgreSQL，WebUI 仅监听 `127.0.0.1:3140`，MTProto 监听 `4430` 端口。

## 1. 安装

公开仓库可直接执行：

```sh
curl -fsSL https://raw.githubusercontent.com/std-microblock/crossgram/main/deploy/install.sh \
  | sudo CROSSGRAM_PUBLIC_HOST=203.0.113.10 sh
```

若使用私有仓库，先为 `crossgram` 用户（`/var/lib/crossgram/.ssh`）配置只读 Deploy Key，克隆仓库到 `/opt/crossgram`，再运行：

```sh
sudo CROSSGRAM_PUBLIC_HOST=203.0.113.10 /opt/crossgram/deploy/install.sh
```

服务会自动从 `/etc/qqnt-bridge.env` 读取 `QQNT_BRIDGE_TOKEN`，无需写入 `app.yml`。

## 2. 初始化密钥与数据库

首次启动前，在 `/etc/crossgram.env` 中生成持久化 Bot Token 校验密钥：

```sh
umask 077
printf 'TELEGRAM_BOT_TOKEN_VERIFIER_SECRET=%s\n' "$(openssl rand -base64 48 | tr -d '\n')" \
  | sudo tee -a /etc/crossgram.env >/dev/null
```

初始化本地 PostgreSQL 角色与数据库（幂等执行，自动将随机密码写入 `/etc/crossgram.env`）：

```sh
sudo /opt/crossgram/deploy/provision-postgres.sh
```

如需启用贴纸包导入插件（Sticker Importer），在 `/etc/crossgram.env` 中配置 `TELEGRAM_STICKER_IMPORTER_BOT_TOKEN` 并在 `.runtime/app.yml` 中启用该插件。

## 3. 更新服务

```sh
sudo crossgram-update
```

`crossgram-update` 仅执行 `origin/main` 快进合并、`yarn install --immutable`、`yarn build` 并重启服务，不会改动 `/var/lib/crossgram` 下的数据。

## 4. 导出客户端配置

服务首次启动并生成 RSA 密钥后，可生成供客户端导入的服务器配置 JSON：

```sh
sudo crossgram-client-config --host 203.0.113.10 --port 4430 \
  --name 'CrossGram Server' --output /tmp/crossgram-server.json
```
