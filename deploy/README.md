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

## 5. Docker Compose 部署

`deploy/docker-compose.yml` 用容器部署同一套生产配置：PostgreSQL、Crossgram（WebUI 仅绑定本机）以及 `qqnt` profile 下的 QQNT bridge。状态保存在 `crossgram-state`、`crossgram-postgres`、`crossgram-qqnt` 三个卷中。

从检出的仓库部署：

```sh
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env   # CROSSGRAM_PUBLIC_HOST、数据库密码、Bot Token 校验密钥
docker compose -f deploy/docker-compose.yml up -d
```

不检出仓库也可以部署，只要这一份编排文件（镜像从 GHCR 拉取）：

```sh
mkdir crossgram && cd crossgram
curl -fsSLO https://raw.githubusercontent.com/std-microblock/crossgram/main/deploy/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/std-microblock/crossgram/main/deploy/.env.example -o .env
# 填 CROSSGRAM_PUBLIC_HOST、CROSSGRAM_POSTGRES_PASSWORD、TELEGRAM_BOT_TOKEN_VERIFIER_SECRET
docker compose up -d
```

- 钉住版本就把 URL 里的 `main` 换成 tag（如 `v1.2.3`）。
- 该文件只使用 `image:` 与命名卷，不读检出目录里的任何东西，也不需要 `build:`；拉取失败时不会退化成构建。
- 要改代码/本地构建时叠加 `deploy/docker-compose.build.yml`：`docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.build.yml up -d --build`（本地开发与 CI e2e 走这条）。
- 只对外发布 MTProto（`CROSSGRAM_BIND:CROSSGRAM_PORT`，默认 `0.0.0.0:4430`），WebUI 仅发布到 `127.0.0.1:3140`；PostgreSQL 与 bridge 不发布端口，服务间通过 compose 默认网络用服务名互访。
- 镜像各由自己的仓库发布：本仓 `.github/workflows/docker.yml` 推 `ghcr.io/std-microblock/crossgram`，bridge 镜像由 [xuuuuan/crossgram-qqnt](https://github.com/xuuuuan/crossgram-qqnt) 按 release tag 推送。GHCR 新包默认私有，需先设为 public 或 `docker login ghcr.io`；fork 可用 `CROSSGRAM_IMAGE`、`CROSSGRAM_QQNT_IMAGE` 覆盖镜像地址。
- Crossgram 镜像基于 `node:24-bookworm-slim`，安装 yarn 缓存与删除放在同一层（1.92 GB → 645 MB），无需编译器（原生依赖都装预编译二进制）；构建机下载不到这些二进制时改用 `CROSSGRAM_NODE_IMAGE=node:24-bookworm`。
- 容器每次启动都会渲染运行时配置：`deploy/docker/app.docker.yml` 加 compose 环境 → `/opt/crossgram/.runtime/app.yml`，并执行与 `crossgram-update` 相同的 `migrate-runtime-config.mjs`；想完全接管可把 `CROSSGRAM_RUNTIME_CONFIG` 指向手写 YAML。
- bridge 容器自带健康检查（`qqntctl status`，启动后 3 分钟内为 `starting`），compose 因此不再重复声明；`docker ps` 可见，`up --wait` 会等它。`CROSSGRAM_QQNT_QQ_FLAGS` 可给 QQ 追加 Chromium 参数（实测 `--no-zygote --js-flags=--max-old-space-size=512` 让 bridge 空闲内存从 171 MB 降到 137 MB）。
- 内存默认不限制：compose 里每个服务的 `deploy:` 上限块都是注释，取消注释即生效（参考值 PostgreSQL `768m`、Crossgram `2g`、bridge `2g`）。实测空闲占用合计约 600 MB（PostgreSQL ~105 MB、Crossgram ~355 MB、bridge ~170 MB）；设了上限时 Node 会据此收缩 V8 堆（`2g` 对应约 1.1 GB）。
- `deploy/docker-deploy-files.test.ts` 覆盖 compose 与镜像定义；`CROSSGRAM_DOCKER_E2E=1 yarn vitest run deploy/docker-compose.e2e.test.ts` 会真实构建并启动 PostgreSQL 与 Crossgram 并检查两个发布端口，加 `CROSSGRAM_DOCKER_E2E_QQNT=1` 会带上 bridge profile。
