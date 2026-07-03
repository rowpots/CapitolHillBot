#!/usr/bin/env bash
# Update the bot on the VPS: pull, reinstall deps, restart. Run as user `bot`
# from anywhere: ~/CapitolHillBot/deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

git pull --ff-only
npm ci
sudo systemctl restart snapbot
sudo systemctl --no-pager status snapbot
