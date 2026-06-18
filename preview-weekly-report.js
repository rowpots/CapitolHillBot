import dotenv from "dotenv";

import SnapBot from "./snapbot.js";
import { buildWeeklyReport, findLatestCompletedWeek } from "./weekly-report.js";

dotenv.config();

const args = parseArgs(process.argv.slice(2));
const REGULAR_SEASON_END_WEEK = 14;
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
  console.error("Unable to preview the weekly report.");
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
  const [rosters, users, matchupsByWeek] = await Promise.all([
    fetchJson(`https://api.sleeper.app/v1/league/${targetLeagueId}/rosters`),
    fetchJson(`https://api.sleeper.app/v1/league/${targetLeagueId}/users`),
    fetchMatchupsByWeek(targetLeagueId, 1, REGULAR_SEASON_END_WEEK),
  ]);

  const latestCompletedWeek = findLatestCompletedWeek(
    matchupsByWeek,
    REGULAR_SEASON_END_WEEK
  );
  const requestedWeek = args.week
    ? clampWeek(Number(args.week), REGULAR_SEASON_END_WEEK)
    : latestCompletedWeek;

  if (requestedWeek < 1) {
    throw new Error(
      "No completed regular-season weeks were found. Try `--previous` for last season."
    );
  }

  const report = buildWeeklyReport({
    league,
    rosters,
    users,
    matchupsByWeek,
    throughWeek: requestedWeek,
    regularSeasonEndWeek: REGULAR_SEASON_END_WEEK,
    playoffTeams: Number(league?.settings?.playoff_teams) || 6,
    simulationCount: Math.max(1000, Number(args.simulations) || 10000),
  });

  console.log(
    `Previewing ${report.leagueName} ${report.season} Week ${report.week} standings`
  );
  console.log("");
  console.log(report.textMessage);

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

    await sendPreviewReportToChat({
      chatId: targetChatId,
      message: report.textMessage,
    });
  }
}

async function resolveTargetLeagueId(currentLeagueId, options) {
  if (options.leagueId) {
    return String(options.leagueId).trim();
  }

  if (!options.previous) {
    return currentLeagueId;
  }

  const currentLeague = await fetchJson(
    `https://api.sleeper.app/v1/league/${currentLeagueId}`
  );
  const previousLeagueId = currentLeague?.previous_league_id?.trim?.();

  if (!previousLeagueId) {
    throw new Error("This league does not expose a previous_league_id.");
  }

  return previousLeagueId;
}

async function fetchMatchupsByWeek(leagueId, startWeek, endWeek) {
  const results = await Promise.all(
    Array.from({ length: endWeek - startWeek + 1 }, (_, index) => startWeek + index).map(
      async (week) => [
        week,
        await fetchJson(`https://api.sleeper.app/v1/league/${leagueId}/matchups/${week}`),
      ]
    )
  );

  return Object.fromEntries(results);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "tradebot-snapchat-bridge/1.0",
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${url} with status ${response.status}.`);
  }

  return response.json();
}

async function sendPreviewReportToChat({ chatId, message }) {
  validateSendEnvironment();

  const bot = new SnapBot();

  try {
    console.log("");
    console.log(`Sending preview report to test chat ${chatId}`);
    await startSnapchatSession(bot);
    await bot.openMessagingHome();
    await bot.sendMessage({
      chat: chatId,
      message,
      exit: false,
    });
    console.log("Preview report sent.");
  } finally {
    if (bot.browser) {
      await bot.closeBrowser().catch((error) => {
        console.warn("Unable to close the Snapchat browser cleanly.");
        console.warn(error.message);
      });
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

    if (arg === "--previous") {
      options.previous = true;
      continue;
    }

    if (arg.startsWith("--week=")) {
      options.week = arg.slice("--week=".length);
      continue;
    }

    if (arg === "--week") {
      options.week = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith("--simulations=")) {
      options.simulations = arg.slice("--simulations=".length);
      continue;
    }

    if (arg === "--simulations") {
      options.simulations = rawArgs[index + 1];
      index += 1;
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

function clampWeek(week, maximumWeek) {
  if (!Number.isFinite(week)) {
    return 0;
  }

  return Math.max(0, Math.min(maximumWeek, Math.trunc(week)));
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
