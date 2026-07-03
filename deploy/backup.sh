#!/usr/bin/env bash
# Nightly state backup. The tarball contains .env (secrets) — keep ~/backups
# private (chmod 700). Keeps the newest 14; older ones are pruned.
# Crontab (user bot):  10 9 * * * /home/bot/CapitolHillBot/deploy/backup.sh >> /home/bot/backups/backup.log 2>&1
set -euo pipefail

APP_DIR="$HOME/CapitolHillBot"
BACKUP_DIR="$HOME/backups"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

cd "$APP_DIR"
tar -czf "$BACKUP_DIR/snapbot-$(date +%F).tar.gz" .state .env ./*-cookies.json

# Keep the 14 newest backups.
ls -1t "$BACKUP_DIR"/snapbot-*.tar.gz | tail -n +15 | xargs -r rm --
