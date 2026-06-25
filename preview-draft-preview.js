import dotenv from "dotenv";

import { describeError, installTimestampedConsole } from "./logging.js";
import SnapBot from "./snapbot.js";
import { loadDynastyValueBook } from "./dynasty-values.js";
import { buildDraftPreviewReport } from "./draft-preview.js";

dotenv.config();
installTimestampedConsole();

const args = parseArgs(process.argv.slice(2));
const credentials = {
  username: process.env.USER_NAME?.trim() ?? "",
  password: process.env.USER_PASSWORD?.trim() ?? "",
};
const runtimeConfig = {
  headless: parseBoolean(process.env.HEADLESS, false),
  snapchatStartupTimeoutMs: parseInteger(
    process.env.SNAPCHAT_STARTUP_TIMEOUT_MS,
    120000
  ),
  snapchatLoginTimeoutMs: parseInteger(
    process.env.SNAPCHAT_LOGIN_TIMEOUT_MS,
    600000
  ),
};

main().catch((error) => {
  console.error("Unable to preview the rookie draft report.");
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const targetLeagueId =
    args.leagueId?.trim() || process.env.SLEEPER_LEAGUE_ID?.trim();
  if (!targetLeagueId) {
    throw new Error("Missing SLEEPER_LEAGUE_ID in .env, or pass --league-id.");
  }

  const league = await fetchJson(`https://api.sleeper.app/v1/league/${targetLeagueId}`);
  const draftId = String(league?.draft_id ?? "").trim();
  if (!draftId) {
    throw new Error("This league has no draft_id set yet.");
  }

  const [draft, rosters, users, tradedPicks, playersById] = await Promise.all([
    fetchJson(`https://api.sleeper.app/v1/draft/${draftId}`),
    fetchJson(`https://api.sleeper.app/v1/league/${targetLeagueId}/rosters`),
    fetchJson(`https://api.sleeper.app/v1/league/${targetLeagueId}/users`),
    fetchJson(`https://api.sleeper.app/v1/league/${targetLeagueId}/traded_picks`),
    loadPlayersById(),
  ]);

  const valueBook = await loadDynastyValueBook({
    cacheDir: ".state",
    preferredMode: "auto",
    league,
    logger: console,
  });

  const report = buildDraftPreviewReport({
    league,
    draft,
    rosters,
    users,
    tradedPicks,
    playersById,
    valueBook,
  });

  if (!report) {
    console.log("No draft preview report to show yet (draft order is unavailable).");
    return;
  }

  console.log(report.textMessage);
  console.log("");

  if (args.send) {
    const targetChatId =
      args.chatId?.trim() ||
      process.env.TEST_SNAPCHAT_GROUP_CHAT_ID?.trim() ||
      "";

    if (!targetChatId) {
      throw new Error(
        "Missing test chat id. Pass --chat-id or set TEST_SNAPCHAT_GROUP_CHAT_ID."
      );
    }

    await sendPreviewToChat({ chatId: targetChatId, message: report.textMessage });
  }
}

async function loadPlayersById() {
  return fetchJson("https://api.sleeper.app/v1/players/nfl");
}

async function fetchJson(url) {
  let response = null;

  try {
    response = await fetch(url, {
      headers: {
        "user-agent": "tradebot-snapchat-bridge/1.0",
        accept: "application/json",
      },
    });
  } catch (error) {
    throw new Error(`Network request failed for ${url}: ${describeError(error)}`, {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new Error(`Request failed for ${url} with status ${response.status}.`);
  }

  return response.json();
}

async function sendPreviewToChat({ chatId, message }) {
  validateSendEnvironment();

  const bot = new SnapBot();

  try {
    console.log("");
    console.log(`Sending preview draft preview message to test chat ${chatId}`);
    await startSnapchatSession(bot);
    await sendMessageWithRetry(bot, chatId, message);
    console.log("Preview draft preview message sent.");
  } finally {
    if (bot.browser) {
      await bot.closeBrowser().catch((error) => {
        console.warn("Unable to close the Snapchat browser cleanly.");
        console.warn(error.message);
      });
    }
  }
}

// Reopening messaging home reloads the page, and right after a fast
// cookie-restored login the target chat's row can take a moment to render into
// the scrollable list. Reopen + retry once before giving up.
async function sendMessageWithRetry(bot, chatId, message, attempts = 2) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await bot.openMessagingHome();
    try {
      await bot.sendMessage({ chat: chatId, message, exit: false });
      return;
    } catch (error) {
      const canRetry =
        attempt < attempts &&
        /Could not find chat/.test(String(error?.message ?? ""));
      if (!canRetry) {
        throw error;
      }

      console.warn(
        `Chat not ready yet (attempt ${attempt}/${attempts}); waiting before retry.`
      );
      console.warn(error.message);
      await new Promise((resolve) => setTimeout(resolve, 4000));
    }
  }
}

async function startSnapchatSession(bot) {
  console.log("Launching Snapchat Web.");

  await bot.launchSnapchat(
    {
      headless: runtimeConfig.headless,
      args: [
        "--start-maximized",
        "--force-device-scale-factor=1",
        "--allow-file-access-from-files",
        "--use-fake-ui-for-media-stream",
        "--enable-media-stream",
      ],
    },
    credentials.username
  );

  const initialState = await bot.waitForLoginScreenOrChatList(
    runtimeConfig.snapchatStartupTimeoutMs
  );
  const loggedIn =
    initialState === "chat_list" ? true : await bot.isLogged();

  if (!loggedIn) {
    if (initialState === "login_screen") {
      console.log("Snapchat login screen detected.");
    }

    console.log("Logging into Snapchat.");
    await bot.login(credentials);
  } else if (initialState === "chat_list") {
    console.log("Snapchat session restored from an existing login.");
  } else {
    console.log("Snapchat session appears to be restoring. Waiting for chats to load.");
  }

  await bot.handlePopup();

  if (runtimeConfig.headless) {
    console.warn(
      "HEADLESS=true is enabled. Manual login, 2FA, or verification prompts may require HEADLESS=false."
    );
  } else {
    console.log(
      `Waiting up to ${Math.round(
        runtimeConfig.snapchatLoginTimeoutMs / 1000
      )} second(s) for Snapchat to finish login and load chats.`
    );
    console.log(
      "Complete any manual login, 2FA, or verification steps in the browser window if prompted."
    );
  }

  await bot.waitForChatList(runtimeConfig.snapchatLoginTimeoutMs);
  await bot.blockTypingNotifications(true);
  await bot.saveCookies(credentials.username);
}

function parseArgs(rawArgs) {
  const options = {};

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--send") {
      options.send = true;
      continue;
    }

    if (arg.startsWith("--league-id=")) {
      options.leagueId = arg.slice("--league-id=".length);
      continue;
    }

    if (arg === "--league-id") {
      options.leagueId = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith("--chat-id=")) {
      options.chatId = arg.slice("--chat-id=".length);
      continue;
    }

    if (arg === "--chat-id") {
      options.chatId = rawArgs[index + 1];
      index += 1;
    }
  }

  return options;
}

function validateSendEnvironment() {
  const missingKeys = [];

  if (!credentials.username) {
    missingKeys.push("USER_NAME");
  }

  if (!credentials.password) {
    missingKeys.push("USER_PASSWORD");
  }

  if (missingKeys.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingKeys.join(", ")}`
    );
  }
}

function parseInteger(value, fallbackValue) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallbackValue;
}

function parseBoolean(value, fallbackValue) {
  if (value == null || value === "") {
    return fallbackValue;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}
