// Cookie refresher — run this ON THE WINDOWS PC, never on the VPS.
//
// Opens a visible browser, logs into Snapchat Web (complete any CAPTCHA/2FA
// in the window yourself), waits for the chat list, saves fresh cookies to
// ./<USER_NAME>-cookies.json, and exits. Then upload the cookie file to the
// VPS and restart the service (exact commands printed on success; also in
// deploy/server-setup.md).
//
// Usage: npm run login

import dotenv from "dotenv";
dotenv.config();

import SnapBot from "./snapbot.js";
import { installTimestampedConsole } from "./logging.js";

installTimestampedConsole();

const username = process.env.USER_NAME?.trim() ?? "";
const password = process.env.USER_PASSWORD?.trim() ?? "";

if (!username || !password) {
  console.error("Set USER_NAME and USER_PASSWORD in .env first.");
  process.exit(1);
}

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const bot = new SnapBot();

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

  console.log(`Fresh cookies saved to ./${username}-cookies.json`);
  console.log("Now upload them to the VPS and restart the bot:");
  console.log(`  scp .\\${username}-cookies.json bot@YOUR_VPS_IP:~/CapitolHillBot/`);
  console.log('  ssh bot@YOUR_VPS_IP "sudo systemctl restart snapbot"');
  process.exitCode = 0;
} catch (error) {
  console.error("Login failed:", error);
  process.exitCode = 1;
} finally {
  try {
    await bot.browser?.close();
  } catch {
    // Browser may already be closed.
  }
}
