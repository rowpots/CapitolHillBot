// Live one-shot test for the two-way chat-command feature. Logs in, reads the
// target chat, and for every `!command` currently present prints the reply it
// would send. With --send it actually replies in the chat. Unlike the real
// pollForChatCommands loop, this does NO priming/dedupe -- it answers whatever
// commands are visible right now, so you can drop a few commands in the test
// chat and immediately verify the responses. Run:
//   node preview-chat-commands.js               (test chat, print only)
//   node preview-chat-commands.js --send        (test chat, actually reply)
//   node preview-chat-commands.js --main        (use SNAPCHAT_GROUP_CHAT_ID)
//   node preview-chat-commands.js --chat-id <id>
import path from "path";
import { fileURLToPath } from "url";

import dotenv from "dotenv";

import { describeError, installTimestampedConsole } from "./logging.js";
import SnapBot from "./snapbot.js";
import { buildHallOfFameReport } from "./hall-of-fame.js";
import { buildPowerRankings, findLatestCompletedWeek } from "./weekly-report.js";
import { loadDynastyValueBook } from "./dynasty-values.js";
import {
  buildHelpMessage,
  buildMatchupPairings,
  buildPlayerNameIndex,
  buildStandingsFromRosters,
  buildTeamRecordMessage,
  buildTradeEvaluationMessage,
  filterMatchupPairings,
  formatMatchupsMessage,
  formatStandingsMessage,
  parseCommand,
} from "./chat-commands.js";

dotenv.config();
installTimestampedConsole();

const STATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), ".state");
const REGULAR_SEASON_END_WEEK = 14;
const args = parseArgs(process.argv.slice(2));
const prefix = process.env.CHAT_COMMAND_PREFIX?.trim() || "!";
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
  console.error("Unable to preview chat commands.");
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const leagueId = process.env.SLEEPER_LEAGUE_ID?.trim();
  if (!leagueId) {
    throw new Error("Missing SLEEPER_LEAGUE_ID in .env.");
  }
  const chatId = resolveChatId();
  console.log(`Target chat id: ${chatId}`);

  const bot = new SnapBot();
  try {
    await startSnapchatSession(bot);

    console.log("Reading the chat for commands...");
    const messages = await readChatMessagesWithRetry(bot, chatId);
    const commands = messages
      .filter((message) => String(message.from).trim().toLowerCase() !== "me")
      .map((message) => ({ message, parsed: parseCommand(message.text, prefix) }))
      .filter((entry) => entry.parsed);

    if (commands.length === 0) {
      console.log(
        `No ${prefix}commands found in the chat. Type some (e.g. ${prefix}help) and re-run.`
      );
      return;
    }

    console.log(`Found ${commands.length} command message(s).\n`);
    for (const { message, parsed } of commands) {
      console.log(`>> ${message.from}: ${prefix}${parsed.name}${parsed.argString ? " " + parsed.argString : ""}`);
      const reply = await buildCommandReply(parsed, leagueId);
      if (!reply) {
        console.log("   (no reply — unknown command)\n");
        continue;
      }
      console.log("--- reply ---");
      console.log(reply);
      console.log("-------------\n");

      if (args.send) {
        await sendMessageWithRetry(bot, chatId, reply);
        console.log("   (sent)\n");
      }
    }

    console.log(args.send ? "Done (replies sent)." : "Done (dry preview — pass --send to reply).");
  } finally {
    if (bot.browser) {
      await bot.closeBrowser().catch(() => {});
    }
  }
}

// Mirror of index.js buildCommandReply, kept standalone so the preview has no
// dependency on the main loop. If you add a command in chat-commands.js, wire it
// in both places.
async function buildCommandReply(parsed, leagueId) {
  const league = await fetchJson(`https://api.sleeper.app/v1/league/${leagueId}`);
  const leagueName = String(league?.name ?? "League").trim() || "League";

  switch (parsed.name) {
    case "help":
      return buildHelpMessage(prefix, leagueName);

    case "standings": {
      const { teams, seasonNote } = await resolveStandings(league, leagueId);
      return formatStandingsMessage({ leagueName, teams, seasonNote });
    }

    case "record": {
      const { teams, seasonNote } = await resolveStandings(league, leagueId);
      return buildTeamRecordMessage({ leagueName, teams, query: parsed.argString, prefix, seasonNote });
    }

    case "power":
      return (await resolvePowerRankings(league, leagueId)) ?? "Power rankings aren't available yet.";

    case "matchup":
      return (await resolveMatchups(league, leagueId, parsed.argString)) ?? "No matchups to show right now.";

    case "trade": {
      const [playersById, valueBook] = await Promise.all([
        fetchJson("https://api.sleeper.app/v1/players/nfl"),
        loadDynastyValueBook({
          cacheDir: STATE_DIR,
          preferredMode: process.env.DYNASTY_VALUE_MODE?.trim() || "auto",
          league,
          logger: console,
        }).catch(() => null),
      ]);
      if (!valueBook) {
        return "Trade values are unavailable right now — try again later.";
      }
      return buildTradeEvaluationMessage({
        argString: parsed.argString,
        playerIndex: buildPlayerNameIndex(playersById),
        valueBook,
        prefix,
      });
    }

    case "hof": {
      const hallOfFame = await loadHallOfFameSnapshot(leagueId);
      if (!hallOfFame) {
        return "The Hall of Fame isn't available yet — it's built at the end of the season.";
      }
      const [users, rosters] = await Promise.all([
        fetchJson(`https://api.sleeper.app/v1/league/${leagueId}/users`),
        fetchJson(`https://api.sleeper.app/v1/league/${leagueId}/rosters`),
      ]);
      const report = buildHallOfFameReport({ league, users, rosters, hallOfFame });
      return report?.textMessage ?? "No Hall of Fame data yet.";
    }

    default:
      return null;
  }
}

// Same offseason fallback as index.js resolveStandings.
async function resolveStandings(league, leagueId) {
  const [rosters, users] = await Promise.all([
    fetchJson(`https://api.sleeper.app/v1/league/${leagueId}/rosters`),
    fetchJson(`https://api.sleeper.app/v1/league/${leagueId}/users`),
  ]);
  const teams = buildStandingsFromRosters({ rosters, users });
  if (teams.some((team) => team.gamesPlayed > 0)) {
    return { teams, seasonNote: null };
  }

  const previousLeagueId = String(league?.previous_league_id ?? "").trim();
  if (!previousLeagueId || previousLeagueId === "0") {
    return { teams, seasonNote: null };
  }

  try {
    const previousLeague = await fetchJson(`https://api.sleeper.app/v1/league/${previousLeagueId}`);
    const [prevRosters, prevUsers] = await Promise.all([
      fetchJson(`https://api.sleeper.app/v1/league/${previousLeagueId}/rosters`),
      fetchJson(`https://api.sleeper.app/v1/league/${previousLeagueId}/users`),
    ]);
    const prevTeams = buildStandingsFromRosters({ rosters: prevRosters, users: prevUsers });
    if (prevTeams.some((team) => team.gamesPlayed > 0)) {
      const season = String(previousLeague?.season ?? "").trim();
      return { teams: prevTeams, seasonNote: season ? `${season} final` : "last season" };
    }
  } catch (error) {
    console.warn("Standings offseason fallback failed.");
  }
  return { teams, seasonNote: null };
}

// Same as index.js resolvePowerRankings.
async function resolvePowerRankings(league, leagueId) {
  const current = await buildPowerRankingsTextForLeague(leagueId, league);
  if (current) return current;

  const previousLeagueId = String(league?.previous_league_id ?? "").trim();
  if (!previousLeagueId || previousLeagueId === "0") return null;
  const previousLeague = await fetchJson(`https://api.sleeper.app/v1/league/${previousLeagueId}`);
  const season = String(previousLeague?.season ?? "").trim();
  return buildPowerRankingsTextForLeague(previousLeagueId, previousLeague, season ? `${season} final` : "last season");
}

async function buildPowerRankingsTextForLeague(leagueId, league, seasonNote = null) {
  const matchupsByWeek = await fetchMatchupsByWeek(leagueId, 1, REGULAR_SEASON_END_WEEK);
  const latestCompletedWeek = findLatestCompletedWeek(matchupsByWeek, REGULAR_SEASON_END_WEEK);
  if (latestCompletedWeek < 1) return null;
  const [rosters, users] = await Promise.all([
    fetchJson(`https://api.sleeper.app/v1/league/${leagueId}/rosters`),
    fetchJson(`https://api.sleeper.app/v1/league/${leagueId}/users`),
  ]);
  const report = buildPowerRankings({
    league,
    rosters,
    users,
    matchupsByWeek,
    throughWeek: latestCompletedWeek,
    week: latestCompletedWeek,
  });
  if (!report) return null;
  return seasonNote ? `(${seasonNote})\n${report.textMessage}` : report.textMessage;
}

// Same as index.js resolveMatchups.
async function resolveMatchups(league, leagueId, teamQuery) {
  const leagueName = String(league?.name ?? "League").trim() || "League";
  const nflState = await fetchJson("https://api.sleeper.app/v1/state/nfl").catch(() => null);
  const currentWeek = Number(nflState?.week) || 0;

  if (currentWeek >= 1) {
    const matchups = await fetchJson(
      `https://api.sleeper.app/v1/league/${leagueId}/matchups/${currentWeek}`
    ).catch(() => []);
    const reply = await formatMatchupsForLeague({
      leagueId,
      leagueName,
      week: currentWeek,
      matchups,
      teamQuery,
      allowEmptyFallback: true,
    });
    if (reply) return reply;
  }

  const here = await latestMatchupsForLeague(leagueId);
  if (here) {
    return formatMatchupsForLeague({ leagueId, leagueName, ...here, teamQuery });
  }

  const previousLeagueId = String(league?.previous_league_id ?? "").trim();
  if (previousLeagueId && previousLeagueId !== "0") {
    const previousLeague = await fetchJson(`https://api.sleeper.app/v1/league/${previousLeagueId}`);
    const there = await latestMatchupsForLeague(previousLeagueId);
    if (there) {
      const season = String(previousLeague?.season ?? "").trim();
      return formatMatchupsForLeague({
        leagueId: previousLeagueId,
        leagueName,
        ...there,
        teamQuery,
        seasonNote: season ? `${season} wk ${there.week}` : "last season",
      });
    }
  }
  return null;
}

async function latestMatchupsForLeague(leagueId) {
  const matchupsByWeek = await fetchMatchupsByWeek(leagueId, 1, 17);
  for (let week = 17; week >= 1; week -= 1) {
    const matchups = matchupsByWeek[week] ?? [];
    if (matchups.some((entry) => Number(entry?.points) > 0)) {
      return { week, matchups };
    }
  }
  return null;
}

async function formatMatchupsForLeague({
  leagueId,
  leagueName,
  week,
  matchups,
  teamQuery,
  seasonNote = null,
  allowEmptyFallback = false,
}) {
  const [rosters, users] = await Promise.all([
    fetchJson(`https://api.sleeper.app/v1/league/${leagueId}/rosters`),
    fetchJson(`https://api.sleeper.app/v1/league/${leagueId}/users`),
  ]);
  const allPairings = buildMatchupPairings({ matchups, rosters, users });
  if (allPairings.length === 0) {
    return allowEmptyFallback ? null : "No matchups to show right now.";
  }
  const pairings = filterMatchupPairings(allPairings, teamQuery);
  if (pairings.length === 0) {
    return `No matchup found for "${teamQuery}".`;
  }
  return formatMatchupsMessage({ leagueName, weekLabel: `Week ${week}`, pairings, seasonNote });
}

async function fetchMatchupsByWeek(leagueId, startWeek, endWeek) {
  const weeks = Array.from({ length: endWeek - startWeek + 1 }, (_, i) => startWeek + i);
  const results = await Promise.all(
    weeks.map(async (week) => {
      const matchups = await fetchJson(
        `https://api.sleeper.app/v1/league/${leagueId}/matchups/${week}`
      ).catch(() => []);
      return [week, Array.isArray(matchups) ? matchups : []];
    })
  );
  return Object.fromEntries(results);
}

async function loadHallOfFameSnapshot(leagueId) {
  // Use the cached state if seeded; otherwise do a quick fresh walk so the
  // preview can demonstrate !hof even before the season-end seed has run.
  const fs = await import("fs/promises");
  const path = await import("path");
  const { fileURLToPath } = await import("url");
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(dir, ".state", "hall-of-fame.json");
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (parsed?.seededFromHistory) {
      return parsed;
    }
  } catch (error) {
    // fall through to a fresh walk
  }

  const { buildHallOfFameFromHistory } = await import("./hall-of-fame.js");
  const league = await fetchJson(`https://api.sleeper.app/v1/league/${leagueId}`);
  return buildHallOfFameFromHistory({
    league,
    fetchJson,
    regularSeasonEndWeek: 14,
    logger: console,
  });
}

function resolveChatId() {
  if (args.chatId) return args.chatId.trim();
  if (args.main) {
    const id = process.env.SNAPCHAT_GROUP_CHAT_ID?.trim();
    if (!id) throw new Error("SNAPCHAT_GROUP_CHAT_ID not set.");
    return id;
  }
  const id =
    process.env.TEST_SNAPCHAT_GROUP_CHAT_ID?.trim() || process.env.SNAPCHAT_GROUP_CHAT_ID?.trim();
  if (!id) throw new Error("Neither TEST_SNAPCHAT_GROUP_CHAT_ID nor SNAPCHAT_GROUP_CHAT_ID is set.");
  return id;
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

// Reload the messaging home and retry the read if the chat row hasn't rendered
// yet (intermittent "Could not find chat"), matching the real poller.
async function readChatMessagesWithRetry(bot, chatId, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await bot.openMessagingHome();
      return await bot.readChatMessages(chatId);
    } catch (error) {
      lastError = error;
      if (!/Could not find chat/.test(String(error?.message ?? ""))) {
        throw error;
      }
      if (attempt < attempts) {
        console.warn(`Chat not ready for read (attempt ${attempt}/${attempts}); retrying.`);
        await new Promise((resolve) => setTimeout(resolve, 4000));
      }
    }
  }
  throw lastError;
}

async function sendMessageWithRetry(bot, chatId, message, attempts = 2) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await bot.openMessagingHome();
    try {
      await bot.sendMessage({ chat: chatId, message, exit: false });
      return;
    } catch (error) {
      const canRetry =
        attempt < attempts && /Could not find chat/.test(String(error?.message ?? ""));
      if (!canRetry) throw error;
      console.warn(`Chat not ready yet (attempt ${attempt}/${attempts}); waiting before retry.`);
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
  const options = {};
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--send") options.send = true;
    else if (arg === "--main") options.main = true;
    else if (arg === "--chat-id") {
      options.chatId = rawArgs[i + 1];
      i += 1;
    } else if (arg.startsWith("--chat-id=")) {
      options.chatId = arg.slice("--chat-id=".length);
    }
  }
  return options;
}

function parseInteger(value, fallbackValue) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallbackValue;
}

function parseBoolean(value, fallbackValue) {
  if (value == null || value === "") return fallbackValue;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}
