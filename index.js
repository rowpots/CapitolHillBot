import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import dotenv from "dotenv";

import { describeError, installTimestampedConsole, parseJsonFile } from "./logging.js";
import { loadDynastyValueBook } from "./dynasty-values.js";
import { getRoastForSeverity } from "./roast-templates.js";
import SnapBot from "./snapbot.js";
import { renderTradeCardImage } from "./trade-card.js";
import {
  buildPowerRankings,
  buildWeeklyRecap,
  buildWeeklyReport,
  findLatestCompletedWeek,
  isThursdayAfterHourInEastern,
  isTuesdayAfterHourInEastern,
  isWeekdayAfterHourInEastern,
  isWeekdayAtOrAfterTimeInEastern,
} from "./weekly-report.js";
import {
  buildRecordBookFromHistory,
  createEmptyMilestoneState,
  createEmptyRecordBook,
  detectMilestones,
} from "./milestones.js";
import {
  BIG_MATCHUPS_MIN_WEEK,
  buildBigMatchupsReport,
} from "./big-matchups.js";
import {
  buildAllTimeDivisionSeries,
  buildDivisionRivalryReport,
  getDivisionNames,
  RIVALRY_QUARTER_WEEKS,
} from "./division-rivalry.js";

dotenv.config();
installTimestampedConsole();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATE_DIR = path.join(__dirname, ".state");
const STATE_FILE = path.join(STATE_DIR, "runtime-state.json");
const TRADE_HISTORY_FILE = path.join(STATE_DIR, "trade-history.json");
const WEEKLY_REPORT_STATE_FILE = path.join(
  STATE_DIR,
  "weekly-report-state.json"
);
const POWER_RANKINGS_STATE_FILE = path.join(
  STATE_DIR,
  "power-rankings-state.json"
);
const DIVISION_RIVALRY_STATE_FILE = path.join(
  STATE_DIR,
  "division-rivalry-state.json"
);
const BIG_MATCHUPS_STATE_FILE = path.join(
  STATE_DIR,
  "big-matchups-state.json"
);
const MILESTONE_STATE_FILE = path.join(STATE_DIR, "milestone-state.json");
const RECORD_BOOK_FILE = path.join(STATE_DIR, "record-book.json");
const MANUAL_TEST_TRIGGER_FILE = path.join(STATE_DIR, "manual-test-trade.json");
const PLAYERS_CACHE_FILE = path.join(STATE_DIR, "players-nfl.json");
const PLAYERS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20000;
const VERDICT_EPSILON = 100;
const MANUAL_TRIGGER_CHECK_INTERVAL_MS = 5000;
const REGULAR_SEASON_END_WEEK = 14;
const EASTERN_TIME_ZONE = "America/New_York";

const credentials = {
  username: process.env.USER_NAME?.trim() ?? "",
  password: process.env.USER_PASSWORD?.trim() ?? "",
};

const config = {
  sleeperLeagueId: process.env.SLEEPER_LEAGUE_ID?.trim() ?? "",
  snapchatGroupChatId: process.env.SNAPCHAT_GROUP_CHAT_ID?.trim() ?? "",
  testSnapchatGroupChatId:
    process.env.TEST_SNAPCHAT_GROUP_CHAT_ID?.trim() ?? "",
  pollIntervalMs: parseInteger(process.env.POLL_INTERVAL_MS, 60000),
  snapchatStartupTimeoutMs: parseInteger(
    process.env.SNAPCHAT_STARTUP_TIMEOUT_MS,
    120000
  ),
  snapchatLoginTimeoutMs: parseInteger(
    process.env.SNAPCHAT_LOGIN_TIMEOUT_MS,
    600000
  ),
  transactionStartRound: parseInteger(process.env.TRANSACTION_START_ROUND, 0),
  transactionEndRound: parseInteger(process.env.TRANSACTION_END_ROUND, 18),
  dynastyValueMode: parseValueMode(process.env.DYNASTY_VALUE_MODE, "auto"),
  tradeNotificationMode: parseTradeNotificationMode(
    process.env.TRADE_NOTIFICATION_MODE,
    "text"
  ),
  tradePrimeTimeSendHourEt: Math.max(
    0,
    Math.min(23, parseInteger(process.env.TRADE_PRIME_TIME_SEND_HOUR_ET, 16))
  ),
  roastThreshold: parseInteger(process.env.ROAST_THRESHOLD, 750),
  headless: parseBoolean(process.env.HEADLESS, false),
  dryRun: parseBoolean(process.env.DRY_RUN, false),
  runOnce: parseBoolean(process.env.RUN_ONCE, false),
  roastMode: parseBoolean(process.env.ROAST_MODE, true),
  weeklyReportsEnabled: parseBoolean(
    process.env.WEEKLY_REPORTS_ENABLED,
    true
  ),
  weeklyReportSendHourEt: Math.max(
    0,
    Math.min(23, parseInteger(process.env.WEEKLY_REPORT_SEND_HOUR_ET, 10))
  ),
  weeklyReportSimulationCount: Math.max(
    1000,
    parseInteger(process.env.WEEKLY_REPORT_SIMULATION_COUNT, 10000)
  ),
  powerRankingsEnabled: parseBoolean(process.env.POWER_RANKINGS_ENABLED, true),
  powerRankingSendHourEt: Math.max(
    0,
    Math.min(23, parseInteger(process.env.POWER_RANKING_SEND_HOUR_ET, 19))
  ),
  playoffAlertsEnabled: parseBoolean(process.env.PLAYOFF_ALERTS_ENABLED, true),
  recordBookEnabled: parseBoolean(process.env.RECORD_BOOK_ENABLED, true),
  divisionRivalryEnabled: parseBoolean(
    process.env.DIVISION_RIVALRY_ENABLED,
    true
  ),
  bigMatchupsEnabled: parseBoolean(process.env.BIG_MATCHUPS_ENABLED, true),
  bigMatchupsSendHourEt: Math.max(
    0,
    Math.min(23, parseInteger(process.env.BIG_MATCHUPS_SEND_HOUR_ET, 19))
  ),
  bigMatchupsSendMinuteEt: Math.max(
    0,
    Math.min(59, parseInteger(process.env.BIG_MATCHUPS_SEND_MINUTE_ET, 45))
  ),
};

const bot = new SnapBot();

let isShuttingDown = false;
let hasWarnedStalePlayerCache = false;

main().catch(async (error) => {
  console.error("Fatal error while running the Sleeper trade bot.");
  console.error(error);
  await shutdown();
  process.exitCode = 1;
});

process.on("SIGINT", async () => {
  console.log("\nReceived SIGINT, shutting down.");
  await shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\nReceived SIGTERM, shutting down.");
  await shutdown();
  process.exit(0);
});

async function main() {
  validateEnvironment();

  const state = await loadState();
  const weeklyReportState = await loadWeeklyReportState();
  const powerRankingsState = await loadPowerRankingsState();
  const divisionRivalryState = await loadDivisionRivalryState();
  const bigMatchupsState = await loadBigMatchupsState();

  if (!config.dryRun) {
    await startSnapchatSession();
  } else {
    console.log("Dry run enabled. Snapchat messages will not be sent.");
  }

  if (!state.initialized) {
    const existingTrades = await fetchCompleteTrades();
    for (const trade of existingTrades) {
      state.sentTransactionIds.add(String(trade.transaction_id));
    }

    state.initialized = true;
    state.initializedAt = new Date().toISOString();
    await saveState(state);

    console.log(
      `Seeded ${existingTrades.length} completed trade(s). Waiting for new trades.`
    );
  } else {
    console.log(
      `Loaded ${state.sentTransactionIds.size} known transaction id(s).`
    );
  }

  do {
    try {
      await processQueuedManualTestTrade();
      await flushQueuedTradeNotifications(state);
      await flushMilestones();
      await pollForWeeklyReport(weeklyReportState);
      await pollForPowerRankings(powerRankingsState);
      await pollForDivisionRivalry(divisionRivalryState);
      await pollForBigMatchups(bigMatchupsState);
      await pollForTrades(state);
    } catch (error) {
      console.error("Polling cycle failed, but the bot will keep running.");
      console.error(error);
    }

    if (config.runOnce) {
      console.log("Run-once mode complete.");
      break;
    }

    console.log(
      `Sleeping for ${Math.round(config.pollIntervalMs / 1000)} second(s).`
    );
    await sleepWithManualTriggerChecks(config.pollIntervalMs);
  } while (true);

  await shutdown();
}

async function startSnapchatSession() {
  console.log("Launching Snapchat Web.");
  await establishSnapchatSession();
}

async function establishSnapchatSession() {
  await bot.launchSnapchat(
    {
      headless: config.headless,
      args: [
        "--start-maximized",
        "--force-device-scale-factor=1",
        "--allow-file-access-from-files",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--enable-media-stream",
      ],
    },
    credentials.username
  );

  const initialState = await bot.waitForLoginScreenOrChatList(
    config.snapchatStartupTimeoutMs
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

  if (config.headless) {
    console.warn(
      "HEADLESS=true is enabled. Manual login, 2FA, or verification prompts may require HEADLESS=false."
    );
  } else {
    console.log(
      `Waiting up to ${Math.round(
        config.snapchatLoginTimeoutMs / 1000
      )} second(s) for Snapchat to finish login and load chats.`
    );
    console.log(
      "Complete any manual login, 2FA, or verification steps in the browser window if prompted."
    );
  }

  await bot.waitForChatList(config.snapchatLoginTimeoutMs);
  await bot.blockTypingNotifications(true);
  await bot.saveCookies(credentials.username);
}

async function restartSnapchatSession() {
  console.warn("Restarting the Snapchat browser session.");

  try {
    if (bot.browser) {
      await bot.browser.close();
    }
  } catch (error) {
    console.warn("Unable to close the previous Snapchat browser cleanly.");
    console.warn(error.message);
  } finally {
    bot.browser = null;
    bot.page = null;
  }

  await establishSnapchatSession();
}

async function ensureSnapchatSessionReady() {
  if (config.dryRun) {
    return;
  }

  const browserConnected =
    typeof bot.browser?.connected === "function"
      ? bot.browser.connected()
      : Boolean(bot.browser?.connected);
  const pageClosed = bot.page?.isClosed?.() ?? true;

  if (!browserConnected || pageClosed) {
    await restartSnapchatSession();
    return;
  }

  try {
    await bot.handlePopup(1500);
  } catch (error) {
    if (!isRecoverableSnapError(error)) {
      throw error;
    }

    await restartSnapchatSession();
  }
}

async function pollForTrades(state) {
  console.log(
    `Checking Sleeper league ${config.sleeperLeagueId} for completed trades.`
  );

  const trades = await fetchCompleteTrades();
  const newTrades = trades.filter(
    (trade) =>
      !state.sentTransactionIds.has(String(trade.transaction_id)) &&
      !hasQueuedTradeNotification(state, String(trade.transaction_id))
  );

  if (newTrades.length === 0) {
    console.log("No new completed trades found.");
    return;
  }

  console.log(`Found ${newTrades.length} new completed trade(s).`);

  const [league, rosters, users, playersById] = await Promise.all([
    fetchJson(`https://api.sleeper.app/v1/league/${config.sleeperLeagueId}`),
    fetchJson(`https://api.sleeper.app/v1/league/${config.sleeperLeagueId}/rosters`),
    fetchJson(`https://api.sleeper.app/v1/league/${config.sleeperLeagueId}/users`),
    loadPlayersById(),
  ]);

  let valueBook = null;
  try {
    valueBook = await loadDynastyValueBook({
      cacheDir: STATE_DIR,
      preferredMode: config.dynastyValueMode,
      league,
      logger: console,
    });
  } catch (error) {
    console.warn("Dynasty values are unavailable for this polling cycle.");
    console.warn(error.message);
  }

  const rosterLookup = buildRosterLookup(rosters);
  const userLookup = buildUserLookup(users);
  const totalRosters = Number(league?.total_rosters) || rosterLookup.size || 12;

  await saveTradeHistoryLog(trades, rosterLookup, userLookup);

  for (const trade of newTrades) {
    try {
      const analysis = buildTradeAnalysis(trade, {
        allTrades: trades,
        league,
        playersById,
        rosterLookup,
        userLookup,
        valueBook,
        totalRosters,
      });

      const releaseAtTimestampMs = resolveTradeNotificationReleaseAtTimestampMs(
        trade
      );
      if (
        Number.isFinite(releaseAtTimestampMs) &&
        releaseAtTimestampMs > Date.now()
      ) {
        queueTradeNotification(state, {
          transactionId: String(trade.transaction_id),
          acceptedAtTimestampMs: getTradeAcceptedTimestampMs(trade),
          releaseAtTimestampMs,
          analysis,
        });
        await saveState(state);
        console.log(
          `Queued trade ${trade.transaction_id} for ${formatTimestamp(
            releaseAtTimestampMs
          )}.`
        );
        continue;
      }

      const delivered = await deliverTradeNotification(analysis);
      if (!delivered) {
        console.warn(
          `Trade ${trade.transaction_id} was not marked as sent because every delivery path failed.`
        );
        continue;
      }

      state.sentTransactionIds.add(String(trade.transaction_id));
      await saveState(state);
      console.log(`Trade ${trade.transaction_id} recorded as sent.`);
    } catch (error) {
      console.error(`Unable to process trade ${trade.transaction_id}.`);
      console.error(error);
    }
  }
}

async function pollForWeeklyReport(weeklyReportState) {
  if (!config.weeklyReportsEnabled) {
    return;
  }

  const now = new Date();
  if (!isTuesdayAfterHourInEastern(now, config.weeklyReportSendHourEt)) {
    return;
  }

  const league = await fetchJson(
    `https://api.sleeper.app/v1/league/${config.sleeperLeagueId}`
  );
  const season = String(league?.season ?? "").trim();

  if (!season) {
    console.warn("Weekly report skipped because the Sleeper season is unavailable.");
    return;
  }

  const matchupsByWeek = await fetchMatchupsByWeek({
    leagueId: config.sleeperLeagueId,
    startWeek: 1,
    endWeek: REGULAR_SEASON_END_WEEK,
  });
  const latestCompletedWeek = findLatestCompletedWeek(
    matchupsByWeek,
    REGULAR_SEASON_END_WEEK
  );

  if (latestCompletedWeek < 1) {
    return;
  }

  if (hasSentWeeklyReport(weeklyReportState, season, latestCompletedWeek)) {
    return;
  }

  const [rosters, users] = await Promise.all([
    fetchJson(`https://api.sleeper.app/v1/league/${config.sleeperLeagueId}/rosters`),
    fetchJson(`https://api.sleeper.app/v1/league/${config.sleeperLeagueId}/users`),
  ]);
  const playoffTeams =
    Number(league?.settings?.playoff_teams) > 0
      ? Number(league.settings.playoff_teams)
      : 6;
  const report = buildWeeklyReport({
    league,
    rosters,
    users,
    matchupsByWeek,
    throughWeek: latestCompletedWeek,
    regularSeasonEndWeek: REGULAR_SEASON_END_WEEK,
    playoffTeams,
    simulationCount: config.weeklyReportSimulationCount,
  });

  const recap = buildWeeklyRecap({
    league,
    rosters,
    users,
    matchupsByWeek,
    week: latestCompletedWeek,
  });

  // Detect playoff clinch/elimination + broken records from this week's results
  // and queue them with spread-out release times. Does not send here.
  await refreshMilestones({
    league,
    season,
    rosters,
    users,
    matchupsByWeek,
    report,
    latestCompletedWeek,
  });

  if (config.dryRun) {
    console.log(`[Dry Run] ${report.textMessage}`);
    if (recap) {
      console.log(`[Dry Run] ${recap.textMessage}`);
    }
    return;
  }

  await sendChatMessage(
    report.textMessage,
    `weekly report for week ${latestCompletedWeek}`
  );

  // The recap is a best-effort second message. A failure here must not block
  // markWeeklyReportSent, otherwise the standings post would resend next cycle.
  if (recap) {
    try {
      await sendChatMessage(
        recap.textMessage,
        `weekly recap for week ${latestCompletedWeek}`
      );
    } catch (error) {
      console.warn(`Weekly recap send failed for week ${latestCompletedWeek}.`);
      console.warn(error.message);
    }
  }

  markWeeklyReportSent(weeklyReportState, {
    season,
    week: latestCompletedWeek,
    leagueId: config.sleeperLeagueId,
  });
  await saveWeeklyReportState(weeklyReportState);
}

async function pollForPowerRankings(powerRankingsState) {
  if (!config.powerRankingsEnabled) {
    return;
  }

  const now = new Date();
  if (!isThursdayAfterHourInEastern(now, config.powerRankingSendHourEt)) {
    return;
  }

  const league = await fetchJson(
    `https://api.sleeper.app/v1/league/${config.sleeperLeagueId}`
  );
  const season = String(league?.season ?? "").trim();

  if (!season) {
    console.warn("Power rankings skipped because the Sleeper season is unavailable.");
    return;
  }

  const matchupsByWeek = await fetchMatchupsByWeek({
    leagueId: config.sleeperLeagueId,
    startWeek: 1,
    endWeek: REGULAR_SEASON_END_WEEK,
  });
  const latestCompletedWeek = findLatestCompletedWeek(
    matchupsByWeek,
    REGULAR_SEASON_END_WEEK
  );

  // The rankings posted on a Thursday are for the upcoming slate, so the
  // display week is one past the last completed week. We post for Weeks 2-14
  // (Week 1 has no games played yet to rank from).
  const displayWeek = latestCompletedWeek + 1;
  if (latestCompletedWeek < 1 || displayWeek > REGULAR_SEASON_END_WEEK) {
    return;
  }

  if (hasSentWeeklyReport(powerRankingsState, season, displayWeek)) {
    return;
  }

  const [rosters, users] = await Promise.all([
    fetchJson(`https://api.sleeper.app/v1/league/${config.sleeperLeagueId}/rosters`),
    fetchJson(`https://api.sleeper.app/v1/league/${config.sleeperLeagueId}/users`),
  ]);

  // Movement is measured against the last ranking we sent, but only when it was
  // for this same season.
  const previousOrder =
    powerRankingsState.lastRanking?.season === season
      ? powerRankingsState.lastRanking?.order ?? []
      : [];

  const powerRankings = buildPowerRankings({
    league,
    rosters,
    users,
    matchupsByWeek,
    throughWeek: latestCompletedWeek,
    week: displayWeek,
    previousOrder,
  });

  if (!powerRankings) {
    return;
  }

  if (config.dryRun) {
    console.log(`[Dry Run] ${powerRankings.textMessage}`);
    return;
  }

  await sendChatMessage(
    powerRankings.textMessage,
    `power rankings for week ${displayWeek}`
  );

  markWeeklyReportSent(powerRankingsState, {
    season,
    week: displayWeek,
    leagueId: config.sleeperLeagueId,
  });
  powerRankingsState.lastRanking = {
    season,
    week: displayWeek,
    order: powerRankings.order,
  };
  await savePowerRankingsState(powerRankingsState);
}

async function pollForDivisionRivalry(divisionRivalryState) {
  if (!config.divisionRivalryEnabled) {
    return;
  }

  const now = new Date();
  if (!isWeekdayAfterHourInEastern(now, "Wednesday", config.weeklyReportSendHourEt)) {
    return;
  }

  const league = await fetchJson(
    `https://api.sleeper.app/v1/league/${config.sleeperLeagueId}`
  );
  const season = String(league?.season ?? "").trim();

  if (!season) {
    console.warn("Division rivalry tracker skipped because the Sleeper season is unavailable.");
    return;
  }

  const matchupsByWeek = await fetchMatchupsByWeek({
    leagueId: config.sleeperLeagueId,
    startWeek: 1,
    endWeek: REGULAR_SEASON_END_WEEK,
  });
  const latestCompletedWeek = findLatestCompletedWeek(
    matchupsByWeek,
    REGULAR_SEASON_END_WEEK
  );

  // Only post on the Wednesday right after a quarter boundary completes, not
  // every week.
  if (!RIVALRY_QUARTER_WEEKS.includes(latestCompletedWeek)) {
    return;
  }

  if (hasSentWeeklyReport(divisionRivalryState, season, latestCompletedWeek)) {
    return;
  }

  const [rosters, users] = await Promise.all([
    fetchJson(`https://api.sleeper.app/v1/league/${config.sleeperLeagueId}/rosters`),
    fetchJson(`https://api.sleeper.app/v1/league/${config.sleeperLeagueId}/users`),
  ]);

  let allTimeSeries = null;
  try {
    allTimeSeries = await buildAllTimeDivisionSeries({
      league,
      fetchJson,
      regularSeasonEndWeek: REGULAR_SEASON_END_WEEK,
      currentThroughWeek: latestCompletedWeek,
      currentDivisionNames: getDivisionNames(league),
      logger: console,
    });
  } catch (error) {
    console.warn("Division rivalry all-time series lookup failed; sending without it.");
    console.warn(error.message);
  }

  const rivalryReport = buildDivisionRivalryReport({
    league,
    rosters,
    users,
    matchupsByWeek,
    throughWeek: latestCompletedWeek,
    allTimeSeries,
  });

  if (!rivalryReport) {
    console.log("Division rivalry tracker skipped: no interdivision games played yet.");
  } else if (config.dryRun) {
    console.log(`[Dry Run] ${rivalryReport.textMessage}`);
    return;
  } else {
    await sendChatMessage(
      rivalryReport.textMessage,
      `division rivalry tracker for week ${latestCompletedWeek}`
    );
  }

  if (config.dryRun) {
    return;
  }

  markWeeklyReportSent(divisionRivalryState, {
    season,
    week: latestCompletedWeek,
    leagueId: config.sleeperLeagueId,
  });
  await saveDivisionRivalryState(divisionRivalryState);
}

async function pollForBigMatchups(bigMatchupsState) {
  if (!config.bigMatchupsEnabled) {
    return;
  }

  const now = new Date();
  if (
    !isWeekdayAtOrAfterTimeInEastern(
      now,
      "Thursday",
      config.bigMatchupsSendHourEt,
      config.bigMatchupsSendMinuteEt
    )
  ) {
    return;
  }

  const league = await fetchJson(
    `https://api.sleeper.app/v1/league/${config.sleeperLeagueId}`
  );
  const season = String(league?.season ?? "").trim();

  if (!season) {
    console.warn("Big matchups preview skipped because the Sleeper season is unavailable.");
    return;
  }

  const matchupsByWeek = await fetchMatchupsByWeek({
    leagueId: config.sleeperLeagueId,
    startWeek: 1,
    endWeek: REGULAR_SEASON_END_WEEK,
  });
  const latestCompletedWeek = findLatestCompletedWeek(
    matchupsByWeek,
    REGULAR_SEASON_END_WEEK
  );

  // Previews the *upcoming* week's matchups, same displayWeek convention as
  // power rankings.
  const displayWeek = latestCompletedWeek + 1;
  if (latestCompletedWeek < BIG_MATCHUPS_MIN_WEEK || displayWeek > REGULAR_SEASON_END_WEEK) {
    return;
  }

  if (hasSentWeeklyReport(bigMatchupsState, season, displayWeek)) {
    return;
  }

  const [rosters, users] = await Promise.all([
    fetchJson(`https://api.sleeper.app/v1/league/${config.sleeperLeagueId}/rosters`),
    fetchJson(`https://api.sleeper.app/v1/league/${config.sleeperLeagueId}/users`),
  ]);
  const playoffTeams =
    Number(league?.settings?.playoff_teams) > 0
      ? Number(league.settings.playoff_teams)
      : 6;
  const report = buildWeeklyReport({
    league,
    rosters,
    users,
    matchupsByWeek,
    throughWeek: latestCompletedWeek,
    regularSeasonEndWeek: REGULAR_SEASON_END_WEEK,
    playoffTeams,
    simulationCount: config.weeklyReportSimulationCount,
  });

  const bigMatchupsReport = buildBigMatchupsReport({
    league,
    standings: report.standings,
    matchupsByWeek,
    displayWeek,
  });

  if (!bigMatchupsReport) {
    console.log(
      `Big matchups preview skipped: no marquee matchups for week ${displayWeek}.`
    );
  } else if (config.dryRun) {
    console.log(`[Dry Run] ${bigMatchupsReport.textMessage}`);
    return;
  } else {
    await sendChatMessage(
      bigMatchupsReport.textMessage,
      `big matchups preview for week ${displayWeek}`
    );
  }

  if (config.dryRun) {
    return;
  }

  markWeeklyReportSent(bigMatchupsState, {
    season,
    week: displayWeek,
    leagueId: config.sleeperLeagueId,
  });
  await saveBigMatchupsState(bigMatchupsState);
}

async function refreshMilestones({
  league,
  season,
  rosters,
  users,
  matchupsByWeek,
  report,
  latestCompletedWeek,
}) {
  if (!config.playoffAlertsEnabled && !config.recordBookEnabled) {
    return;
  }

  const milestoneState = await loadMilestoneState();
  let recordBook = await loadRecordBook();

  // Seed the all-time record book once (retried until it succeeds).
  if (config.recordBookEnabled && !recordBook.seededFromHistory) {
    try {
      recordBook = await buildRecordBookFromHistory({
        league,
        fetchJson,
        regularSeasonEndWeek: REGULAR_SEASON_END_WEEK,
        currentThroughWeek: latestCompletedWeek,
        logger: console,
      });
      await saveRecordBook(recordBook);
    } catch (error) {
      console.warn("Record book history seeding failed; will retry next week.");
      console.warn(error.message);
    }
  }

  // First time we see this season: silently baseline so we never backfill-spam
  // clinches/records that already happened before the bot started watching.
  if (milestoneState.season !== season) {
    const baseline = baselineMilestoneState({
      report,
      season,
      latestCompletedWeek,
      queue: milestoneState.queue,
    });
    await saveMilestoneState(baseline);
    console.log(
      `Milestone tracking baselined for season ${season} through week ${latestCompletedWeek}.`
    );
    return;
  }

  if (milestoneState.detectedThroughWeek >= latestCompletedWeek) {
    return;
  }

  const { events, milestoneState: updatedState, recordBook: updatedBook } =
    detectMilestones({
      report,
      matchupsByWeek,
      rosters,
      users,
      latestCompletedWeek,
      season,
      nowMs: Date.now(),
      milestoneState,
      recordBook,
      playoffAlertsEnabled: config.playoffAlertsEnabled,
      recordBookEnabled: config.recordBookEnabled,
    });

  if (config.dryRun) {
    if (events.length === 0) {
      console.log("[Dry Run] No new milestones this week.");
    }
    for (const event of events) {
      console.log(
        `[Dry Run] Queued milestone (${formatTimestamp(
          event.releaseAtTimestampMs
        )}): ${event.message.replace(/\n/g, " / ")}`
      );
    }
    return;
  }

  await saveMilestoneState(updatedState);
  await saveRecordBook(updatedBook);

  if (events.length > 0) {
    console.log(
      `Queued ${events.length} milestone message(s) to release through the week.`
    );
  }
}

async function flushMilestones() {
  if (!config.playoffAlertsEnabled && !config.recordBookEnabled) {
    return;
  }

  const milestoneState = await loadMilestoneState();
  const queue = Array.isArray(milestoneState.queue) ? milestoneState.queue : [];
  const due = queue
    .filter(
      (event) =>
        Number.isFinite(event?.releaseAtTimestampMs) &&
        event.releaseAtTimestampMs <= Date.now()
    )
    .sort((left, right) => left.releaseAtTimestampMs - right.releaseAtTimestampMs);

  if (due.length === 0) {
    return;
  }

  if (config.dryRun) {
    for (const event of due) {
      console.log(`[Dry Run] Milestone: ${event.message.replace(/\n/g, " / ")}`);
      milestoneState.queue = milestoneState.queue.filter((item) => item.id !== event.id);
    }
    await saveMilestoneState(milestoneState);
    return;
  }

  // Send at most one milestone per poll cycle. If a backlog ever builds up
  // (e.g. the bot was offline past several release slots), this makes it
  // trickle out one message per pollIntervalMs instead of bursting them all
  // at once back-to-back, which both looks like spam and risks Snapchat's
  // UI dropping a send when the textbox hasn't settled from the last one.
  const [event] = due;
  try {
    await sendChatMessage(event.message, `milestone ${event.type}`);
    milestoneState.queue = milestoneState.queue.filter((item) => item.id !== event.id);
    await saveMilestoneState(milestoneState);
  } catch (error) {
    console.warn(`Milestone send failed for ${event.id}; staying queued.`);
    console.warn(error.message);
  }
}

function baselineMilestoneState({ report, season, latestCompletedWeek, queue }) {
  const clinched = [];
  const byeClinched = [];
  const eliminated = [];

  for (const team of report?.standings ?? []) {
    const id = String(team.rosterId);
    if (team.playoffOdds >= 0.9999) {
      clinched.push(id);
    }
    if ((team.byeOdds ?? 0) >= 0.9999) {
      byeClinched.push(id);
    }
    if (team.playoffOdds <= 0.0001) {
      eliminated.push(id);
    }
  }

  return {
    season,
    detectedThroughWeek: latestCompletedWeek,
    clinched,
    byeClinched,
    eliminated,
    queue: Array.isArray(queue) ? queue : [],
  };
}

async function deliverTradeNotification(analysis) {
  if (config.dryRun) {
    if (config.tradeNotificationMode === "image") {
      const imagePath = await renderTradeCardForDelivery(
        analysis,
        `trade ${analysis.tradeId}`
      );
      console.log(`[Dry Run] Trade card rendered to ${imagePath}`);
    } else {
      console.log(`[Dry Run] ${analysis.textMessage}`);
    }

    if (config.roastMode && analysis.roastText) {
      console.log(`[Dry Run] ${analysis.roastText}`);
    }
    return true;
  }

  try {
    if (config.tradeNotificationMode === "image") {
      await sendTradeCardMessage(
        analysis,
        `trade card for trade ${analysis.tradeId}`
      );
    } else {
      await sendChatMessage(
        analysis.textMessage,
        `trade text for trade ${analysis.tradeId}`
      );
    }
  } catch (error) {
    console.warn(
      `Trade ${config.tradeNotificationMode} delivery failed for trade ${analysis.tradeId}.`
    );
    console.warn(error.message);
    return false;
  }

  if (config.roastMode && analysis.roastText) {
    try {
      await sendChatMessage(
        analysis.roastText,
        `roast follow-up for trade ${analysis.tradeId}`
      );
    } catch (error) {
      console.warn(`Roast follow-up failed for trade ${analysis.tradeId}.`);
      console.warn(error.message);
    }
  }

  return true;
}

async function flushQueuedTradeNotifications(state) {
  if (!Array.isArray(state.queuedTradeNotifications)) {
    state.queuedTradeNotifications = [];
  }

  const dueNotifications = state.queuedTradeNotifications
    .filter(
      (notification) =>
        Number.isFinite(notification.releaseAtTimestampMs) &&
        notification.releaseAtTimestampMs <= Date.now()
    )
    .sort(compareQueuedTradeNotifications);

  if (dueNotifications.length === 0) {
    return;
  }

  if (dueNotifications.length > 1) {
    console.log(
      `${dueNotifications.length} queued trade notification(s) are due for ${formatTradePrimeTimeLabel(
        config.tradePrimeTimeSendHourEt
      )}; sending one this cycle, the rest will follow on later cycles.`
    );
  }

  // Send at most one queued trade per poll cycle. Multiple trades accepted the
  // same day all release at the same prime-time slot, so without this they'd
  // fire back-to-back in a tight loop — which both looks like spam and risks
  // Snapchat's UI dropping a send when the textbox hasn't settled from the last
  // one (the same issue we hit testing milestone alerts).
  const [notification] = dueNotifications;
  try {
    const delivered = await deliverTradeNotification(notification.analysis);
    if (!delivered) {
      console.warn(
        `Queued trade ${notification.transactionId} will stay pending because delivery failed.`
      );
      return;
    }

    state.sentTransactionIds.add(notification.transactionId);
    removeQueuedTradeNotification(state, notification.transactionId);
    await saveState(state);
    console.log(`Queued trade ${notification.transactionId} recorded as sent.`);
  } catch (error) {
    console.error(
      `Unable to deliver queued trade ${notification.transactionId}.`
    );
    console.error(error);
  }
}

async function processQueuedManualTestTrade() {
  let payload = null;

  try {
    const fileContents = await fs.readFile(MANUAL_TEST_TRIGGER_FILE, "utf8");
    payload = parseJsonFile(fileContents);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }

    throw error;
  }

  const tradeMessage = String(payload?.tradeMessage ?? "").trim();
  const roastMessage = String(payload?.roastMessage ?? "").trim();
  const tradeCardAnalysis = isTradeCardAnalysis(payload?.tradeCardAnalysis)
    ? payload.tradeCardAnalysis
    : null;
  const shouldSendRoast = Boolean(payload?.sendRoast) && roastMessage;
  const targetChatId = resolveNotificationChatId("test");

  if (!tradeMessage) {
    console.warn("Manual test trade trigger was empty. Removing it.");
    await fs.unlink(MANUAL_TEST_TRIGGER_FILE).catch(() => {});
    return;
  }

  try {
    if (config.dryRun) {
      if (config.tradeNotificationMode === "image" && tradeCardAnalysis) {
        const imagePath = await renderTradeCardForDelivery(
          tradeCardAnalysis,
          "manual test trade"
        );
        console.log(`[Dry Run] Queued manual test trade card: ${imagePath}`);
      } else {
        if (config.tradeNotificationMode === "image") {
          console.warn(
            "Manual test trade did not include trade card data. Falling back to text preview."
          );
        }
        console.log(`[Dry Run] Queued manual test trade:\n${tradeMessage}`);
      }

      if (shouldSendRoast) {
        console.log(`[Dry Run] Queued manual test roast:\n${roastMessage}`);
      }
    } else {
      if (config.tradeNotificationMode === "image" && tradeCardAnalysis) {
        await sendTradeCardMessage(tradeCardAnalysis, "manual test trade card", {
          chatId: targetChatId,
        });
      } else {
        if (config.tradeNotificationMode === "image") {
          console.warn(
            "Manual test trade did not include trade card data. Falling back to text delivery."
          );
        }
        await sendChatMessage(tradeMessage, "manual test trade message", {
          chatId: targetChatId,
        });
      }

      // A roast failure here must not re-queue the whole trigger: the trade
      // message/card above already sent, and retrying would resend it.
      if (shouldSendRoast) {
        try {
          await sendChatMessage(roastMessage, "manual test roast message", {
            chatId: targetChatId,
          });
        } catch (error) {
          console.warn("Manual test roast message failed.");
          console.warn(error.message);
        }
      }
    }

    await fs.unlink(MANUAL_TEST_TRIGGER_FILE).catch(() => {});
  } catch (error) {
    console.warn(
      "Queued manual test trade send failed. Leaving it queued for retry."
    );
    console.warn(error.message);
  }
}

async function sendChatMessage(message, label, { chatId } = {}) {
  const targetChatId = chatId || resolveNotificationChatId("live");
  await ensureSnapchatSessionReady();
  await bot.openMessagingHome();
  await bot.sendMessage({
    chat: targetChatId,
    message,
    exit: false,
  });
  console.log(`Sent ${label} to ${describeNotificationChat(targetChatId)}.`);
}

async function sendTradeCardMessage(analysis, label, { chatId } = {}) {
  const targetChatId = chatId || resolveNotificationChatId("live");
  const imagePath = await renderTradeCardForDelivery(analysis, label);
  await ensureSnapchatSessionReady();
  await bot.sendTradeCard({ chatId: targetChatId, imagePath });
  console.log(`Sent ${label} to ${describeNotificationChat(targetChatId)}.`);
}

async function renderTradeCardForDelivery(analysis, label) {
  const imagePath = await renderTradeCardImage({
    analysis,
    stateDir: STATE_DIR,
    logger: console,
  });
  console.log(`Rendered ${label} to ${imagePath}.`);
  return imagePath;
}

async function fetchCompleteTrades() {
  const rounds = buildRoundsToScan();
  const transactionsByRound = await Promise.all(
    rounds.map((round) =>
      fetchJson(
        `https://api.sleeper.app/v1/league/${config.sleeperLeagueId}/transactions/${round}`
      ).catch((error) => {
        console.warn(`Failed to fetch round ${round} transactions.`);
        console.warn(error.message);
        return [];
      })
    )
  );

  const allTransactions = transactionsByRound.flat();
  const trades = allTransactions.filter(
    (transaction) =>
      transaction?.type === "trade" && transaction?.status === "complete"
  );

  const uniqueTrades = dedupeByTransactionId(trades);
  uniqueTrades.sort((left, right) => {
    const leftUpdated = Number(left.status_updated ?? left.created ?? 0);
    const rightUpdated = Number(right.status_updated ?? right.created ?? 0);
    return leftUpdated - rightUpdated;
  });

  return uniqueTrades;
}

function buildTradeAnalysis(
  trade,
  {
    allTrades,
    league,
    playersById,
    rosterLookup,
    userLookup,
    valueBook,
    totalRosters,
  }
) {
  const ledger = buildTradeLedger(trade, {
    playersById,
    rosterLookup,
    userLookup,
    valueBook,
    totalRosters,
  });

  const rosterIds = Array.from(
    new Set([
      ...Object.keys(ledger),
      ...(trade.roster_ids ?? []).map((rosterId) => String(rosterId)),
    ])
  );

  const teams = rosterIds.map((rosterId) => {
    const sentAssets = sortAssets(ledger[rosterId]?.sent ?? []);
    const receivedAssets = sortAssets(ledger[rosterId]?.received ?? []);
    const sentValue = sumKnownAssetValues(sentAssets);
    const receivedValue = sumKnownAssetValues(receivedAssets);
    const unknownAssetCount =
      countUnknownValueAssets(sentAssets) + countUnknownValueAssets(receivedAssets);
    const knownValueCount =
      countKnownValueAssets(sentAssets) + countKnownValueAssets(receivedAssets);
    const netValue = receivedValue - sentValue;
    const gradeData = buildTradeGrade({
      sentValue,
      receivedValue,
      knownValueCount,
    });

    return {
      rosterId,
      label: formatRosterLabel(rosterId, rosterLookup, userLookup),
      sentAssets,
      receivedAssets,
      sentValue,
      receivedValue,
      netValue,
      unknownAssetCount,
      knownValueCount,
      grade: gradeData.grade,
      gradeFlavor: gradeData.gradeFlavor,
      gradeScore: gradeData.score,
    };
  });

  const verdict = buildVerdict(teams, valueBook);
  const teamsWithWinnerFlag = teams.map((team) => ({
    ...team,
    isWinner: verdict.winnerRosterIds.has(team.rosterId),
    subtitle: buildTeamSubtitle(team),
  }));

  const acceptedAtLabel = `Accepted ${formatTimestamp(
    trade.status_updated ?? trade.created
  )}`;
  const historyContext = buildTradeHistoryContext(
    allTrades,
    trade,
    rosterLookup,
    userLookup
  );
  const textMessage = formatTradeTextMessage({
    historyContext,
    teams: teamsWithWinnerFlag,
  });

  return {
    tradeId: String(trade.transaction_id),
    headlineLabel: "TRADE ALERT",
    leagueName: league?.name?.trim() || "Dynasty League",
    acceptedAtLabel,
    valueSourceLabel: valueBook?.source ?? "",
    valueSourceDateLabel: valueBook?.sourceDate
      ? formatSourceDate(valueBook.sourceDate)
      : "",
    verdictSourceLabel: "Best Value",
    historyContext,
    roastText: verdict.roastText,
    teams: teamsWithWinnerFlag,
    textMessage,
  };
}

function buildTradeLedger(
  trade,
  { playersById, rosterLookup, userLookup, valueBook, totalRosters }
) {
  const ledger = {};
  const rosterIds = (trade.roster_ids ?? []).map((rosterId) => String(rosterId));
  const adds = trade.adds ?? {};
  const drops = trade.drops ?? {};

  for (const rosterId of rosterIds) {
    ensureLedgerEntry(ledger, rosterId);
  }

  for (const [playerId, receiverRosterId] of Object.entries(adds)) {
    const resolvedReceiverRosterId = String(receiverRosterId);
    const senderRosterId =
      drops[playerId] != null
        ? String(drops[playerId])
        : inferSenderRosterId(rosterIds, resolvedReceiverRosterId);

    if (!senderRosterId) {
      continue;
    }

    const asset = buildPlayerAsset(playerId, playersById[playerId], valueBook);
    ensureLedgerEntry(ledger, senderRosterId).sent.push(asset);
    ensureLedgerEntry(ledger, resolvedReceiverRosterId).received.push(asset);
  }

  for (const pick of trade.draft_picks ?? []) {
    const senderRosterId = String(
      pick.previous_owner_id ?? pick.roster_id ?? ""
    );
    const receiverRosterId = String(pick.owner_id ?? "");

    if (!senderRosterId || !receiverRosterId) {
      continue;
    }

    const asset = buildPickAsset(pick, valueBook, totalRosters, rosterLookup, userLookup);
    ensureLedgerEntry(ledger, senderRosterId).sent.push(asset);
    ensureLedgerEntry(ledger, receiverRosterId).received.push(asset);
  }

  for (const transfer of trade.waiver_budget ?? []) {
    const senderRosterId = String(transfer.sender ?? "");
    const receiverRosterId = String(transfer.receiver ?? "");

    if (!senderRosterId || !receiverRosterId) {
      continue;
    }

    const asset = buildFaabAsset(transfer);
    ensureLedgerEntry(ledger, senderRosterId).sent.push(asset);
    ensureLedgerEntry(ledger, receiverRosterId).received.push(asset);
  }

  return ledger;
}

function buildPlayerAsset(playerId, player, valueBook) {
  const title =
    player?.full_name ||
    [player?.first_name, player?.last_name].filter(Boolean).join(" ") ||
    `Player ${playerId}`;
  const meta = [player?.position, player?.team].filter(Boolean).join(" - ") || "Player";

  return {
    id: `player-${playerId}`,
    type: "player",
    playerId,
    position: player?.position ?? null,
    title,
    meta,
    textLine: meta ? `${title} (${meta})` : title,
    value: valueBook?.getPlayerValue(player) ?? null,
  };
}

function buildPickAsset(
  pick,
  valueBook,
  totalRosters,
  rosterLookup,
  userLookup
) {
  const title = `${pick.season} ${formatOrdinal(pick.round)}`;
  const originalOwnerLabel = pick.roster_id
    ? formatRosterLabel(String(pick.roster_id), rosterLookup, userLookup)
    : null;
  const meta = originalOwnerLabel
    ? `Draft pick | ${originalOwnerLabel}`
    : "Draft pick";

  return {
    id: `pick-${pick.season}-${pick.round}-${pick.owner_id}-${pick.previous_owner_id}`,
    type: "pick",
    title,
    meta,
    textLine: title,
    value:
      valueBook?.getPickValue({
        season: pick.season,
        round: pick.round,
        totalRosters,
      }) ?? null,
  };
}

function buildFaabAsset(transfer) {
  const title = `$${transfer.amount} FAAB`;

  return {
    id: `faab-${transfer.sender}-${transfer.receiver}-${transfer.amount}`,
    type: "faab",
    title,
    meta: "Waiver budget",
    textLine: title,
    value: null,
  };
}

function buildTradeGrade({ sentValue, receivedValue, knownValueCount }) {
  if (!knownValueCount) {
    return {
      grade: "N/A",
      gradeFlavor: "neutral",
      score: 0,
    };
  }

  const baseline = Math.max((sentValue + receivedValue) / 2, 1);
  const score = (receivedValue - sentValue) / baseline;

  if (score >= 0.7) {
    return { grade: "A+", gradeFlavor: "elite", score };
  }
  if (score >= 0.45) {
    return { grade: "A", gradeFlavor: "elite", score };
  }
  if (score >= 0.25) {
    return { grade: "A-", gradeFlavor: "elite", score };
  }
  if (score >= 0.12) {
    return { grade: "B+", gradeFlavor: "good", score };
  }
  if (score >= 0.05) {
    return { grade: "B", gradeFlavor: "good", score };
  }
  if (score >= -0.05) {
    return { grade: "C", gradeFlavor: "neutral", score };
  }
  if (score >= -0.12) {
    return { grade: "C-", gradeFlavor: "neutral", score };
  }
  if (score >= -0.25) {
    return { grade: "D", gradeFlavor: "bad", score };
  }

  return { grade: "F", gradeFlavor: "bad", score };
}

function buildVerdict(teams, valueBook) {
  const anyUnknownValues = teams.some((team) => team.unknownAssetCount > 0);
  const gradedTeams = teams
    .filter((team) => team.knownValueCount > 0)
    .sort((left, right) => right.netValue - left.netValue);

  if (!valueBook || gradedTeams.length === 0) {
    return {
      roastText: null,
      winnerRosterIds: new Set(),
    };
  }

  const winner = gradedTeams[0];
  const runnerUp = gradedTeams[1] ?? null;
  const winnerRosterIds = new Set();

  const hasClearWinner =
    winner.netValue > VERDICT_EPSILON &&
    (!runnerUp || winner.netValue - runnerUp.netValue > VERDICT_EPSILON);

  if (!hasClearWinner) {
    return {
      roastText: null,
      winnerRosterIds,
    };
  }

  winnerRosterIds.add(winner.rosterId);

  return {
    roastText: buildRoastText(teams, winner, anyUnknownValues),
    winnerRosterIds,
  };
}

function buildRoastText(teams, winner, anyUnknownValues) {
  if (
    !config.roastMode ||
    anyUnknownValues ||
    teams.length !== 2 ||
    winner.netValue < config.roastThreshold
  ) {
    return null;
  }

  const loser = teams.find((team) => team.rosterId !== winner.rosterId);
  if (!loser) {
    return null;
  }

  const severity =
    winner.netValue >= config.roastThreshold * 4
      ? "severe"
      : winner.netValue >= config.roastThreshold * 2
      ? "medium"
      : "mild";

  return getRoastForSeverity({
    severity,
    winner: winner.label,
    loser: loser.label,
    seed: `${winner.rosterId}:${loser.rosterId}:${winner.netValue}`,
    logger: console,
  });
}

function buildTeamSubtitle(team) {
  if (!team.knownValueCount) {
    return team.unknownAssetCount
      ? `${team.unknownAssetCount} asset${team.unknownAssetCount === 1 ? "" : "s"} ungraded`
      : "No graded assets in this trade";
  }

  const netLabel = team.unknownAssetCount ? "Known net" : "Net";
  const pieces = [
    `${team.unknownAssetCount ? "Known sent" : "Sent"} ${formatValue(team.sentValue)}`,
    `${team.unknownAssetCount ? "Known received" : "Received"} ${formatValue(
      team.receivedValue
    )}`,
    `${netLabel} ${formatSignedValue(team.netValue)}`,
  ];

  if (team.unknownAssetCount) {
    pieces.push(
      `${team.unknownAssetCount} ungraded asset${team.unknownAssetCount === 1 ? "" : "s"}`
    );
  }

  return pieces.join(" | ");
}

function formatTradeTextMessage({ historyContext, teams }) {
  const sections = ["A trade has been completed"];

  if (historyContext?.seasonTradeNumber) {
    sections.push(
      `This is the ${formatOrdinal(historyContext.seasonTradeNumber)} trade of the season.`
    );
  }

  if (historyContext?.rivalryTradeNumber && historyContext?.rivalryLabel) {
    sections.push(
      `This is the ${formatOrdinal(historyContext.rivalryTradeNumber)} time ${historyContext.rivalryLabel} have traded.`
    );
  }

  for (const team of teams) {
    const assetLines =
      team.sentAssets.length > 0
        ? team.sentAssets.map((asset) => asset.textLine).join("\n")
        : "No tracked assets";

    let section = `${team.label} has sent:\n${assetLines}`;
    section += `\n\nGrade: ${team.grade}`;

    sections.push(section);
  }

  return sections.join("\n\n");
}

function buildTradeHistoryContext(allTrades, currentTrade, rosterLookup, userLookup) {
  const currentTradeId = String(currentTrade.transaction_id);
  const currentTradeIndex = allTrades.findIndex(
    (trade) => String(trade.transaction_id) === currentTradeId
  );
  const seasonTradeNumber =
    currentTradeIndex >= 0 ? currentTradeIndex + 1 : allTrades.length + 1;
  const rosterIds = getTradeRosterIds(currentTrade);

  if (rosterIds.length !== 2) {
    return {
      seasonTradeNumber,
      rivalryTradeNumber: null,
      rivalryLabel: null,
    };
  }

  const rivalryPairKey = buildRivalryPairKey(rosterIds);
  const comparisonTrades = allTrades.slice(
    0,
    currentTradeIndex >= 0 ? currentTradeIndex + 1 : allTrades.length
  );
  const rivalryTradeNumber = comparisonTrades.filter((trade) => {
    const tradeRosterIds = getTradeRosterIds(trade);
    return (
      tradeRosterIds.length === 2 &&
      buildRivalryPairKey(tradeRosterIds) === rivalryPairKey
    );
  }).length;

  return {
    seasonTradeNumber,
    rivalryTradeNumber,
    rivalryLabel: rosterIds
      .map((rosterId) => formatRosterLabel(rosterId, rosterLookup, userLookup))
      .join(" and "),
  };
}

async function saveTradeHistoryLog(trades, rosterLookup, userLookup) {
  await fs.mkdir(STATE_DIR, { recursive: true });

  const entries = trades.map((trade) => {
    const rosterIds = getTradeRosterIds(trade);
    const historyContext = buildTradeHistoryContext(
      trades,
      trade,
      rosterLookup,
      userLookup
    );

    return {
      transactionId: String(trade.transaction_id),
      acceptedAt: formatTimestamp(trade.status_updated ?? trade.created),
      seasonTradeNumber: historyContext.seasonTradeNumber,
      rivalryTradeNumber: historyContext.rivalryTradeNumber,
      rivalryLabel: historyContext.rivalryLabel,
      rosterIds,
      teams: rosterIds.map((rosterId) =>
        formatRosterLabel(rosterId, rosterLookup, userLookup)
      ),
    };
  });

  const serialized = {
    updatedAt: new Date().toISOString(),
    tradeCount: entries.length,
    trades: entries,
  };

  await fs.writeFile(
    TRADE_HISTORY_FILE,
    JSON.stringify(serialized, null, 2),
    "utf8"
  );
}

function getTradeRosterIds(trade) {
  return Array.from(
    new Set((trade?.roster_ids ?? []).map((rosterId) => String(rosterId)))
  );
}

function buildRivalryPairKey(rosterIds) {
  return [...rosterIds].map(String).sort().join("::");
}

function ensureLedgerEntry(ledger, rosterId) {
  if (!ledger[rosterId]) {
    ledger[rosterId] = {
      sent: [],
      received: [],
    };
  }

  return ledger[rosterId];
}

function inferSenderRosterId(rosterIds, receiverRosterId) {
  if (rosterIds.length !== 2) {
    return null;
  }

  return rosterIds.find((rosterId) => rosterId !== receiverRosterId) ?? null;
}

function formatRosterLabel(rosterId, rosterLookup, userLookup) {
  const roster = rosterLookup.get(String(rosterId));
  const owner = roster ? userLookup.get(String(roster.owner_id)) : null;
  const teamName = owner?.metadata?.team_name?.trim();
  const displayName = owner?.display_name?.trim();

  if (teamName) {
    return teamName;
  }

  if (displayName) {
    return displayName;
  }

  return `Roster ${rosterId}`;
}

function buildRosterLookup(rosters) {
  return new Map(rosters.map((roster) => [String(roster.roster_id), roster]));
}

function buildUserLookup(users) {
  return new Map(users.map((user) => [String(user.user_id), user]));
}

function dedupeByTransactionId(trades) {
  const seen = new Set();
  const dedupedTrades = [];

  for (const trade of trades) {
    const transactionId = String(trade.transaction_id);
    if (seen.has(transactionId)) {
      continue;
    }

    seen.add(transactionId);
    dedupedTrades.push(trade);
  }

  return dedupedTrades;
}

async function loadPlayersById() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  const freshCachedPlayers = await readCachedPlayers(false);
  if (freshCachedPlayers) {
    return freshCachedPlayers;
  }

  try {
    console.log("Downloading Sleeper player index.");
    const playersById = await fetchJson("https://api.sleeper.app/v1/players/nfl");

    await fs.writeFile(
      PLAYERS_CACHE_FILE,
      JSON.stringify(
        {
          cachedAt: new Date().toISOString(),
          playersById,
        },
        null,
        2
      ),
      "utf8"
    );

    hasWarnedStalePlayerCache = false;
    return playersById;
  } catch (error) {
    const staleCachedPlayers = await readCachedPlayers(true);
    if (staleCachedPlayers) {
      if (!hasWarnedStalePlayerCache) {
        console.warn("Using stale Sleeper player cache because refresh failed.");
        console.warn(error.message);
        hasWarnedStalePlayerCache = true;
      }
      return staleCachedPlayers;
    }

    throw error;
  }
}

async function readCachedPlayers(acceptStale) {
  try {
    const fileContents = await fs.readFile(PLAYERS_CACHE_FILE, "utf8");
    const parsed = parseJsonFile(fileContents);
    const cachedAt = parsed?.cachedAt ? Date.parse(parsed.cachedAt) : 0;

    if (!acceptStale) {
      if (!cachedAt || Date.now() - cachedAt > PLAYERS_CACHE_TTL_MS) {
        return null;
      }
    }

    return parsed.playersById ?? null;
  } catch (error) {
    return null;
  }
}

async function loadState() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  try {
    const fileContents = await fs.readFile(STATE_FILE, "utf8");
    const parsed = parseJsonFile(fileContents);

    return {
      initialized: Boolean(parsed.initialized),
      initializedAt: parsed.initializedAt ?? null,
      sentTransactionIds: new Set(parsed.sentTransactionIds ?? []),
      queuedTradeNotifications: normalizeQueuedTradeNotifications(
        parsed.queuedTradeNotifications
      ),
    };
  } catch (error) {
    return {
      initialized: false,
      initializedAt: null,
      sentTransactionIds: new Set(),
      queuedTradeNotifications: [],
    };
  }
}

async function saveState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });

  const serialized = {
    initialized: state.initialized,
    initializedAt: state.initializedAt,
    sentTransactionIds: Array.from(state.sentTransactionIds).sort(),
    queuedTradeNotifications: [...(state.queuedTradeNotifications ?? [])].sort(
      compareQueuedTradeNotifications
    ),
  };

  await fs.writeFile(STATE_FILE, JSON.stringify(serialized, null, 2), "utf8");
}

async function loadWeeklyReportState() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  try {
    const fileContents = await fs.readFile(WEEKLY_REPORT_STATE_FILE, "utf8");
    const parsed = parseJsonFile(fileContents);

    return {
      sentBySeason: parsed?.sentBySeason ?? {},
    };
  } catch (error) {
    return {
      sentBySeason: {},
    };
  }
}

async function saveWeeklyReportState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });

  const serialized = {
    updatedAt: new Date().toISOString(),
    sentBySeason: state.sentBySeason ?? {},
  };

  await fs.writeFile(
    WEEKLY_REPORT_STATE_FILE,
    JSON.stringify(serialized, null, 2),
    "utf8"
  );
}

async function loadDivisionRivalryState() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  try {
    const fileContents = await fs.readFile(DIVISION_RIVALRY_STATE_FILE, "utf8");
    const parsed = parseJsonFile(fileContents);

    return {
      sentBySeason: parsed?.sentBySeason ?? {},
    };
  } catch (error) {
    return {
      sentBySeason: {},
    };
  }
}

async function saveDivisionRivalryState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });

  const serialized = {
    updatedAt: new Date().toISOString(),
    sentBySeason: state.sentBySeason ?? {},
  };

  await fs.writeFile(
    DIVISION_RIVALRY_STATE_FILE,
    JSON.stringify(serialized, null, 2),
    "utf8"
  );
}

async function loadBigMatchupsState() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  try {
    const fileContents = await fs.readFile(BIG_MATCHUPS_STATE_FILE, "utf8");
    const parsed = parseJsonFile(fileContents);

    return {
      sentBySeason: parsed?.sentBySeason ?? {},
    };
  } catch (error) {
    return {
      sentBySeason: {},
    };
  }
}

async function saveBigMatchupsState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });

  const serialized = {
    updatedAt: new Date().toISOString(),
    sentBySeason: state.sentBySeason ?? {},
  };

  await fs.writeFile(
    BIG_MATCHUPS_STATE_FILE,
    JSON.stringify(serialized, null, 2),
    "utf8"
  );
}

async function loadPowerRankingsState() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  try {
    const fileContents = await fs.readFile(POWER_RANKINGS_STATE_FILE, "utf8");
    const parsed = parseJsonFile(fileContents);

    return {
      sentBySeason: parsed?.sentBySeason ?? {},
      lastRanking: parsed?.lastRanking ?? null,
    };
  } catch (error) {
    return {
      sentBySeason: {},
      lastRanking: null,
    };
  }
}

async function savePowerRankingsState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });

  const serialized = {
    updatedAt: new Date().toISOString(),
    sentBySeason: state.sentBySeason ?? {},
    lastRanking: state.lastRanking ?? null,
  };

  await fs.writeFile(
    POWER_RANKINGS_STATE_FILE,
    JSON.stringify(serialized, null, 2),
    "utf8"
  );
}

async function loadMilestoneState() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  try {
    const fileContents = await fs.readFile(MILESTONE_STATE_FILE, "utf8");
    const parsed = parseJsonFile(fileContents);
    const base = createEmptyMilestoneState();

    return {
      season: parsed?.season ?? null,
      detectedThroughWeek: Number(parsed?.detectedThroughWeek) || 0,
      clinched: Array.isArray(parsed?.clinched) ? parsed.clinched.map(String) : [],
      byeClinched: Array.isArray(parsed?.byeClinched)
        ? parsed.byeClinched.map(String)
        : [],
      eliminated: Array.isArray(parsed?.eliminated)
        ? parsed.eliminated.map(String)
        : [],
      queue: Array.isArray(parsed?.queue) ? parsed.queue : base.queue,
    };
  } catch (error) {
    return createEmptyMilestoneState();
  }
}

async function saveMilestoneState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });

  const serialized = {
    updatedAt: new Date().toISOString(),
    season: state.season ?? null,
    detectedThroughWeek: Number(state.detectedThroughWeek) || 0,
    clinched: state.clinched ?? [],
    byeClinched: state.byeClinched ?? [],
    eliminated: state.eliminated ?? [],
    queue: state.queue ?? [],
  };

  await fs.writeFile(
    MILESTONE_STATE_FILE,
    JSON.stringify(serialized, null, 2),
    "utf8"
  );
}

async function loadRecordBook() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  try {
    const fileContents = await fs.readFile(RECORD_BOOK_FILE, "utf8");
    const parsed = parseJsonFile(fileContents);
    return { ...createEmptyRecordBook(), ...parsed };
  } catch (error) {
    return createEmptyRecordBook();
  }
}

async function saveRecordBook(book) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(RECORD_BOOK_FILE, JSON.stringify(book, null, 2), "utf8");
}

function hasSentWeeklyReport(state, season, week) {
  return Boolean(state?.sentBySeason?.[season]?.[String(week)]);
}

function markWeeklyReportSent(state, { season, week, leagueId }) {
  if (!state.sentBySeason) {
    state.sentBySeason = {};
  }

  if (!state.sentBySeason[season]) {
    state.sentBySeason[season] = {};
  }

  state.sentBySeason[season][String(week)] = {
    sentAt: new Date().toISOString(),
    leagueId,
  };
}

async function fetchJson(url) {
  let response = null;

  try {
    response = await fetch(url, {
      headers: {
        "user-agent": "tradebot-snapchat-bridge/1.0",
        accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

async function fetchMatchupsByWeek({ leagueId, startWeek, endWeek }) {
  const weeks = [];
  for (let week = startWeek; week <= endWeek; week += 1) {
    weeks.push(week);
  }

  const results = await Promise.all(
    weeks.map(async (week) => {
      try {
        const matchups = await fetchJson(
          `https://api.sleeper.app/v1/league/${leagueId}/matchups/${week}`
        );
        return [week, Array.isArray(matchups) ? matchups : []];
      } catch (error) {
        console.warn(`Failed to fetch Week ${week} matchups.`);
        console.warn(error.message);
        return [week, []];
      }
    })
  );

  return Object.fromEntries(results);
}

function buildRoundsToScan() {
  const rounds = [];

  for (
    let round = config.transactionStartRound;
    round <= config.transactionEndRound;
    round += 1
  ) {
    rounds.push(round);
  }

  return rounds;
}

function hasQueuedTradeNotification(state, transactionId) {
  return (state.queuedTradeNotifications ?? []).some(
    (notification) => notification.transactionId === transactionId
  );
}

function queueTradeNotification(
  state,
  { transactionId, acceptedAtTimestampMs, releaseAtTimestampMs, analysis }
) {
  if (!Array.isArray(state.queuedTradeNotifications)) {
    state.queuedTradeNotifications = [];
  }

  removeQueuedTradeNotification(state, transactionId);
  state.queuedTradeNotifications.push({
    transactionId,
    acceptedAtTimestampMs:
      Number.isFinite(acceptedAtTimestampMs) ? acceptedAtTimestampMs : null,
    releaseAtTimestampMs,
    queuedAt: new Date().toISOString(),
    analysis,
  });
  state.queuedTradeNotifications.sort(compareQueuedTradeNotifications);
}

function removeQueuedTradeNotification(state, transactionId) {
  state.queuedTradeNotifications = (state.queuedTradeNotifications ?? []).filter(
    (notification) => notification.transactionId !== transactionId
  );
}

function compareQueuedTradeNotifications(left, right) {
  const leftReleaseAt = Number(left?.releaseAtTimestampMs ?? 0);
  const rightReleaseAt = Number(right?.releaseAtTimestampMs ?? 0);
  if (leftReleaseAt !== rightReleaseAt) {
    return leftReleaseAt - rightReleaseAt;
  }

  const leftAcceptedAt = Number(left?.acceptedAtTimestampMs ?? 0);
  const rightAcceptedAt = Number(right?.acceptedAtTimestampMs ?? 0);
  if (leftAcceptedAt !== rightAcceptedAt) {
    return leftAcceptedAt - rightAcceptedAt;
  }

  return String(left?.transactionId ?? "").localeCompare(
    String(right?.transactionId ?? ""),
    "en-US"
  );
}

function normalizeQueuedTradeNotifications(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => ({
      transactionId: String(entry?.transactionId ?? "").trim(),
      acceptedAtTimestampMs: Number.isFinite(Number(entry?.acceptedAtTimestampMs))
        ? Number(entry.acceptedAtTimestampMs)
        : null,
      releaseAtTimestampMs: Number(entry?.releaseAtTimestampMs),
      queuedAt: entry?.queuedAt ?? null,
      analysis: entry?.analysis ?? null,
    }))
    .filter(
      (entry) =>
        entry.transactionId &&
        Number.isFinite(entry.releaseAtTimestampMs) &&
        entry.analysis &&
        typeof entry.analysis === "object"
    )
    .sort(compareQueuedTradeNotifications);
}

function getTradeAcceptedTimestampMs(trade) {
  const timestamp = Number(trade?.status_updated ?? trade?.created ?? NaN);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function resolveTradeNotificationReleaseAtTimestampMs(trade) {
  const acceptedAtTimestampMs = getTradeAcceptedTimestampMs(trade);
  if (!Number.isFinite(acceptedAtTimestampMs)) {
    return null;
  }

  const easternParts = getEasternDateParts(new Date(acceptedAtTimestampMs));
  if (easternParts.hour >= config.tradePrimeTimeSendHourEt) {
    return null;
  }

  return getEasternTimestampForLocalDateTime({
    year: easternParts.year,
    month: easternParts.month,
    day: easternParts.day,
    hour: config.tradePrimeTimeSendHourEt,
    minute: 0,
    second: 0,
  });
}

function getEasternDateParts(date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TIME_ZONE,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const getPart = (type) => parts.find((part) => part.type === type)?.value ?? "";

  return {
    weekday: getPart("weekday"),
    year: Number(getPart("year")),
    month: Number(getPart("month")),
    day: Number(getPart("day")),
    hour: Number(getPart("hour")),
    minute: Number(getPart("minute")),
    second: Number(getPart("second")),
  };
}

function getEasternTimestampForLocalDateTime({
  year,
  month,
  day,
  hour,
  minute = 0,
  second = 0,
}) {
  const noonUtcDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const offsetMinutes = getTimeZoneOffsetMinutes(noonUtcDate, EASTERN_TIME_ZONE);

  return (
    Date.UTC(year, month - 1, day, hour, minute, second) -
    offsetMinutes * 60 * 1000
  );
}

function getTimeZoneOffsetMinutes(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
  });
  const value =
    formatter.formatToParts(date).find((part) => part.type === "timeZoneName")
      ?.value ?? "GMT";
  const match = value.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!match) {
    return 0;
  }

  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  return sign * (hours * 60 + minutes);
}

function formatTradePrimeTimeLabel(hour24) {
  const normalizedHour = ((Number(hour24) % 24) + 24) % 24;
  const hour12 = normalizedHour % 12 || 12;
  const meridiem = normalizedHour >= 12 ? "PM" : "AM";
  return `${hour12}:00 ${meridiem} ET`;
}

function resolveNotificationChatId(audience) {
  if (audience === "test") {
    if (config.testSnapchatGroupChatId) {
      return config.testSnapchatGroupChatId;
    }

    console.warn(
      "TEST_SNAPCHAT_GROUP_CHAT_ID is not set. Falling back to SNAPCHAT_GROUP_CHAT_ID for this test send."
    );
  }

  return config.snapchatGroupChatId;
}

function describeNotificationChat(chatId) {
  if (chatId === config.testSnapchatGroupChatId) {
    return "the test chat";
  }

  if (chatId === config.snapchatGroupChatId) {
    return "the main chat";
  }

  return `chat ${chatId}`;
}

function validateEnvironment() {
  const missingKeys = [];

  if (!credentials.username) {
    missingKeys.push("USER_NAME");
  }

  if (!credentials.password) {
    missingKeys.push("USER_PASSWORD");
  }

  if (!config.sleeperLeagueId) {
    missingKeys.push("SLEEPER_LEAGUE_ID");
  }

  if (!config.snapchatGroupChatId) {
    missingKeys.push("SNAPCHAT_GROUP_CHAT_ID");
  }

  if (missingKeys.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingKeys.join(", ")}`
    );
  }

  if (config.transactionEndRound < config.transactionStartRound) {
    throw new Error(
      "TRANSACTION_END_ROUND must be greater than or equal to TRANSACTION_START_ROUND."
    );
  }
}

async function shutdown() {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  try {
    if (bot.browser) {
      await bot.closeBrowser();
    }
  } catch (error) {
    console.warn("Unable to close the Snapchat browser cleanly.");
    console.warn(error.message);
  }
}

function sortAssets(assets) {
  return [...assets].sort((left, right) => {
    const leftValue = left.value ?? -1;
    const rightValue = right.value ?? -1;

    if (rightValue !== leftValue) {
      return rightValue - leftValue;
    }

    return left.title.localeCompare(right.title, "en-US");
  });
}

function sumKnownAssetValues(assets) {
  return assets.reduce((total, asset) => total + (asset.value ?? 0), 0);
}

function countKnownValueAssets(assets) {
  return assets.filter((asset) => asset.value != null).length;
}

function countUnknownValueAssets(assets) {
  return assets.filter((asset) => asset.value == null).length;
}

function formatTimestamp(value) {
  if (!value) {
    return "unknown time";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  }).format(new Date(Number(value)));
}

function formatSourceDate(value) {
  if (!value) {
    return "Unavailable";
  }

  const normalizedValue = /^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ? `${value}T12:00:00Z`
    : value;

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "America/New_York",
  }).format(new Date(normalizedValue));
}

function formatValue(value) {
  if (value == null || !Number.isFinite(value)) {
    return "N/A";
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(Math.round(value));
}

function formatSignedValue(value) {
  if (!Number.isFinite(value) || value === 0) {
    return "0";
  }

  return `${value > 0 ? "+" : "-"}${formatValue(Math.abs(value))}`;
}

function formatOrdinal(round) {
  const numericRound = Number(round);
  if (!Number.isFinite(numericRound)) {
    return `${round}`;
  }

  if (numericRound % 100 >= 11 && numericRound % 100 <= 13) {
    return `${numericRound}th`;
  }

  switch (numericRound % 10) {
    case 1:
      return `${numericRound}st`;
    case 2:
      return `${numericRound}nd`;
    case 3:
      return `${numericRound}rd`;
    default:
      return `${numericRound}th`;
  }
}

function isRecoverableSnapError(error) {
  const message = String(error?.message ?? "");

  return (
    message.includes("Target closed") ||
    message.includes("Session closed") ||
    message.includes("Execution context was destroyed") ||
    message.includes("detached Frame")
  );
}

function parseInteger(value, fallbackValue) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallbackValue;
}

function parseBoolean(value, fallbackValue) {
  if (value == null || value === "") {
    return fallbackValue;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseValueMode(value, fallbackValue) {
  const normalized = String(value ?? fallbackValue).trim().toLowerCase();
  if (normalized === "1qb" || normalized === "2qb" || normalized === "auto") {
    return normalized;
  }

  return fallbackValue;
}

function parseTradeNotificationMode(value, fallbackValue) {
  const normalized = String(value ?? fallbackValue).trim().toLowerCase();
  if (normalized === "text" || normalized === "image") {
    return normalized;
  }

  return fallbackValue;
}

function isTradeCardAnalysis(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.tradeId === "string" &&
      Array.isArray(value.teams)
  );
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function sleepWithManualTriggerChecks(totalMilliseconds) {
  const deadline = Date.now() + totalMilliseconds;

  while (Date.now() < deadline) {
    const remainingMilliseconds = deadline - Date.now();
    await delay(
      Math.min(MANUAL_TRIGGER_CHECK_INTERVAL_MS, remainingMilliseconds)
    );

    try {
      await processQueuedManualTestTrade();
    } catch (error) {
      console.warn("Manual test trade check failed during sleep.");
      console.warn(error.message);
    }
  }
}
