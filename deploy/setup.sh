#!/usr/bin/env bash
# Sets up Jumpseat on a fresh Ubuntu 22.04 or 24.04 VM (x86_64 or arm64).
#
#   sudo bash setup.sh <git-repo-url> <domain>
#   e.g. sudo bash setup.sh https://github.com/kodexalol/gptwrap.git jumpseat.duckdns.org
#
# Safe to run again: it updates packages, keeps the existing /etc/jumpseat.env and data.
set -euo pipefail

REPO_URL="${1:?usage: setup.sh <repo-url> <domain>}"
DOMAIN="${2:?usage: setup.sh <repo-url> <domain>}"
APP_DIR=/opt/jumpseat
ENV_FILE=/etc/jumpseat.env

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root: sudo bash $0 $REPO_URL $DOMAIN" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl ca-certificates gpg debian-keyring debian-archive-keyring \
  apt-transport-https iptables-persistent netfilter-persistent

# ---------- Node.js 22 (official build, checksum verified) ----------
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" != "22" ]; then
  case "$(uname -m)" in
    x86_64) ARCH=x64 ;;
    aarch64) ARCH=arm64 ;;
    *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
  esac
  TMP="$(mktemp -d)"
  BASE=https://nodejs.org/dist/latest-v22.x
  curl -fsSL -o "$TMP/SHASUMS256.txt" "$BASE/SHASUMS256.txt"
  FILE="$(grep -o "node-v[0-9.]*-linux-$ARCH.tar.xz" "$TMP/SHASUMS256.txt" | head -1)"
  curl -fsSL -o "$TMP/$FILE" "$BASE/$FILE"
  (cd "$TMP" && grep " $FILE\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf "$TMP/$FILE" -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  ln -sf /opt/node/bin/npm /usr/local/bin/npm
  ln -sf /opt/node/bin/npx /usr/local/bin/npx
  rm -rf "$TMP"
fi
echo "Node $(node --version)"

# ---------- Caddy (automatic HTTPS) ----------
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# ---------- App user, code and data ----------
if ! id -u jumpseat >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin jumpseat
fi
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO_URL" "$APP_DIR"
else
  git -C "$APP_DIR" pull --ff-only
fi
install -d -o jumpseat -g jumpseat "$APP_DIR/data"
chmod +x "$APP_DIR"/deploy/*.sh
sudo -u jumpseat bash -c "cd '$APP_DIR' && npm ci --omit=dev"
chown -R jumpseat:jumpseat "$APP_DIR/data"

# ---------- Settings (secrets stay in one root-only file) ----------
if [ ! -f "$ENV_FILE" ]; then
  install -m 600 -o root -g root "$APP_DIR/deploy/jumpseat.env.example" "$ENV_FILE"
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=https://$DOMAIN|" "$ENV_FILE"
  echo "Created $ENV_FILE. Fill in the Discord, Roblox and ADMIN_USERNAMES values before users sign in."
else
  echo "Keeping existing $ENV_FILE. Check that PUBLIC_URL=https://$DOMAIN is in it."
fi

# ---------- systemd service ----------
install -m 644 "$APP_DIR/deploy/jumpseat.service" /etc/systemd/system/jumpseat.service
systemctl daemon-reload
systemctl enable jumpseat
systemctl restart jumpseat

# ---------- Caddy site for the domain ----------
sed "s|__DOMAIN__|$DOMAIN|g" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl enable caddy
systemctl restart caddy

# ---------- Host firewall: allow web traffic (Oracle and some images block it by default) ----------
open_port() {
  iptables -C INPUT -p tcp --dport "$1" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport "$1" -j ACCEPT
}
open_port 80
open_port 443
netfilter-persistent save >/dev/null

# ---------- Daily backup ----------
cat > /etc/cron.d/jumpseat-backup <<EOF
# Copies data/db.json to /var/backups/jumpseat every night at 03:15 UTC.
15 3 * * * root $APP_DIR/deploy/backup.sh
EOF
chmod 644 /etc/cron.d/jumpseat-backup

sleep 2
if curl -fsS http://127.0.0.1:3000/api/meta >/dev/null; then
  echo "Jumpseat is running on this machine."
else
  echo "Jumpseat did not answer on port 3000. Check: journalctl -u jumpseat -n 50" >&2
fi

cat <<EOF

Next steps:
  1. Point $DOMAIN at this machine's public IP (an A record, or DuckDNS). Caddy gets the certificate once DNS resolves.
  2. Edit $ENV_FILE: DISCORD_CLIENT_ID/SECRET, ROBLOX_CLIENT_ID/SECRET, ADMIN_USERNAMES.
  3. sudo systemctl restart jumpseat
  4. Open https://$DOMAIN
EOF
