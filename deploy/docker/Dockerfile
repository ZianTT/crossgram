# syntax=docker/dockerfile:1

# No compiler is needed: every native dependency installs a release binary.
# Use node:24-bookworm when the build host cannot download those binaries.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/opt/crossgram/.corepack \
    YARN_ENABLE_SCRIPTS=true \
    HUSKY=0

RUN corepack enable

# The slim base has no `ps`.
RUN apt-get update \
 && apt-get install -y --no-install-recommends procps \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/crossgram
COPY . .

# yarn's ~350 MB cache is only needed while installing, so it goes in this layer.
RUN corepack yarn install --immutable \
 && corepack yarn build \
 && rm -rf /root/.yarn /root/.npm

RUN useradd --system --create-home --home-dir /var/lib/crossgram --shell /usr/sbin/nologin crossgram \
 && install -d -m 0750 -o crossgram -g crossgram /opt/crossgram/.runtime \
 && install -d -m 0700 -o crossgram -g crossgram /var/lib/crossgram \
      /var/lib/crossgram/data /var/lib/crossgram/debug-scripts /var/lib/crossgram/debug-results \
 && chown -R crossgram:crossgram /opt/crossgram/.corepack \
 && ln -sfn ../package.json /opt/crossgram/.runtime/package.json \
 && chmod 0755 /opt/crossgram/deploy/docker/entrypoint.sh \
 && chmod 0755 /opt/crossgram/deploy/docker/healthcheck.mjs

USER crossgram
ENV HOME=/var/lib/crossgram \
    NODE_OPTIONS="--import tsx --import @cordisjs/unyaml"
EXPOSE 4430 3140
ENTRYPOINT ["/opt/crossgram/deploy/docker/entrypoint.sh"]
