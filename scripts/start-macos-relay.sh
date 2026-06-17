#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

LOG_DIR="$PROJECT_DIR/logs/$(date +%F)"
mkdir -p "$LOG_DIR"
LOG_PATH="$LOG_DIR/desktop-macos-$(date +%Y%m%d-%H%M%S).log"
if [[ "${CODEX_MINI_DISABLE_LOG_TEE:-0}" != '1' ]]; then
  exec > >(tee -a "$LOG_PATH") 2>&1
fi
echo "Log file: $LOG_PATH"

DEFAULT_PUBLIC_BASE='https://114.55.235.80/codex'
REGISTRATION_KEY_PLACEHOLDER='__CODEX_MINI_RELAY_REGISTRATION_KEY__'
DEFAULT_REGISTRATION_KEY='__CODEX_MINI_RELAY_REGISTRATION_KEY__'

PUBLIC_BASE="${CODEX_MINI_RELAY_PUBLIC_BASE:-$DEFAULT_PUBLIC_BASE}"
PUBLIC_BASE="${PUBLIC_BASE%/}"
REGISTRATION_KEY="${CODEX_MINI_RELAY_REGISTRATION_KEY:-$DEFAULT_REGISTRATION_KEY}"
if [[ "$REGISTRATION_KEY" == "$REGISTRATION_KEY_PLACEHOLDER" ]]; then
  echo 'CODEX_MINI_RELAY_REGISTRATION_KEY is not configured. Use the packaged zip or set the environment variable.' >&2
  exit 1
fi

if [[ -n "${CODEX_MINI_RELAY_URL:-}" ]]; then
  RELAY_URL="$CODEX_MINI_RELAY_URL"
else
  case "$PUBLIC_BASE" in
    https:*) RELAY_URL="wss:${PUBLIC_BASE#https:}/tunnel" ;;
    http:*) RELAY_URL="ws:${PUBLIC_BASE#http:}/tunnel" ;;
    *) echo "Unsupported relay URL: $PUBLIC_BASE" >&2; exit 1 ;;
  esac
fi

STATE_ROOT="${CODEX_MINI_STATE_DIR:-$HOME/Library/Application Support/CodexMini}"
DEVICE_CONFIG_PATH="$STATE_ROOT/relay-device.json"
RUNTIME_ROOT="$PROJECT_DIR/.runtime"
NODE_ROOT="$RUNTIME_ROOT/node"
NODE_EXE=''
NPM_CMD=''

set_node_commands() {
  NODE_EXE="$1"
  NPM_CMD="$2"
  local node_dir
  node_dir="$(dirname "$NODE_EXE")"
  case ":$PATH:" in
    *":$node_dir:"*) ;;
    *) export PATH="$node_dir:$PATH" ;;
  esac
}

portable_node_arch() {
  case "$(uname -m)" in
    arm64) echo 'darwin-arm64' ;;
    x86_64) echo 'darwin-x64' ;;
    *) echo "Unsupported Mac CPU architecture: $(uname -m)" >&2; return 1 ;;
  esac
}

install_portable_node() {
  mkdir -p "$RUNTIME_ROOT"
  local arch base_url sums_url sums tar_name expected_hash archive_path expanded_name expanded_path actual_hash
  arch="$(portable_node_arch)"
  base_url="${CODEX_MINI_NODE_BASE_URL:-https://nodejs.org/dist/latest-v24.x}"
  sums_url="$base_url/SHASUMS256.txt"

  echo ''
  echo 'Node.js was not found. Downloading portable Node.js into this folder...'
  echo "Architecture: $arch"

  sums="$(curl -fsSL "$sums_url")"
  expected_hash="$(printf '%s\n' "$sums" | awk -v arch="$arch" '$2 ~ ("^node-v[0-9]+\\.[0-9]+\\.[0-9]+-" arch "\\.tar\\.gz$") { print $1; exit }')"
  tar_name="$(printf '%s\n' "$sums" | awk -v arch="$arch" '$2 ~ ("^node-v[0-9]+\\.[0-9]+\\.[0-9]+-" arch "\\.tar\\.gz$") { print $2; exit }')"
  if [[ -z "$tar_name" || -z "$expected_hash" ]]; then
    echo "Could not find a Node.js macOS archive for $arch." >&2
    exit 1
  fi

  archive_path="$RUNTIME_ROOT/$tar_name"
  expanded_name="${tar_name%.tar.gz}"
  expanded_path="$RUNTIME_ROOT/$expanded_name"

  echo "Downloading $tar_name..."
  curl -fL "$base_url/$tar_name" -o "$archive_path"
  actual_hash="$(shasum -a 256 "$archive_path" | awk '{ print $1 }')"
  if [[ "$actual_hash" != "$expected_hash" ]]; then
    rm -f "$archive_path"
    echo 'Downloaded Node.js archive failed SHA256 verification.' >&2
    exit 1
  fi

  rm -rf "$expanded_path" "$NODE_ROOT"
  tar -xzf "$archive_path" -C "$RUNTIME_ROOT"
  mv "$expanded_path" "$NODE_ROOT"

  if [[ ! -x "$NODE_ROOT/bin/node" || ! -x "$NODE_ROOT/bin/npm" ]]; then
    echo 'Portable Node.js download did not contain node and npm.' >&2
    exit 1
  fi
  set_node_commands "$NODE_ROOT/bin/node" "$NODE_ROOT/bin/npm"
}

ensure_node_runtime() {
  if [[ -x "$NODE_ROOT/bin/node" && -x "$NODE_ROOT/bin/npm" ]]; then
    set_node_commands "$NODE_ROOT/bin/node" "$NODE_ROOT/bin/npm"
    return
  fi

  local system_node system_npm node_major
  system_node="$(command -v node || true)"
  system_npm="$(command -v npm || true)"
  if [[ -n "$system_node" && -n "$system_npm" ]]; then
    node_major="$("$system_node" -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
    if [[ "$node_major" -ge 18 ]]; then
      set_node_commands "$system_node" "$system_npm"
      return
    fi
  fi

  install_portable_node
}

ensure_node_dependencies() {
  local missing=0 module
  for module in node_modules/ws node_modules/qrcode node_modules/qrcode-terminal; do
    if [[ ! -d "$PROJECT_DIR/$module" ]]; then
      missing=1
    fi
  done
  if [[ "$missing" -eq 0 ]]; then
    return
  fi

  echo ''
  echo 'Installing Node dependencies...'
  "$NPM_CMD" install
}

machine_seed() {
  local computer_name host_name user_name platform_uuid
  computer_name="$(scutil --get ComputerName 2>/dev/null || true)"
  host_name="$(hostname 2>/dev/null || true)"
  user_name="$(id -un 2>/dev/null || true)"
  platform_uuid="$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F '"' '/IOPlatformUUID/ { print $(NF - 1); exit }' || true)"
  printf '%s|%s|%s|%s' "$computer_name" "$host_name" "$user_name" "$platform_uuid"
}

create_device_config_json() {
  local seed
  seed="$(machine_seed)"
  "$NODE_EXE" - "$PUBLIC_BASE" "$RELAY_URL" "$seed" <<'NODE'
const crypto = require('crypto');
const os = require('os');

const [publicBase, relayUrl, seed] = process.argv.slice(2);
const token = bytes => crypto.randomBytes(bytes).toString('base64url');
const installId = token(16);
const host = (os.hostname() || 'mac')
  .replace(/[^a-zA-Z0-9._-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 40) || 'mac';
const fingerprint = crypto
  .createHash('sha256')
  .update(`${seed}|${installId}`)
  .digest('hex')
  .slice(0, 12);

process.stdout.write(JSON.stringify({
  publicBase,
  relayUrl,
  deviceId: `codex-${host}-${fingerprint}`.toLowerCase(),
  name: `Codex ${host}`,
  relaySecret: token(32),
  passphrase: token(18),
  fingerprint,
  installId,
  createdAt: new Date().toISOString()
}, null, 2) + '\n');
NODE
}

register_device() {
  local config_json body register_url
  config_json="$1"

  echo ''
  echo 'First start on this Mac. A new relay device approval request will be sent.'
  printf 'Relay: %s\n' "$PUBLIC_BASE"
  printf 'Device: %s\n' "$(printf '%s' "$config_json" | "$NODE_EXE" -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(d.deviceId);")"
  echo ''

  body="$(printf '%s' "$config_json" | CODEX_MINI_RELAY_REGISTRATION_KEY_VALUE="$REGISTRATION_KEY" "$NODE_EXE" -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(JSON.stringify({ registrationKey: process.env.CODEX_MINI_RELAY_REGISTRATION_KEY_VALUE, deviceId: d.deviceId, name: d.name, relaySecret: d.relaySecret, passphrase: d.passphrase, fingerprint: d.fingerprint }));")"
  register_url="$PUBLIC_BASE/device/register"
  printf '%s' "$body" | curl -fsS -X POST "$register_url" -H 'content-type: application/json' --data-binary @- >/dev/null
  echo 'Device request submitted. Waiting for relay authorization.'
}

load_or_create_device_config() {
  if [[ -f "$DEVICE_CONFIG_PATH" ]]; then
    return
  fi

  mkdir -p "$STATE_ROOT"
  local config_json final_json
  config_json="$(create_device_config_json)"
  register_device "$config_json"
  final_json="$(printf '%s' "$config_json" | "$NODE_EXE" -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); d.registeredAt = new Date().toISOString(); d.approvedAtFirstStart = false; process.stdout.write(JSON.stringify(d, null, 2) + '\n');")"
  printf '%s' "$final_json" > "$DEVICE_CONFIG_PATH"
}

json_value() {
  "$NODE_EXE" -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const v=d[process.argv[2]]; process.stdout.write(v == null ? '' : String(v));" "$DEVICE_CONFIG_PATH" "$1"
}

ensure_helper_permissions_hint() {
  if [[ -f "$PROJECT_DIR/bin/codex-window-point" ]]; then
    chmod +x "$PROJECT_DIR/bin/codex-window-point" 2>/dev/null || true
  fi
  if ! command -v cliclick >/dev/null 2>&1 && [[ ! -x /opt/homebrew/bin/cliclick && ! -x /usr/local/bin/cliclick ]]; then
    echo ''
    echo 'Optional: install cliclick for more reliable mouse clicks: brew install cliclick'
  fi
}

ensure_node_runtime
load_or_create_device_config
ensure_node_dependencies
ensure_helper_permissions_hint

DEVICE_PUBLIC_BASE="$(json_value publicBase)"
DEVICE_RELAY_URL="$(json_value relayUrl)"
DEVICE_ID="$(json_value deviceId)"
DEVICE_SECRET="$(json_value relaySecret)"
DEVICE_PASSPHRASE="$(json_value passphrase)"

export CODEX_MINI_RELAY_URL="$DEVICE_RELAY_URL"
export CODEX_MINI_RELAY_PUBLIC_BASE="$DEVICE_PUBLIC_BASE"
export CODEX_MINI_RELAY_DEVICE_ID="$DEVICE_ID"
export CODEX_MINI_RELAY_SECRET="$DEVICE_SECRET"
export CODEX_MINI_RELAY_PASSPHRASE="$DEVICE_PASSPHRASE"
export CODEX_MINI_QR_DIR="$PROJECT_DIR"

echo ''
echo 'Starting Codex Mini desktop relay...'
printf 'Device ID: %s\n' "$DEVICE_ID"
printf 'Device config: %s\n' "$DEVICE_CONFIG_PATH"
echo 'Phone URL:'
printf '  %s/#k=%s\n' "$DEVICE_PUBLIC_BASE" "$("$NODE_EXE" -e "process.stdout.write(encodeURIComponent(process.argv[1]));" "$DEVICE_PASSPHRASE")"
echo ''
echo 'Keep this Terminal window open while using the phone client.'
echo ''

"$NPM_CMD" start
