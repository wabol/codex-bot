#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SERVICE_TEMPLATE="$PROJECT_DIR/systemd/codex-bot.service.in"
SERVICE_DEST="$HOME/.config/systemd/user/codex-bot.service"
NODE_BIN="$(command -v node)"
CODEX_BIN="${CODEX_BIN:-$(command -v codex)}"
CODEX_BIN_DIR="$(dirname "$CODEX_BIN")"

if [[ ! -f "$SERVICE_TEMPLATE" ]]; then
  echo "Missing service template: $SERVICE_TEMPLATE" >&2
  exit 1
fi

mkdir -p "$HOME/.config/systemd/user"
sed \
  -e "s#__PROJECT_DIR__#$PROJECT_DIR#g" \
  -e "s#__NODE_BIN__#$NODE_BIN#g" \
  -e "s#__HOME_DIR__#$HOME#g" \
  -e "s#__CODEX_BIN__#$CODEX_BIN#g" \
  -e "s#__CODEX_BIN_DIR__#$CODEX_BIN_DIR#g" \
  "$SERVICE_TEMPLATE" > "$SERVICE_DEST"
systemctl --user daemon-reload
systemctl --user enable codex-bot.service

echo "Installed codex-bot user service. Start it with:"
echo "  systemctl --user start codex-bot.service"
