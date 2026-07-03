# SnapBot VPS Runbook — Ubuntu 24.04

One-time server setup, the cutover from the Windows PC, and the ongoing-ops
procedures (cookie refresh, updates, backups). Assumes a 2 GB RAM / 1-2 vCPU
box (Hetzner CX22 or DigitalOcean $6 droplet — GitHub Student Developer Pack
includes DO credit).

Placeholders: `VPS_IP` = your server's IP. Everything server-side runs as user
`bot` unless noted.

## 1. Provision

- Create the server: Ubuntu 24.04 LTS, 2 GB RAM. **Add your SSH public key at
  creation time** (both providers offer this) so password login is never needed.
- Note the IP → `VPS_IP`.

## 2. Harden (as root, first login)

```bash
apt update && apt upgrade -y
adduser bot                       # pick a strong password, rest can be blank
usermod -aG sudo bot
rsync --archive --chown=bot:bot ~/.ssh /home/bot
ufw allow OpenSSH
ufw enable
```

Then edit `/etc/ssh/sshd_config`: set `PasswordAuthentication no` and
`PermitRootLogin no`, then `systemctl restart ssh`. Reconnect as
`ssh bot@VPS_IP` before closing the root session.

## 3. Swap (mandatory on 2 GB — Chrome plus a second short-lived Chromium for
trade-card renders will OOM without it)

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 4. Node 22 LTS (NodeSource → /usr/bin/node, which the systemd unit expects)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # v22.x
```

## 5. Clone the repo (read-only deploy key)

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
cat ~/.ssh/id_ed25519.pub
```

Add that public key on GitHub → repo **rowpots/CapitolHillBot** → Settings →
Deploy keys → "Add deploy key" (read-only is fine). Then:

```bash
git clone git@github.com:rowpots/CapitolHillBot.git ~/CapitolHillBot
cd ~/CapitolHillBot
npm ci          # also downloads Puppeteer's Chrome to ~/.cache/puppeteer
```

> Do **not** run `npx puppeteer browsers install chrome --install-deps` under
> sudo — it would install Chrome into root's cache where user `bot` can't find
> it. `npm ci` as `bot` already fetched the right Chrome; the system libraries
> it needs come from apt:

```bash
sudo apt-get install -y ca-certificates fonts-liberation fonts-noto-color-emoji \
  libasound2t64 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 libdrm2 \
  libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
  libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
  xdg-utils
```

## 6. Cutover from the Windows PC (order matters)

Same league + same chat → **carry all state over, never reset it**
(`.state/runtime-state.json` is the dedup ledger; without it the bot re-sends
old trades. The reset procedure in TRADEBOT_README is only for *switching*
chats).

1. **On the PC:** refresh cookies right before cutover so the VPS starts with
   young ones: `npm run login` (complete any CAPTCHA/2FA in the window).
2. **On the PC: stop the bot** — from this point only one machine may run it.
3. **On the PC**, from the `SnapBot/` directory (PowerShell):

   ```powershell
   scp -r .state bot@VPS_IP:/home/bot/CapitolHillBot/
   scp .env capitolhillbot-cookies.json bot@VPS_IP:/home/bot/CapitolHillBot/
   ```

   The `.env` can go up unchanged — `HEADLESS=false` in it is overridden by
   the systemd unit on the server. Add the two new optional vars while you're
   at it: `DISCORD_WEBHOOK_URL`, `HEALTHCHECK_PING_URL` (see §9).
4. **On the VPS — no-browser sanity check:**

   ```bash
   cd ~/CapitolHillBot
   DRY_RUN=true RUN_ONCE=true node index.js
   ```

   Must log **"Loaded N known transaction id(s)"**. If it says **"Seeded"**,
   the `.state` copy didn't land — **stop and fix before going further**, or
   old trades will re-send.
5. **On the VPS — browser smoke test:**

   ```bash
   HEADLESS=true RUN_ONCE=true node index.js
   ```

   Expect: "Cookies set" → "Snapchat session restored from an existing login"
   → chat list → one poll cycle → clean exit.

## 7. Install the service

```bash
sudo cp ~/CapitolHillBot/deploy/snapbot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now snapbot
journalctl -u snapbot -f     # watch 2-3 cycles: "Sleeping for 60 second(s)."
```

Logs live in journald (self-rotating; optionally cap with
`SystemMaxUse=500M` in `/etc/systemd/journald.conf`):

```bash
journalctl -u snapbot -f                  # tail
journalctl -u snapbot --since "1 hour ago"
```

## 8. Cookie refresh (you WILL need this eventually)

When the Snapchat session expires, the bot posts a Discord alert
("session expired — re-login needed"), parks itself, and retries hourly. It
never crash-loops. To fix, on the **PC** (from `SnapBot/`):

```powershell
npm run login        # visible browser; complete CAPTCHA/2FA if prompted
scp .\capitolhillbot-cookies.json bot@VPS_IP:~/CapitolHillBot/
ssh bot@VPS_IP "sudo systemctl restart snapbot"
```

Watch for the "SnapBot online." Discord alert to confirm recovery.

## 9. Monitoring + alerts

- **Discord:** create a private server → channel → Integrations → Webhooks →
  copy the URL into `.env` as `DISCORD_WEBHOOK_URL`. You get: startup notice,
  daily heartbeat, fatal-crash alerts, and session-expired alerts.
- **healthchecks.io (dead-man's-switch):** free account → new check → expected
  period 1 minute, grace 10 minutes → add its Discord integration → copy the
  ping URL into `.env` as `HEALTHCHECK_PING_URL`. The bot pings after every
  successful poll cycle, so you're alerted if the process dies **or** the loop
  wedges — even if Discord alerting itself is what broke.

## 10. Backups

```bash
crontab -e     # as bot, add:
# 10 9 * * * /home/bot/CapitolHillBot/deploy/backup.sh >> /home/bot/backups/backup.log 2>&1
```

Nightly tarball of `.state/` + `.env` + cookies into `~/backups` (09:10 UTC =
overnight ET), 14 kept. The tarballs contain secrets — the script chmods the
dir to 700. Occasionally pull one off-box from the PC:

```powershell
scp bot@VPS_IP:~/backups/snapbot-*.tar.gz .
```

## 11. Updating the bot

```bash
~/CapitolHillBot/deploy/deploy.sh    # git pull --ff-only, npm ci, restart
```

## Troubleshooting

- **Bot posts nothing, journal shows login-required pause** → cookie refresh, §8.
- **Chrome fails to launch / "libXXX not found"** → the apt list in §5 wasn't
  installed. (`launchSnapchat` logs the error but doesn't rethrow, so the
  symptom can surface later as a null-page error.)
- **OOM / bot killed** → confirm swap is active (`swapon --show`).
- **Snapchat keeps bouncing the session from the VPS** (datacenter-IP
  suspicion): refresh cookies (§8) once or twice; the mitigations already in
  place are the pinned Windows UA, `TZ=America/New_York`, and the stealth
  plugin. If it's persistent, the escalation path is a residential proxy —
  not currently built.
