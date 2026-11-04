#!/usr/bin/env bash
# Copies the JSON database to a dated file and keeps the last 14 days.
# The app writes db.json by replacing it in one step, so a copy never sees a half-written file.
set -euo pipefail

SRC="${JUMPSEAT_DB:-/opt/jumpseat/data/db.json}"
DEST="${JUMPSEAT_BACKUPS:-/var/backups/jumpseat}"

if [ ! -f "$SRC" ]; then
  echo "No database at $SRC yet; nothing to back up."
  exit 0
fi

mkdir -p "$DEST"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$SRC" "$DEST/db-$STAMP.json"
find "$DEST" -name 'db-*.json' -mtime +14 -delete
echo "Backed up to $DEST/db-$STAMP.json"
