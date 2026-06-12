#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${CODEX_MINI_RELAY_INSTALL_DIR:-/opt/codex-mini-relay}"
SERVICE_USER="${CODEX_MINI_RELAY_USER:-codex-mini-relay}"
SERVICE_NAME="${CODEX_MINI_RELAY_SERVICE:-codex-mini-relay}"
ENV_FILE="${CODEX_MINI_RELAY_ENV_FILE:-/etc/codex-mini-relay.env}"
PORT_VALUE="${CODEX_MINI_RELAY_PORT:-8788}"
ADMIN_PASSWORD_VALUE="${CODEX_MINI_RELAY_ADMIN_PASSWORD:-${ADMIN_PASSWORD:-}}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$(id -u)" != "0" ]]; then
  echo "Run as root: sudo bash relay-server/install-systemd.sh" >&2
  exit 1
fi

node -e "const major=Number(process.versions.node.split('.')[0]); if (major < 20) { console.error('Node.js >= 20 required, found ' + process.version); process.exit(1); }"

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

if [[ ! -f "$APP_DIR/relay-server/devices.json" ]]; then
  printf '{\n  "devices": []\n}\n' > "$APP_DIR/relay-server/devices.json"
fi

PRINT_ADMIN_PASSWORD=""
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -z "$ADMIN_PASSWORD_VALUE" ]]; then
    ADMIN_PASSWORD_VALUE="$(node -e "console.log(require('crypto').randomBytes(12).toString('base64url'))")"
    PRINT_ADMIN_PASSWORD="$ADMIN_PASSWORD_VALUE"
  fi
  if [[ "${#ADMIN_PASSWORD_VALUE}" -lt 8 ]]; then
    echo "ADMIN_PASSWORD must be at least 8 characters." >&2
    exit 1
  fi
  ADMIN_SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
  cat > "$ENV_FILE" <<EOF
PORT=$PORT_VALUE
ADMIN_PASSWORD=$ADMIN_PASSWORD_VALUE
ADMIN_SESSION_SECRET=$ADMIN_SESSION_SECRET
CODEX_MINI_RELAY_DEVICES=$APP_DIR/relay-server/devices.json
EOF
  chmod 600 "$ENV_FILE"
else
  if ! grep -Eq '^(ADMIN_PASSWORD|CODEX_MINI_RELAY_ADMIN_PASSWORD|ADMIN_PASSWORD_HASH|CODEX_MINI_RELAY_ADMIN_PASSWORD_HASH)=' "$ENV_FILE"; then
    if [[ -z "$ADMIN_PASSWORD_VALUE" ]]; then
      ADMIN_PASSWORD_VALUE="$(node -e "console.log(require('crypto').randomBytes(12).toString('base64url'))")"
      PRINT_ADMIN_PASSWORD="$ADMIN_PASSWORD_VALUE"
    fi
    if [[ "${#ADMIN_PASSWORD_VALUE}" -lt 8 ]]; then
      echo "ADMIN_PASSWORD must be at least 8 characters." >&2
      exit 1
    fi
    printf '\nADMIN_PASSWORD=%s\n' "$ADMIN_PASSWORD_VALUE" >> "$ENV_FILE"
  fi
  if ! grep -Eq '^(ADMIN_SESSION_SECRET|CODEX_MINI_RELAY_ADMIN_SESSION_SECRET)=' "$ENV_FILE"; then
    ADMIN_SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
    printf 'ADMIN_SESSION_SECRET=%s\n' "$ADMIN_SESSION_SECRET" >> "$ENV_FILE"
  fi
fi

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

echo "Installed $SERVICE_NAME."
echo "Status: sudo systemctl status $SERVICE_NAME"
echo "Logs:   sudo journalctl -u $SERVICE_NAME -f"
echo "Admin:  http://127.0.0.1:$PORT_VALUE/admin/"
if [[ -n "$PRINT_ADMIN_PASSWORD" ]]; then
  echo "Admin password: $PRINT_ADMIN_PASSWORD"
fi
echo "Open TCP port $PORT_VALUE in your cloud security group and firewall."
