import dotenv from "dotenv";

import { describeError, installTimestampedConsole } from "./logging.js";
import SnapBot from "./snapbot.js";
import { buildRosterLookup, buildUserLookup } from "./weekly-report.js";
import { fetchSchedule, simulateGoingIntoLastGame } from "./nfl-schedule.js";
import {
  buildBigPerformanceAlert,
  buildLastGameAlerts,
  buildLivePairings,
  buildLiveTeams,
  buildNailbiterAlerts,
  buildRecordByRosterId,
  buildSnapshotMessage,
  buildUpsetAlerts,
  findBigPerformances,
  loadLiveScoringConfig,
} from "./live-scoring.js";

dotenv.config();
installTimestampedConsole();

const ALL_TYPES = ["snapshot", "bigperf", "nailbiter", "upset", "lastgame"];

const args = parseArgs(process.argv.slice(2));
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
  console.error("Unable to preview live scoring.");
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const currentLeagueId = process.env.SLEEPER_LEAGUE_ID?.trim();
  if (!currentLeagueId) {
    throw new Error("Missing SLEEPER_LEAGUE_ID in .env.");
  }

  // The preview prints/sends every selected type regardless of game window or
  // env toggles — it's for eyeballing the message templates against real data.
  const liveConfig = {
    ...loadLiveScoringConfig(),
    snapshotsEnabled: true,
    bigPerformanceEnabled: true,
    nailbiterEnabled: true,
    upsetEnabled: true,
  };

  const types = resolveTypes(args.types);

  const targetLeagueId = await resolveTargetLeagueId(currentLeagueId, args);
  const league = await fetchJson(`https://api.sleeper.app/v1/league/${targetLeagueId}`);
  const leagueName = String(league?.name ?? "League").trim() || "League";

  // Rosters/users are league-level (same across weeks); matchups vary per week.
  const [rosters, users] = await Promise.all([
    fetchJson(`https://api.sleeper.app/v1/league/${targetLeagueId}/rosters`),
    fetchJson(`https://api.sleeper.app/v1/league/${targetLeagueId}/users`),
  ]);
  const rosterLookup = buildRosterLookup(rosters ?? []);
  const userLookup = buildUserLookup(users ?? []);
  const recordByRosterId = buildRecordByRosterId(rosters ?? []);

  const playersById =
    types.includes("bigperf") || types.includes("lastgame")
      ? await fetchJson("https://api.sleeper.app/v1/players/nfl").catch(() => null)
      : null;

  const weeks = await resolveWeeks(targetLeagueId, args);
  console.log(
    `Replaying ${leagueName} ${league?.season ?? ""} live scoring — Week(s) ${weeks.join(
      ", "
    )} — types: ${types.join(", ")}\n`
  );

  const messagesToSend = [];

  for (const week of weeks) {
    const entries = await fetchJson(
      `https://api.sleeper.app/v1/league/${targetLeagueId}/matchups/${week}`
    );
    const weekEntries = Array.isArray(entries) ? entries : [];
    if (weekEntries.length === 0) {
      console.log(`Week ${week}: no matchup data.\n`);
      continue;
    }

    const teamsByRosterId = buildLiveTeams({ entries: weekEntries, rosterLookup, userLookup });
    const pairings = buildLivePairings(teamsByRosterId);

    console.log(`========== Week ${week} ==========`);

    if (types.includes("snapshot")) {
      const snapshot = buildSnapshotMessage({
        leagueName,
        week,
        checkpointLabel: "Live Snapshot",
        pairings,
      });
      console.log("\n-- Score snapshot --");
      console.log(snapshot ?? "(no pairings)");
      if (snapshot) {
        messagesToSend.push(snapshot);
      }
    }

    if (types.includes("bigperf")) {
      console.log(`\n-- Big performances (>= ${liveConfig.bigPerformanceThreshold}) --`);
      const performances = findBigPerformances({
        entries: weekEntries,
        week,
        teamsByRosterId,
        playersById,
        threshold: liveConfig.bigPerformanceThreshold,
      });
      if (performances.length === 0) {
        console.log(`(none over ${liveConfig.bigPerformanceThreshold})`);
      } else {
        for (const performance of performances) {
          const { message } = buildBigPerformanceAlert(performance);
          console.log(message);
          messagesToSend.push(message);
        }
      }
    }

    if (types.includes("nailbiter")) {
      console.log("\n-- Nailbiters --");
      const nailbiters = buildNailbiterAlerts({
        pairings,
        margin: liveConfig.nailbiterMargin,
        minCombined: liveConfig.minCombinedForLateAlert,
      });
      if (nailbiters.length === 0) {
        console.log("(none)");
      } else {
        for (const alert of nailbiters) {
          console.log(alert.message);
          messagesToSend.push(alert.message);
        }
      }
    }

    if (types.includes("upset")) {
      console.log("\n-- Upsets --");
      const upsets = buildUpsetAlerts({
        pairings,
        recordByRosterId,
        minCombined: liveConfig.minCombinedForLateAlert,
      });
      if (upsets.length === 0) {
        console.log("(none)");
      } else {
        for (const alert of upsets) {
          console.log(alert.message);
          messagesToSend.push(alert.message);
        }
      }
    }

    if (types.includes("lastgame")) {
      // A completed week's real schedule is all "post" (no one left to play), so
      // simulate "going into the last game" — force the final NFL slot back to
      // pre and everything earlier to post — to exercise the alert against the
      // week's actual point totals.
      console.log("\n-- Going into the last game (simulated final slot) --");
      const realSchedule = await fetchSchedule({
        fetchJson,
        season: league?.season,
        week,
      }).catch((error) => {
        console.warn(`  (ESPN schedule fetch failed: ${error.message})`);
        return null;
      });

      if (!realSchedule || realSchedule.games.length === 0) {
        console.log("(no schedule data)");
      } else {
        const simulated = simulateGoingIntoLastGame(realSchedule);
        const alerts = buildLastGameAlerts({
          teamsByRosterId,
          pairings,
          entries: weekEntries,
          week,
          playersById,
          schedule: simulated,
          maxDeficit: liveConfig.lastGameMaxDeficit,
        });
        if (alerts.length === 0) {
          console.log("(none — no trailing team had a player in the final game slot)");
        } else {
          for (const alert of alerts) {
            console.log(alert.message);
            messagesToSend.push(alert.message);
          }
        }
      }
    }

    console.log("");
  }

  if (args.send) {
    if (messagesToSend.length === 0) {
      console.log("Nothing to send (no messages matched the selected types/weeks).");
      return;
    }
    const targetChatId =
      args.chatId?.trim() || process.env.TEST_SNAPCHAT_GROUP_CHAT_ID?.trim() || "";
    if (!targetChatId) {
      throw new Error("Missing test chat id. Pass --chat-id or set TEST_SNAPCHAT_GROUP_CHAT_ID.");
    }
    await sendPreviewToChat({ chatId: targetChatId, messages: messagesToSend });
  }
}

function resolveTypes(rawTypes) {
  if (!rawTypes) {
    return ALL_TYPES;
  }
  const requested = rawTypes
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const valid = requested.filter((value) => ALL_TYPES.includes(value));
  if (valid.length === 0) {
    throw new Error(
      `No valid --types. Choose from: ${ALL_TYPES.join(", ")} (got "${rawTypes}").`
    );
  }
  return valid;
}

async function resolveWeeks(leagueId, options) {
  if (options.weeks.length > 0) {
    return options.weeks.map((value) => {
      const week = Number(value);
      if (!Number.isFinite(week) || week < 1) {
        throw new Error(`Invalid --week ${value}.`);
      }
      return Math.trunc(week);
    });
  }

  const nflState = await fetchJson("https://api.sleeper.app/v1/state/nfl").catch(() => null);
  const week = Number(nflState?.week);
  if (Number.isFinite(week) && week >= 1) {
    return [week];
  }

  throw new Error("Could not resolve the current NFL week. Pass --week N.");
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

async function fetchJson(url) {
  let response = null;
  try {
    response = await fetch(url, {
      headers: { "user-agent": "tradebot-snapchat-bridge/1.0", accept: "application/json" },
    });
  } catch (error) {
    throw new Error(`Network request failed for ${url}: ${describeError(error)}`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`Request failed for ${url} with status ${response.status}.`);
  }
  return response.json();
}

async function sendPreviewToChat({ chatId, messages }) {
  validateSendEnvironment();
  const bot = new SnapBot();
  try {
    console.log(`\nSending ${messages.length} live message(s) to test chat ${chatId}`);
    await startSnapchatSession(bot);
    for (let index = 0; index < messages.length; index += 1) {
      await sendMessageWithRetry(bot, chatId, messages[index]);
      console.log(`Sent ${index + 1}/${messages.length}.`);
      // Spacing between sends so Snapchat doesn't drop a message mid-burst
      // (same rationale as the live bot's one-message-per-cycle rule).
      if (index < messages.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
      }
    }
    console.log("All preview live messages sent.");
  } finally {
    if (bot.browser) {
      await bot.closeBrowser().catch((error) => {
        console.warn("Unable to close the Snapchat browser cleanly.");
        console.warn(error.message);
      });
    }
  }
}

async function sendMessageWithRetry(bot, chatId, message, attempts = 4) {
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

  const initialState = await bot.waitForLoginScreenOrChatList(
    runtimeConfig.snapchatStartupTimeoutMs
  );
  const loggedIn = initialState === "chat_list" ? true : await bot.isLogged();

  if (!loggedIn) {
    console.log("Logging into Snapchat.");
    await bot.login(credentials);
  } else if (initialState === "chat_list") {
    console.log("Snapchat session restored from an existing login.");
  }

  await bot.handlePopup();
  await bot.waitForChatList(runtimeConfig.snapchatLoginTimeoutMs);
  await bot.blockTypingNotifications(true);
  await bot.saveCookies(credentials.username);
}

function parseArgs(rawArgs) {
  const options = { weeks: [] };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--send") {
      options.send = true;
    } else if (arg === "--previous") {
      options.previous = true;
    } else if (arg.startsWith("--week=")) {
      options.weeks.push(arg.slice("--week=".length));
    } else if (arg === "--week") {
      options.weeks.push(rawArgs[index + 1]);
      index += 1;
    } else if (arg.startsWith("--types=")) {
      options.types = arg.slice("--types=".length);
    } else if (arg === "--types") {
      options.types = rawArgs[index + 1];
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

function validateSendEnvironment() {
  const missingKeys = [];
  if (!credentials.username) missingKeys.push("USER_NAME");
  if (!credentials.password) missingKeys.push("USER_PASSWORD");
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
