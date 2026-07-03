// Operational alerts for unattended (VPS) runs. Fire-and-forget by design:
// nothing in here may ever throw or block the poll loop. Both channels no-op
// when their env var is unset, so local dev runs are unaffected.
//
// - sendAlert(key, message, { cooldownMs }): Discord webhook POST. Per-key
//   cooldowns persist in .state/last-alert.json so a supervisor restart loop
//   can't spam the channel (the fatal-crash path relies on this).
// - pingHealthcheck(): GET a healthchecks.io ping URL once per successful
//   poll cycle — the dead-man's-switch that catches process death AND a
//   wedged loop.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOLDOWN_FILE = path.join(__dirname, ".state", "last-alert.json");

function readCooldowns() {
  try {
    return JSON.parse(fs.readFileSync(COOLDOWN_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export async function sendAlert(key, message, { cooldownMs = 15 * 60 * 1000 } = {}) {
  try {
    const url = process.env.DISCORD_WEBHOOK_URL?.trim();
    if (!url) {
      return false;
    }

    const cooldowns = readCooldowns();
    const last = Date.parse(cooldowns[key] ?? "") || 0;
    if (Date.now() - last < cooldownMs) {
      return false;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: String(message).slice(0, 1900) }),
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      cooldowns[key] = new Date().toISOString();
      fs.mkdirSync(path.dirname(COOLDOWN_FILE), { recursive: true });
      fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(cooldowns, null, 2));
    }

    return response.ok;
  } catch {
    return false;
  }
}

export function pingHealthcheck() {
  const url = process.env.HEALTHCHECK_PING_URL?.trim();
  if (!url) {
    return;
  }

  fetch(url, { signal: AbortSignal.timeout(10000) }).catch(() => {});
}
