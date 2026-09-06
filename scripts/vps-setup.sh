#!/usr/bin/env bash
set -euo pipefail

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This helper currently supports Debian/Ubuntu-style VPSes (apt-get)." >&2
  exit 1
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || { echo "sudo is required when not running as root." >&2; exit 1; }
  SUDO="sudo"
fi

$SUDO apt-get update
$SUDO apt-get install -y ca-certificates curl git openssl xvfb x11vnc fluxbox novnc websockify

if ! command -v node >/dev/null 2>&1; then
  $SUDO apt-get install -y nodejs npm
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "System Node.js is too old (${NODE_MAJOR}). Installing Node.js 20 from NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/gptwrap-nodesource.sh
  $SUDO bash /tmp/gptwrap-nodesource.sh
  $SUDO apt-get install -y nodejs
fi

node --version
npm --version

npm install
npx playwright install --with-deps chromium

if [ ! -f .env ]; then
  cp .env.example .env
  API_KEY_VALUE="$(openssl rand -hex 32)"
  sed -i "s/^API_KEY=.*/API_KEY=${API_KEY_VALUE}/" .env
  sed -i 's/^USE_REAL_CHROME=.*/USE_REAL_CHROME=0/' .env
  sed -i 's/^HEADLESS=.*/HEADLESS=0/' .env
  sed -i 's/^DISPLAY=.*/DISPLAY=:99/' .env
  echo "Created .env with a random API key."
else
  echo ".env already exists; leaving it unchanged."
fi

cat <<'EOF'

gptwrap VPS dependencies are installed.

Next:
  1) Start the private virtual desktop:
       bash scripts/vps-display.sh

  2) On YOUR PC, open a second terminal and tunnel noVNC:
       ssh -L 6080:127.0.0.1:6080 <user>@<vps>

  3) Open in your PC browser:
       http://127.0.0.1:6080/vnc.html?autoconnect=1

  4) Back on the VPS, in another SSH session:
       export DISPLAY=:99
       node index.js login chatgpt
       node index.js login gemini
       node index.js login claude
       node index.js login grok
       node index.js login deepseek

     Only log into providers you actually plan to use.

  5) Test:
       npm run check
       npm start

  6) After logins work, install the optional systemd services:
       bash scripts/install-systemd.sh

The API defaults to 127.0.0.1:3000. Keep it there if your app is on the same VPS or use an SSH/reverse-proxy tunnel.
If you set HOST=0.0.0.0, gptwrap requires API_KEY unless you explicitly set ALLOW_UNAUTHENTICATED=1.
EOF

if [ -f .env ]; then
  echo
  echo "API key: $(grep '^API_KEY=' .env | cut -d= -f2-)"
fi
