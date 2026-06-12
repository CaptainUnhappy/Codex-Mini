#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${CODEX_MINI_RELAY_INSTALL_DIR:-/opt/codex-mini-relay}"
SERVICE_USER="${CODEX_MINI_RELAY_USER:-codex-mini-relay}"
SERVICE_NAME="${CODEX_MINI_RELAY_SERVICE:-codex-mini-relay}"
ENV_FILE="${CODEX_MINI_RELAY_ENV_FILE:-/etc/codex-mini-relay.env}"
PORT_VALUE="${CODEX_MINI_RELAY_PORT:-8788}"
DEVICE_ID=""
DEVICE_NAME=""
PASSPHRASE=""
SERVER_IP="${SERVER_IP:-}"
INSTALL_NODE="1"
ADMIN_PASSWORD_VALUE="${ADMIN_PASSWORD:-}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<EOF
Usage:
  sudo bash relay-server/install-full.sh [options]

Options:
  --server-ip <ip>       public server IP, auto-detected if omitted
  --port <port>          relay port, default: 8788
  --device-id <id>       device id, default: current hostname
  --device-name <name>   display name, default: device id
  --passphrase <value>   phone login key, generated if omitted
  --admin-password <pw>   admin page password, generated if omitted
  --install-dir <path>   install path, default: /opt/codex-mini-relay
  --service-name <name>  systemd service name, default: codex-mini-relay
  --no-install-node      do not install Node.js automatically
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-ip) SERVER_IP="${2:-}"; shift 2 ;;
    --port) PORT_VALUE="${2:-8788}"; shift 2 ;;
    --device-id) DEVICE_ID="${2:-}"; shift 2 ;;
    --device-name) DEVICE_NAME="${2:-}"; shift 2 ;;
    --passphrase) PASSPHRASE="${2:-}"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD_VALUE="${2:-}"; shift 2 ;;
    --install-dir) APP_DIR="${2:-/opt/codex-mini-relay}"; shift 2 ;;
    --service-name) SERVICE_NAME="${2:-codex-mini-relay}"; shift 2 ;;
    --no-install-node) INSTALL_NODE="0"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ "$(id -u)" != "0" ]]; then
  echo "Run as root: sudo bash relay-server/install-full.sh" >&2
  exit 1
fi

node_major() {
  if ! command -v node >/dev/null 2>&1; then
    echo 0
    return
  fi
  node -e "console.log(Number(process.versions.node.split('.')[0]) || 0)"
}

install_node_20() {
  if [[ "$INSTALL_NODE" != "1" ]]; then
    echo "Node.js >= 20 required. Current major: $(node_major)." >&2
    exit 1
  fi
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Automatic Node.js install only supports Ubuntu/Debian with apt-get." >&2
    exit 1
  fi
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  mkdir -p /etc/apt/keyrings
  rm -f /etc/apt/keyrings/nodesource.gpg
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  chmod 644 /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
}

if [[ "$(node_major)" -lt 20 ]]; then
  install_node_20
fi

node -e "const major=Number(process.versions.node.split('.')[0]); if (major < 20) { console.error('Node.js >= 20 required, found ' + process.version); process.exit(1); }"

if [[ -z "$SERVER_IP" ]]; then
  SERVER_IP="$(curl -fsS --max-time 4 https://api.ipify.org 2>/dev/null || true)"
fi
if [[ -z "$SERVER_IP" ]]; then
  SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
fi
if [[ -z "$SERVER_IP" ]]; then
  echo "Could not detect server IP. Pass --server-ip <ip>." >&2
  exit 1
fi

if [[ -z "$DEVICE_ID" ]]; then
  DEVICE_ID="$(hostname | tr -cs 'A-Za-z0-9._-' '-' | sed 's/^-//;s/-$//')"
fi
if [[ -z "$DEVICE_NAME" ]]; then
  DEVICE_NAME="$DEVICE_ID"
fi
if [[ -z "$PASSPHRASE" ]]; then
  PASSPHRASE="$(node -e "console.log(require('crypto').randomBytes(12).toString('base64url'))")"
fi
if [[ -z "$ADMIN_PASSWORD_VALUE" ]]; then
  ADMIN_PASSWORD_VALUE="$(node -e "console.log(require('crypto').randomBytes(12).toString('base64url'))")"
fi
if [[ "${#PASSPHRASE}" -lt 8 ]]; then
  echo "--passphrase must be at least 8 characters." >&2
  exit 1
fi
if [[ "${#ADMIN_PASSWORD_VALUE}" -lt 8 ]]; then
  echo "--admin-password must be at least 8 characters." >&2
  exit 1
fi

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

mkdir -p "$APP_DIR"
rm -rf "$APP_DIR/relay-server"
cp -R "$ROOT_DIR/relay-server" "$APP_DIR/relay-server"
cp "$ROOT_DIR/package.json" "$APP_DIR/package.json"
if [[ -f "$ROOT_DIR/package-lock.json" ]]; then
  cp "$ROOT_DIR/package-lock.json" "$APP_DIR/package-lock.json"
fi

cd "$APP_DIR"
npm install --omit=dev

ADMIN_SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"

cat > "$ENV_FILE" <<EOF
PORT=$PORT_VALUE
ADMIN_PASSWORD=$ADMIN_PASSWORD_VALUE
ADMIN_SESSION_SECRET=$ADMIN_SESSION_SECRET
CODEX_MINI_RELAY_DEVICES=$APP_DIR/relay-server/devices.json
EOF
chmod 600 "$ENV_FILE"

node relay-server/create-device.js \
  --devices "$APP_DIR/relay-server/devices.json" \
  --id "$DEVICE_ID" \
  --name "$DEVICE_NAME" \
  --passphrase "$PASSPHRASE" \
  --server-ip "$SERVER_IP" \
  --port "$PORT_VALUE" \
  --env-dir "$APP_DIR"

cat > "/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=Codex Mini Relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) relay-server/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

if command -v ufw >/dev/null 2>&1 && ufw status | grep -qi active; then
  ufw allow "$PORT_VALUE/tcp" || true
fi

cat <<EOF

Codex Mini Relay installed.

Phone:
  http://$SERVER_IP:$PORT_VALUE/

QR/login URL:
  http://$SERVER_IP:$PORT_VALUE/#k=$PASSPHRASE

Admin status:
  http://$SERVER_IP:$PORT_VALUE/admin/

Admin password:
  $ADMIN_PASSWORD_VALUE

Desktop env files:
  $APP_DIR/desktop-env.ps1
  $APP_DIR/desktop-env.sh

Show PowerShell env file:
  sudo cat $APP_DIR/desktop-env.ps1

Service:
  sudo systemctl status $SERVICE_NAME
  sudo journalctl -u $SERVICE_NAME -f

Open TCP $PORT_VALUE in your cloud provider security group if it is not already open.
EOF
