#!/usr/bin/env bash
# Pulls the latest code, installs dependencies and restarts the app.
#   sudo bash /opt/jumpseat/deploy/update.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root: sudo bash $0" >&2
  exit 1
fi

cd /opt/jumpseat
sudo -u jumpseat git pull --ff-only
sudo -u jumpseat npm ci --omit=dev
systemctl restart jumpseat
sleep 2
curl -fsS http://127.0.0.1:3000/api/meta >/dev/null && echo "Updated and running."
