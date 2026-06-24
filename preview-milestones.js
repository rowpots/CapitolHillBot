import dotenv from "dotenv";

import { describeError, installTimestampedConsole } from "./logging.js";
import SnapBot from "./snapbot.js";
import { buildWeeklyReport, findLatestCompletedWeek } from "./weekly-report.js";
import {
  buildRecordBookFromHistory,
  createEmptyMilestoneState,
  detectMilestones,
} from "./milestones.js";

dotenv.config();
installTimestampedConsole();

const args = parseArgs(process.argv.slice(2));
const REGULAR_SEASON_END_WEEK = 14;
const PREVIEW_SIMULATION_COUNT = 2000;
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
  console.error("Unable to preview milestones.");
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
  if (latestCompletedWeek < 1) {
    throw new Error(
      "No completed regular-season weeks found. Try `--previous` for last season."
    );
  }

  const season = String(league?.season ?? "").trim();
  const playoffTeams = Number(league?.settings?.playoff_teams) || 6;

  // Baseline the record book from every season BEFORE this one, then replay this
  // season week by week so records "break" the historical baseline.
  console.log(`Seeding record book from seasons before ${season}...`);
  const recordBook = await buildRecordBookFromHistory({
    league,
    fetchJson,
    regularSeasonEndWeek: REGULAR_SEASON_END_WEEK,
    currentThroughWeek: 0,
    logger: console,
  });
  // Force enabled so even a first-ever season shows records forming.
  recordBook.seededFromHistory = true;

  console.log(
    `Replaying ${league?.name ?? "league"} ${season} Weeks 1-${latestCompletedWeek}\n`
  );

  let milestoneState = createEmptyMilestoneState();
  let book = recordBook;
  const nowMs = Date.now();
  let total = 0;

  for (let week = 1; week <= latestCompletedWeek; week += 1) {
    const report = buildWeeklyReport({
      league,
      rosters,
      users,
      matchupsByWeek,
      throughWeek: week,
      regularSeasonEndWeek: REGULAR_SEASON_END_WEEK,
      playoffTeams,
      simulationCount: PREVIEW_SIMULATION_COUNT,
    });

    const result = detectMilestones({
      report,
      matchupsByWeek,
      rosters,
      users,
      latestCompletedWeek: week,
      season,
      nowMs,
      milestoneState,
      recordBook: book,
      playoffAlertsEnabled: true,
      recordBookEnabled: true,
    });
    milestoneState = result.milestoneState;
    book = result.recordBook;

    if (result.events.length > 0) {
      console.log(`──────── Week ${week} ────────`);
      for (const event of result.events) {
        console.log(event.message);
        console.log(`   ⤷ would send around ${formatEt(event.releaseAtTimestampMs)}\n`);
        total += 1;
      }
    }
  }

  console.log(`Total milestone messages over the season: ${total}`);

  if (args.send) {
    let candidates = args.type
      ? milestoneState.queue.filter((event) => event.type === args.type)
      : milestoneState.queue;
    if (args.week != null) {
      candidates = candidates.filter((event) => event.id.endsWith(`-${args.week}`));
    }
    let samples;
    if (args.sendDistinct) {
      const seen = new Set();
      samples = candidates.filter((event) => {
        const key = subtypeKey(event);
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
    } else {
      samples = args.sendAll ? candidates : candidates.slice(0, 1);
    }
    if (samples.length === 0) {
      console.log("No milestone events to send as a sample.");
      return;
    }
    const targetChatId =
      args.chatId?.trim() || process.env.TEST_SNAPCHAT_GROUP_CHAT_ID?.trim() || "";
    if (!targetChatId) {
      throw new Error("Missing test chat id. Pass --chat-id or set TEST_SNAPCHAT_GROUP_CHAT_ID.");
    }
    await sendSamplesToChat({
      chatId: targetChatId,
      messages: samples.map((event) => event.message),
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

async function sendSamplesToChat({ chatId, messages }) {
  if (!credentials.username || !credentials.password) {
    throw new Error("Missing USER_NAME / USER_PASSWORD for --send.");
  }

  const bot = new SnapBot();
  try {
    console.log(`\nSending ${messages.length} milestone message(s) to test chat ${chatId}`);
    await startSnapchatSession(bot);
    for (const [index, message] of messages.entries()) {
      if (index > 0) {
        // Give Snapchat's UI a moment to settle between sends; firing them
        // back-to-back risks the message getting typed but never submitted.
        await delay(4000);
      }
      // openMessagingHome() must be called before each send in a session, or
      // the first message after it gets dropped (chat/textbox not settled).
      await bot.openMessagingHome();
      await bot.sendMessage({ chat: chatId, message, exit: false });
      console.log(`Sent ${index + 1}/${messages.length}.`);
    }
  } finally {
    if (bot.browser) {
      await bot.closeBrowser().catch(() => {});
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
      ],
    },
    credentials.username
  );

  const initialState = await bot.waitForLoginScreenOrChatList(
    runtimeConfig.snapchatStartupTimeoutMs
  );
  const loggedIn = initialState === "chat_list" ? true : await bot.isLogged();
  if (!loggedIn) {
    console.log("Logging into Snapchat.");
    await bot.login(credentials);
  }
  await bot.handlePopup();
  await bot.waitForChatList(runtimeConfig.snapchatLoginTimeoutMs);
  await bot.blockTypingNotifications(true);
  await bot.saveCookies(credentials.username);
}

function formatEt(timestampMs) {
  if (!Number.isFinite(timestampMs)) {
    return "unknown";
  }
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(new Date(timestampMs));
}

function parseArgs(rawArgs) {
  const options = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--send") {
      options.send = true;
    } else if (arg === "--send-all") {
      options.sendAll = true;
    } else if (arg === "--send-distinct") {
      options.sendDistinct = true;
    } else if (arg === "--previous") {
      options.previous = true;
    } else if (arg.startsWith("--type=")) {
      options.type = arg.slice("--type=".length);
    } else if (arg === "--type") {
      options.type = rawArgs[index + 1];
      index += 1;
    } else if (arg.startsWith("--week=")) {
      options.week = arg.slice("--week=".length);
    } else if (arg === "--week") {
      options.week = rawArgs[index + 1];
      index += 1;
    } else if (arg.startsWith("--league-id=")) {
      options.leagueId = arg.slice("--league-id=".length);
    } else if (arg === "--league-id") {
      options.leagueId = rawArgs[index + 1];
      index += 1;
    } else if (arg.startsWith("--chat-id=")) {
      options.chatId = arg.slice("--chat-id=".length);
    } else if (arg === "--chat-id") {
      options.chatId = rawArgs[index + 1];
      index += 1;
    }
  }
  return options;
}

function subtypeKey(event) {
  // Record events share type "record" but have distinct id prefixes per kind
  // (record-highestScore-..., record-lowestScore-..., record-blowout-...,
  // record-streak-...); other event types (clinch/byeClinch/eliminated) are
  // already one subtype each.
  return event.type === "record" ? event.id.split("-").slice(0, 2).join("-") : event.type;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
