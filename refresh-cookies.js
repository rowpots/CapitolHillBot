// One-command cookie refresh — run this ON THE WINDOWS PC, never on the VPS.
//
// The chore this replaces was four hand-run steps (login, back up the remote
// file, scp, restart) whose last two were printed with a literal
// `YOUR_VPS_IP` placeholder, and which ended without ever confirming the new
// cookies actually took. It is also a chore you do rarely and under pressure —
// the bot is down, that's why you're here — which is the worst combination for
// remembered steps. So: one command, and it verifies.
//
//   npm run refresh-cookies              login, upload, restart, verify
//   npm run refresh-cookies -- --no-deploy    login only (old `npm run login`)
//   npm run refresh-cookies -- --host bot@1.2.3.4   override DEPLOY_HOST
//
// Requires DEPLOY_HOST in .env (e.g. bot@37.27.250.103). ssh/scp come from the
// Windows OpenSSH client and must be able to authenticate without a password —
// the same key-only access `ssh <host>` already uses.

import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import SnapBot from "./snapbot.js";
import { describeError, installTimestampedConsole } from "./logging.js";

const run = promisify(execFile);

installTimestampedConsole();

const args = process.argv.slice(2);
const deploy = !args.includes("--no-deploy");
const hostFlagIndex = args.indexOf("--host");
const host =
  (hostFlagIndex >= 0 ? args[hostFlagIndex + 1] : "")?.trim() ||
  process.env.DEPLOY_HOST?.trim() ||
  "";
const remotePath = process.env.DEPLOY_PATH?.trim() || "~/CapitolHillBot";
const service = process.env.DEPLOY_SERVICE?.trim() || "snapbot";

const username = process.env.USER_NAME?.trim() ?? "";
const password = process.env.USER_PASSWORD?.trim() ?? "";
const cookieFile = `${username}-cookies.json`;

// The login is headful and a human has to clear the CAPTCHA/2FA, so this cannot
// run on the server — and a half-completed run there would overwrite the live
// cookies with a logged-out session.
if (process.platform !== "win32") {
  console.error(
    "refresh-cookies is PC-only (needs a visible browser). Never run it on the VPS."
  );
  process.exit(1);
}

if (!username || !password) {
  console.error("Set USER_NAME and USER_PASSWORD in .env first.");
  process.exit(1);
}

if (deploy && !host) {
  console.error(
    "Set DEPLOY_HOST in .env (e.g. DEPLOY_HOST=bot@37.27.250.103), or pass --host, or use --no-deploy."
  );
  process.exit(1);
}

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 3 * 60 * 1000;
const VERIFY_POLL_MS = 5000;
const KEEP_REMOTE_BACKUPS = 5;

const SUCCESS_MARKER = "Snapchat session restored from an existing login.";
const FAILURE_MARKERS = [
  "Snapchat login required and cannot be completed unattended",
  "Snapchat login screen detected.",
];

async function ssh(command) {
  const { stdout } = await run(
    "ssh",
    ["-o", "ConnectTimeout=20", "-o", "BatchMode=yes", host, command],
    { maxBuffer: 10 * 1024 * 1024 }
  );
  return stdout;
}

async function loginAndSaveCookies() {
  const bot = new SnapBot();
  const before = fs.existsSync(cookieFile) ? fs.statSync(cookieFile).mtimeMs : 0;

  try {
    console.log("Opening a visible browser for Snapchat login.");
    await bot.launchSnapchat(
      { headless: false, args: ["--start-maximized"] },
      username
    );

    const initialState = await bot.waitForLoginScreenOrChatList(120000);
    const loggedIn = initialState === "chat_list" ? true : await bot.isLogged();

    if (!loggedIn) {
      console.log(
        "Logging in — complete any CAPTCHA/2FA in the browser window if prompted."
      );
      await bot.login({ username, password });
    } else {
      console.log("Existing session restored — refreshing cookies.");
    }

    await bot.handlePopup();
    await bot.waitForChatList(LOGIN_TIMEOUT_MS);
    await bot.saveCookies(username);
  } finally {
    try {
      await bot.browser?.close();
    } catch {
      // Browser may already be closed.
    }
  }

  // saveCookies swallows its own errors, so confirm the file actually moved
  // rather than trusting that it ran. Uploading a stale file would "succeed"
  // and leave the bot just as dead.
  if (!fs.existsSync(cookieFile)) {
    throw new Error(`${cookieFile} was not written.`);
  }
  if (fs.statSync(cookieFile).mtimeMs <= before) {
    throw new Error(
      `${cookieFile} was not updated — the login did not produce fresh cookies.`
    );
  }

  console.log(`Fresh cookies saved to ./${cookieFile}`);
}

async function backupRemoteCookies() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${remotePath}/${cookieFile}`;
  // Keep a bounded ring of backups so a rollback is always one command away
  // without the directory growing forever.
  await ssh(
    `set -e; cd ${remotePath}; ` +
      `if [ -f ${cookieFile} ]; then cp -a ${cookieFile} ${cookieFile}.bak-${stamp}; ` +
      `echo "backed up to ${cookieFile}.bak-${stamp}"; else echo "no existing cookie file"; fi; ` +
      `ls -1t ${cookieFile}.bak-* 2>/dev/null | tail -n +${KEEP_REMOTE_BACKUPS + 1} | xargs -r rm -f`
  ).then((out) => process.stdout.write(out));
  return `${target}.bak-${stamp}`;
}

async function uploadCookies() {
  await run("scp", [cookieFile, `${host}:${remotePath}/`], { cwd: process.cwd() });
  console.log(`Uploaded ${cookieFile} to ${host}:${remotePath}/`);
}

async function restartService() {
  // Whole seconds, one back, so the journal query can't miss the boot line to a
  // sub-second rounding race.
  const sinceEpoch = Math.floor(Date.now() / 1000) - 1;
  await ssh(`sudo -n systemctl restart ${service}`);
  console.log(`Restarted ${service}.`);
  return sinceEpoch;
}

async function verifySession(sinceEpoch) {
  console.log("Verifying the new session (up to 3 minutes)...");
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, VERIFY_POLL_MS));

    let logs = "";
    try {
      logs = await ssh(
        `journalctl -u ${service} -q --since "@${sinceEpoch}" --no-pager -o cat`
      );
    } catch (error) {
      console.warn(`  (journal read failed, retrying) ${describeError(error)}`);
      continue;
    }

    const failure = FAILURE_MARKERS.find((marker) => logs.includes(marker));
    if (failure) {
      return { ok: false, reason: failure, logs };
    }
    if (logs.includes(SUCCESS_MARKER)) {
      return { ok: true, logs };
    }
    process.stdout.write("  still starting...\n");
  }

  return {
    ok: false,
    reason: `no verdict within ${Math.round(VERIFY_TIMEOUT_MS / 1000)}s`,
  };
}

try {
  await loginAndSaveCookies();

  if (!deploy) {
    console.log("--no-deploy: stopping here. Cookies are fresh locally.");
    process.exitCode = 0;
  } else {
    const backup = await backupRemoteCookies();
    await uploadCookies();
    const sinceEpoch = await restartService();
    const result = await verifySession(sinceEpoch);

    if (result.ok) {
      console.log("");
      console.log("Session is live — the bot is logged in and running.");
      console.log(
        "Any trades queued during the outage will post on the next cycles."
      );
      process.exitCode = 0;
    } else {
      console.error("");
      console.error(`Verification FAILED: ${result.reason}`);
      console.error(
        `The previous cookie file is still on the server at ${backup} — ` +
          `restore it with:\n  ssh ${host} 'cp -a ${backup} ${remotePath}/${cookieFile} && sudo -n systemctl restart ${service}'`
      );
      if (result.logs) {
        console.error("\nLast lines from the server:");
        console.error(result.logs.trim().split("\n").slice(-15).join("\n"));
      }
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error("Cookie refresh failed:", describeError(error));
  process.exitCode = 1;
}
