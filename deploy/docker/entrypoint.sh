#!/bin/sh
set -eu

install_dir=${CROSSGRAM_INSTALL_DIR:-/opt/crossgram}
runtime_dir=$install_dir/.runtime
template=$install_dir/deploy/docker/app.docker.yml
runtime_config=${CROSSGRAM_RUNTIME_CONFIG:-$runtime_dir/app.yml}

: "${CROSSGRAM_STATE_DIR:=/var/lib/crossgram}"
: "${CROSSGRAM_PORT:=4430}"
: "${CROSSGRAM_POSTGRES_HOST:=postgres}"
: "${CROSSGRAM_POSTGRES_PORT:=5432}"
: "${CROSSGRAM_POSTGRES_USER:=crossgram}"
: "${CROSSGRAM_POSTGRES_DATABASE:=crossgram}"
: "${CROSSGRAM_WEBUI_HOST:=0.0.0.0}"
: "${CROSSGRAM_WEBUI_PORT:=3140}"
: "${CROSSGRAM_QQNT_ENDPOINT:=http://qqnt-bridge:18767/v1}"
: "${CROSSGRAM_QQNT_WS_ENDPOINT:=ws://qqnt-bridge:18767/v1/events/ws}"

fail() {
  echo "$1" >&2
  exit 2
}

escape_sed() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

[ -n "${CROSSGRAM_PUBLIC_HOST:-}" ] || fail 'CROSSGRAM_PUBLIC_HOST must be the address Telegram clients connect to'
[ -n "${CROSSGRAM_POSTGRES_PASSWORD:-}" ] || fail 'CROSSGRAM_POSTGRES_PASSWORD must match the postgres service password'

for directory in "$CROSSGRAM_STATE_DIR" "$CROSSGRAM_STATE_DIR/data" \
  "$CROSSGRAM_STATE_DIR/debug-scripts" "$CROSSGRAM_STATE_DIR/debug-results"; do
  mkdir -p "$directory"
done
[ -w "$CROSSGRAM_STATE_DIR/data" ] \
  || fail "$CROSSGRAM_STATE_DIR/data is not writable; check the crossgram-state volume ownership"

if [ -z "${CROSSGRAM_RUNTIME_CONFIG:-}" ]; then
  [ -n "${TELEGRAM_BOT_TOKEN_VERIFIER_SECRET:-}" ] \
    || fail 'TELEGRAM_BOT_TOKEN_VERIFIER_SECRET must be a persistent random secret'
  mkdir -p "$runtime_dir"
  if [ ! -e "$runtime_dir/package.json" ]; then
    ln -sfn ../package.json "$runtime_dir/package.json" 2>/dev/null \
      || cp "$install_dir/package.json" "$runtime_dir/package.json"
  fi
  sed \
    -e "s|__CROSSGRAM_PUBLIC_HOST__|$(escape_sed "$CROSSGRAM_PUBLIC_HOST")|g" \
    -e "s|__CROSSGRAM_STATE_DIR__|$(escape_sed "$CROSSGRAM_STATE_DIR")|g" \
    -e "s|__CROSSGRAM_PORT__|$(escape_sed "$CROSSGRAM_PORT")|g" \
    -e "s|__CROSSGRAM_POSTGRES_HOST__|$(escape_sed "$CROSSGRAM_POSTGRES_HOST")|g" \
    -e "s|__CROSSGRAM_POSTGRES_PORT__|$(escape_sed "$CROSSGRAM_POSTGRES_PORT")|g" \
    -e "s|__CROSSGRAM_POSTGRES_USER__|$(escape_sed "$CROSSGRAM_POSTGRES_USER")|g" \
    -e "s|__CROSSGRAM_POSTGRES_DATABASE__|$(escape_sed "$CROSSGRAM_POSTGRES_DATABASE")|g" \
    -e "s|__CROSSGRAM_QQNT_ENDPOINT__|$(escape_sed "$CROSSGRAM_QQNT_ENDPOINT")|g" \
    -e "s|__CROSSGRAM_QQNT_WS_ENDPOINT__|$(escape_sed "$CROSSGRAM_QQNT_WS_ENDPOINT")|g" \
    -e "s|__CROSSGRAM_WEBUI_HOST__|$(escape_sed "$CROSSGRAM_WEBUI_HOST")|g" \
    -e "s|__CROSSGRAM_WEBUI_PORT__|$(escape_sed "$CROSSGRAM_WEBUI_PORT")|g" \
    "$template" > "$runtime_config"
  chmod 0600 "$runtime_config"
fi

[ -f "$runtime_config" ] || fail "$runtime_config does not exist"

node "$install_dir/deploy/migrate-runtime-config.mjs" "$runtime_config"

echo "Starting Crossgram from $runtime_config (public host $CROSSGRAM_PUBLIC_HOST:$CROSSGRAM_PORT)"
# Avoid the extra ~90 MB Node process corepack and yarn would add.
if [ -f "$install_dir/node_modules/cordis/bin.js" ]; then
  exec node "$install_dir/node_modules/cordis/bin.js" run "$runtime_config"
fi
exec corepack yarn cordis run "$runtime_config"
