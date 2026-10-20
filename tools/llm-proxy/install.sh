#!/usr/bin/env bash
# Install (or upgrade, or remove) the Companion LLM proxy as a systemd
# service on the host that runs vLLM. Idempotent: run it again to upgrade
# the script; the config file is created once and then left alone.
#
#   sudo ./install.sh --user <service-user> --upstream http://127.0.0.1:8000 \
#        [--listen 0.0.0.0:8787] [--model <served-model-name>] [--context 131072]
#        [--runtime /path/to/node]   # when node is not on the user's login PATH (nvm)
#   sudo ./install.sh --uninstall [--purge]     # --purge also deletes the config (token)
#
# Installs:
#   /opt/companion-llm-proxy/llm-proxy.mjs            the proxy (no dependencies)
#   /etc/companion-llm-proxy/config.json              0600, owned by the service user
#   /etc/systemd/system/companion-llm-proxy.service   enabled at boot, Restart=always
# Logs go to journald: journalctl -u companion-llm-proxy -f
#
# --destdir DIR writes everything under DIR and skips systemctl and the user
# check (packaging, tests). See docs/local-llm.md.
set -euo pipefail

NAME="companion-llm-proxy"
SERVICE_USER=""
UPSTREAM=""
LISTEN="0.0.0.0:8787"
MODEL=""
CONTEXT=""
DESTDIR=""
RUNTIME=""
UNINSTALL=0
PURGE=0

usage() { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --user) SERVICE_USER="$2"; shift 2 ;;
    --upstream) UPSTREAM="$2"; shift 2 ;;
    --listen) LISTEN="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --context) CONTEXT="$2"; shift 2 ;;
    --destdir) DESTDIR="${2%/}"; shift 2 ;;
    --runtime) RUNTIME="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 2 ;;
  esac
done

APP_DIR="$DESTDIR/opt/$NAME"
CONF_DIR="$DESTDIR/etc/$NAME"
CONF="$CONF_DIR/config.json"
UNIT="$DESTDIR/etc/systemd/system/$NAME.service"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

systemctl_() { if [ -z "$DESTDIR" ]; then systemctl "$@"; fi; }

if [ -z "$DESTDIR" ] && [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo): it installs a system service." >&2
  exit 1
fi

if [ "$UNINSTALL" -eq 1 ]; then
  systemctl_ disable --now "$NAME" 2>/dev/null || true
  rm -f "$UNIT"
  rm -rf "$APP_DIR"
  systemctl_ daemon-reload
  if [ "$PURGE" -eq 1 ]; then rm -rf "$CONF_DIR"; echo "Removed $NAME and its config."; else echo "Removed $NAME (config kept in $CONF_DIR; --purge deletes it)."; fi
  exit 0
fi

[ -n "$SERVICE_USER" ] || { echo "--user is required (the account the service runs as)" >&2; exit 2; }
if [ -z "$DESTDIR" ] && ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "No user $SERVICE_USER" >&2
  exit 2
fi

# A runtime the service user can run: Node >= 22, else Bun.
find_runtime() {
  local cmd
  if [ -n "$DESTDIR" ]; then cmd="$(command -v node || command -v bun || true)";
  else cmd="$(su -s /bin/bash - "$SERVICE_USER" -c 'command -v node || command -v bun' 2>/dev/null || true)"; fi
  [ -n "$cmd" ] || { echo "Neither node (>= 22) nor bun found for $SERVICE_USER" >&2; exit 3; }
  if [ "$(basename "$cmd")" = "node" ]; then
    local major
    major="$("$cmd" -p 'process.versions.node.split(".")[0]')"
    [ "$major" -ge 22 ] || { echo "$cmd is Node $major: Node >= 22 is required (or install bun)" >&2; exit 3; }
  fi
  readlink -f "$cmd"
}
[ -n "$RUNTIME" ] || RUNTIME="$(find_runtime)"

install -d -m 0755 "$APP_DIR"
install -m 0755 "$HERE/llm-proxy.mjs" "$APP_DIR/llm-proxy.mjs"

# The config: created once (with a new token), never overwritten.
CREATED=0
if [ ! -f "$CONF" ]; then
  [ -n "$UPSTREAM" ] || { echo "--upstream is required at the first install (the vLLM URL, e.g. http://127.0.0.1:8000)" >&2; exit 2; }
  TOKEN="$(openssl rand -hex 24 2>/dev/null || "$RUNTIME" -e 'console.log(require("node:crypto").randomBytes(24).toString("hex"))')"
  HOST="${LISTEN%:*}"; PORT="${LISTEN##*:}"
  install -d -m 0700 "$CONF_DIR"
  (umask 077 && "$RUNTIME" -e '
    const [host, port, url, token, model, context, file] = process.argv.slice(1);
    const cfg = { listen: { host, port: Number(port) }, upstream: { url, token: "" }, token };
    if (model) cfg.model = model;
    if (context) cfg.contextWindow = Number(context);
    require("node:fs").writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  ' "$HOST" "$PORT" "$UPSTREAM" "$TOKEN" "$MODEL" "$CONTEXT" "$CONF")
  CREATED=1
fi
chmod 0700 "$CONF_DIR"
chmod 0600 "$CONF"
if [ -z "$DESTDIR" ]; then chown -R "$SERVICE_USER" "$CONF_DIR"; fi

install -d -m 0755 "$(dirname "$UNIT")"
install -m 0644 /dev/null "$UNIT"
cat > "$UNIT" <<EOF
[Unit]
Description=Companion LLM proxy (Anthropic Messages API in front of vLLM)
Documentation=https://github.com/croll83/companion/blob/main/docs/local-llm.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
ExecStart=$RUNTIME /opt/$NAME/llm-proxy.mjs --config /etc/$NAME/config.json
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only

[Install]
WantedBy=multi-user.target
EOF

systemctl_ daemon-reload
systemctl_ enable "$NAME" >/dev/null
systemctl_ restart "$NAME"

echo "Installed $NAME ($RUNTIME), config $CONF"
if [ "$CREATED" -eq 1 ]; then
  echo "Proxy token (put it in Companion → Settings → Providers → Local LLM): $TOKEN"
else
  echo "Config kept as it was (edit it, then: systemctl restart $NAME)"
fi
echo "Check: curl -s http://<this-host>:${LISTEN##*:}/health ; logs: journalctl -u $NAME -f"
