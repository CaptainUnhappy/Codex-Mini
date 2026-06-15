#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

chmod +x "$SCRIPT_DIR/scripts/start-macos-relay.sh" 2>/dev/null || true

on_error() {
  local code="$1"
  echo ''
  echo "Codex Mini stopped with exit code $code."
  echo 'Press Return to close this window.'
  read -r _ || true
}
trap 'on_error $?' ERR

"$SCRIPT_DIR/scripts/start-macos-relay.sh"
