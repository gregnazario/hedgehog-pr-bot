#!/bin/sh
# Daily backup for hedgehog state (ignore memory, dashboard history).
# Install as /etc/cron.daily/hedgehog-backup or run from a systemd timer.
set -eu
STATE_DIR="${HEDGEHOG_STATE_DIR:-/var/lib/hedgehog}"
BACKUP_DIR="${HEDGEHOG_BACKUP_DIR:-/var/backups/hedgehog}"
KEEP=14

[ -d "$STATE_DIR" ] || exit 0
mkdir -p "$BACKUP_DIR"
tar -czf "$BACKUP_DIR/hedgehog-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" -C "$(dirname "$STATE_DIR")" "$(basename "$STATE_DIR")"
ls -1t "$BACKUP_DIR"/hedgehog-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
