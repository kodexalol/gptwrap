#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
RUN_USER="${GPTWRAP_USER:-${SUDO_USER:-${USER:-$(id -un)}}}"
NODE_BIN="$(command -v node)"

if [ ! -f "$ROOT/.env" ]; then
  echo "Missing $ROOT/.env. Run bash scripts/vps-setup.sh first." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is not available on this machine." >&2
  exit 1
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

TMP_DISPLAY="$(mktemp)"
TMP_APP="$(mktemp)"
trap 'rm -f "$TMP_DISPLAY" "$TMP_APP"' EXIT

cat >"$TMP_DISPLAY" <<EOF
[Unit]
Description=gptwrap virtual desktop
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$ROOT
ExecStart=/bin/bash $ROOT/scripts/vps-display.sh
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

cat >"$TMP_APP" <<EOF
[Unit]
Description=gptwrap API
After=network-online.target gptwrap-display.service
Wants=network-online.target
Requires=gptwrap-display.service

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$ROOT
Environment=DISPLAY=:99
EnvironmentFile=-$ROOT/.env
ExecStart=$NODE_BIN $ROOT/index.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF

$SUDO cp "$TMP_DISPLAY" /etc/systemd/system/gptwrap-display.service
$SUDO cp "$TMP_APP" /etc/systemd/system/gptwrap.service
$SUDO systemctl daemon-reload
$SUDO systemctl enable gptwrap-display.service gptwrap.service

cat <<EOF
Installed and enabled:
  gptwrap-display.service
  gptwrap.service

If scripts/vps-display.sh is currently running manually, stop it first (Ctrl+C), then run:
  sudo systemctl start gptwrap-display.service
  sudo systemctl start gptwrap.service

Useful commands:
  sudo systemctl status gptwrap.service
  sudo journalctl -u gptwrap.service -f
  sudo systemctl restart gptwrap.service

The services run as: $RUN_USER
Repo directory: $ROOT
EOF
