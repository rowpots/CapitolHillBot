import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import dotenv from "dotenv";

import { describeError, installTimestampedConsole, parseJsonFile } from "./logging.js";
import SnapBot from "./snapbot.js";
import { buildAwardsCeremonyReport } from "./awards.js";

dotenv.config();
installTimestampedConsole();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_DIR = path.join(__dirname, ".state");
const TRADE_HISTORY_FILE = path.join(STATE_DIR, "trade-history.json");
const DRAFT_RESULTS_STATE_FILE = path.join(STATE_DIR, "draft-results-state.json");

const args = parseArgs(process.argv.slice(2));
const REGULAR_SEASON_END_WEEK = 14;
const credentials = {
  username: process.env.USER_NAME?.trim() ?? "",
  password: process.env.USER_PASSWORD?.trim() ?? "",
};
const runtimeConfig = {
  headless: parseBoolean(process.env.HEADLESS, false),
  snapchatStartupTimeoutMs: parseInteger(process.env.SNAPCHAT_STARTUP_TIMEOUT_MS, 120000),
  snapchatLoginTimeoutMs: parseInteger(process.env.SNAPCHAT_LOGIN_TIMEOUT_MS, 600000),
};

main().catch((error) => {
  console.error("Unable to preview the awards ceremony.");
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const currentLeagueId = process.env.SLEEPER_LEAGUE_ID?.trim();
  if (!currentLeagueId) {
    throw new Error("Missing SLEEPER_LEAGUE_ID in .env.");
  }

  const targetLeagueId = await resolveTargetLeagueId(currentLeagueId, args);
  const league = await fetchJson(`https://api.sleeper.app/v1/league/${targetLeagueId}`);
  const season = String(league?.season ?? "").trim();
  const playoffWeekStart = Number(league?.settings?.playoff_week_start) || 15;
  const lastPlayoffWeek = playoffWeekStart + 2;

  const [rosters, users, regularSeasonMatchupsByWeek, playoffMatchupsByWeek, playersById] =
    await Promise.all([
      fetchJson(`https://api.sleeper.app/v1/league/${targetLeagueId}/rosters`),
      fetchJson(`https://api.sleeper.app/v1/league/${targetLeagueId}/users`),
      fetchMatchupsByWeek(targetLeagueId, 1, REGULAR_SEASON_END_WEEK),
      fetchMatchupsByWeek(targetLeagueId, playoffWeekStart, lastPlayoffWeek),
      loadPlayersById(),
    ]);

  const fullSeasonMatchupsByWeek = { ...regularSeasonMatchupsByWeek, ...playoffMatchupsByWeek };

  const tradeHistoryEntries = await loadTradeHistoryEntriesForSeason(season);
  const draftResultsSnapshot = await findDraftResultsSnapshotForSeason(season);

  const report = buildAwardsCeremonyReport({
    league,
    rosters,
    users,
    matchupsByWeek: regularSeasonMatchupsByWeek,
    regularSeasonEndWeek: REGULAR_SEASON_END_WEEK,
    fullSeasonMatchupsByWeek,
    lastWeek: lastPlayoffWeek,
    tradeHistoryEntries,
    draftResultsSnapshot,
    playersById,
  });

  if (!report) {
    console.log("No awards to show yet (not enough season data).");
    return;
  }

  if (!tradeHistoryEntries.length) {
    console.log(
      "(No persisted trade-history.json entries for this season -- Best/Worst Trade will be omitted.)\n"
    );
  }
  if (!draftResultsSnapshot) {
    console.log(
      "(No draft-results-state.json snapshot for this season -- Draft Steal/Bust will be omitted.)\n"
    );
  }

  console.log(report.textMessage);
  console.log("");

  if (args.send) {
    await sendPreviewToChat({ chatId: resolveTargetChatId(), message: report.textMessage });
  }
}

async function loadTradeHistoryEntriesForSeason(season) {
  try {
    const fileContents = await fs.readFile(TRADE_HISTORY_FILE, "utf8");
    const parsed = parseJsonFile(fileContents);
    const entries = Array.isArray(parsed?.trades) ? parsed.trades : [];
    return entries.filter((entry) => String(entry?.season ?? "") === String(season));
  } catch (error) {
    return [];
  }
}

async function findDraftResultsSnapshotForSeason(season) {
  try {
    const fileContents = await fs.readFile(DRAFT_RESULTS_STATE_FILE, "utf8");
    const parsed = parseJsonFile(fileContents);
    const snapshots = Object.values(parsed?.snapshotsByDraftId ?? {});
    return snapshots.find((snapshot) => String(snapshot?.season ?? "") === String(season)) ?? null;
  } catch (error) {
    return null;
  }
}

async function loadPlayersById() {
  return fetchJson("https://api.sleeper.app/v1/players/nfl");
}

function resolveTargetChatId() {
  const targetChatId = args.chatId?.trim() || process.env.TEST_SNAPCHAT_GROUP_CHAT_ID?.trim() || "";
  if (!targetChatId) {
    throw new Error("Missing test chat id. Pass --chat-id or set TEST_SNAPCHAT_GROUP_CHAT_ID.");
  }
  return targetChatId;
}

async function resolveTargetLeagueId(currentLeagueId, options) {
  if (options.leagueId) {
    return String(options.leagueId).trim();
  }

  if (!options.previous) {
    return currentLeagueId;
  }

  const currentLeague = await fetchJson(`https://api.sleeper.app/v1/league/${currentLeagueId}`);
  const previousLeagueId = currentLeague?.previous_league_id?.trim?.();

  if (!previousLeagueId) {
    throw new Error("This league does not expose a previous_league_id.");
  }

  return previousLeagueId;
}

async function fetchMatchupsByWeek(leagueId, startWeek, endWeek) {
  const results = await Promise.all(
    Array.from({ length: endWeek - startWeek + 1 }, (_, index) => startWeek + index).map(
      async (week) => [week, await fetchJson(`https://api.sleeper.app/v1/league/${leagueId}/matchups/${week}`)]
    )
  );

  return Object.fromEntries(results);
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
    console.log(`Sending preview awards message to test chat ${chatId}`);
    await startSnapchatSession(bot);
    await sendMessageWithRetry(bot, chatId, message);
    console.log("Preview awards message sent.");
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
        attempt < attempts && /Could not find chat/.test(String(error?.message ?? ""));
      if (!canRetry) {
        throw error;
      }

      console.warn(`Chat not ready yet (attempt ${attempt}/${attempts}); waiting before retry.`);
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

  const initialState = await bot.waitForLoginScreenOrChatList(runtimeConfig.snapchatStartupTimeoutMs);
  const loggedIn = initialState === "chat_list" ? true : await bot.isLogged();

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
      `Waiting up to ${Math.round(runtimeConfig.snapchatLoginTimeoutMs / 1000)} second(s) for Snapchat to finish login and load chats.`
    );
    console.log("Complete any manual login, 2FA, or verification steps in the browser window if prompted.");
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

    if (arg === "--previous") {
      options.previous = true;
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
    throw new Error(`Missing required environment variables: ${missingKeys.join(", ")}`);
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
