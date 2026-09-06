#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NUM="${GPTWRAP_DISPLAY_NUM:-99}"
VNC_PORT="${GPTWRAP_VNC_PORT:-5900}"
NOVNC_PORT="${GPTWRAP_NOVNC_PORT:-6080}"
SCREEN="${GPTWRAP_SCREEN:-1365x900x24}"
export DISPLAY=":${DISPLAY_NUM}"

for cmd in Xvfb x11vnc fluxbox websockify; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing $cmd. Run: bash scripts/vps-setup.sh" >&2; exit 1; }
done

if [ -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; then
  echo "Display ${DISPLAY} already exists. Stop the old display service/process first." >&2
  exit 1
fi

NOVNC_WEB=""
for p in /usr/share/novnc /usr/share/novnc/; do
  if [ -d "$p" ]; then NOVNC_WEB="$p"; break; fi
done
if [ -z "$NOVNC_WEB" ]; then
  echo "Could not find noVNC web files under /usr/share/novnc." >&2
  exit 1
fi

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

Xvfb "$DISPLAY" -screen 0 "$SCREEN" -nolisten tcp -ac &
PIDS+=("$!")
sleep 0.7

fluxbox >/tmp/gptwrap-fluxbox.log 2>&1 &
PIDS+=("$!")

# VNC/noVNC are localhost-only. Reach them through an SSH tunnel.
x11vnc -display "$DISPLAY" -localhost -forever -shared -nopw -rfbport "$VNC_PORT" >/tmp/gptwrap-x11vnc.log 2>&1 &
PIDS+=("$!")

websockify --web="$NOVNC_WEB" "127.0.0.1:${NOVNC_PORT}" "127.0.0.1:${VNC_PORT}" >/tmp/gptwrap-novnc.log 2>&1 &
PIDS+=("$!")

echo "gptwrap virtual desktop running on ${DISPLAY}"
echo "noVNC is bound to 127.0.0.1:${NOVNC_PORT} only."
echo "Tunnel it from your PC with: ssh -L ${NOVNC_PORT}:127.0.0.1:${NOVNC_PORT} <user>@<vps>"

wait -n "${PIDS[@]}"
