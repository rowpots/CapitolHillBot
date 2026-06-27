// Live in-game engagement — score snapshots and reactive alerts posted only
// inside NFL game windows. Built as a self-contained "feature module"
// ({ id, shouldRun, run }) so none of its orchestration lives in index.js: the
// main loop just passes a small ctx of shared services (fetchJson, sendMessage,
// loadPlayersById, dryRun, stateDir). All output is deterministic template text
// — no AI, no token cost.
//
// Like flushMilestones, this sends AT MOST ONE message per poll cycle (Snapchat
// drops back-to-back sends); any backlog of due snapshots/alerts trickles out
// one per cycle. Dedup is per (season, week): snapshots fire once per scheduled
// checkpoint, reactive alerts fire once per occurrence signature.

import fs from "fs/promises";
import path from "path";

import { parseJsonFile } from "./logging.js";
import { extractStarterPointsForRoster } from "./player-points.js";
import {
  fetchSchedule,
  getTeamState,
  isOnlyLastGameRemaining,
} from "./nfl-schedule.js";
import {
  buildRosterLookup,
  buildUserLookup,
  formatRosterLabel,
  getEasternDateParts,
  groupWeekEntriesByMatchup,
  normalizeWeekEntries,
  truncateLabel,
} from "./weekly-report.js";

const STATE_FILE_NAME = "live-scoring-state.json";
const TEAM_NAME_MAX_LENGTH = 18;
const SIGNATURE_RING_LIMIT = 200;

// Scheduled snapshot posts: each fires once per week, at/after the clock time on
// its weekday. Mirrors big-matchups' "at or after time, once" gate so we never
// depend on live game-finish detection. Times are Eastern.
const SNAPSHOT_CHECKPOINTS = [
  { id: "thu_night", weekday: "Thursday", hour: 23, minute: 30, label: "Thursday Night" },
  { id: "sun_early", weekday: "Sunday", hour: 16, minute: 30, label: "Early Games" },
  { id: "sun_afternoon", weekday: "Sunday", hour: 20, minute: 0, label: "Afternoon Games" },
  { id: "sun_night", weekday: "Sunday", hour: 23, minute: 30, label: "Sunday Night Wrap" },
  { id: "mon_night", weekday: "Monday", hour: 23, minute: 30, label: "Monday Night Wrap" },
];

// Reactive alerts only fire while games are actually being played. endHour is
// inclusive of the whole hour (23 => through 23:59).
const GAME_WINDOWS = [
  { weekday: "Thursday", startHour: 20, endHour: 23 },
  { weekday: "Sunday", startHour: 13, endHour: 23 },
  { weekday: "Monday", startHour: 20, endHour: 23 },
];

function parseBoolean(value, fallbackValue) {
  if (value == null || value === "") {
    return fallbackValue;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseNumber(value, fallbackValue) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallbackValue;
}

// Read just this subsystem's knobs from env so index.js stays lean. A single
// master switch (off by default — these post during live games and are noisier
// than the scheduled features) gates everything; sub-feature toggles default on
// once the master is enabled.
export function loadLiveScoringConfig(env = process.env) {
  const enabled = parseBoolean(env.LIVE_SCORING_ENABLED, false);
  return {
    enabled,
    snapshotsEnabled: enabled && parseBoolean(env.LIVE_SCORE_SNAPSHOTS_ENABLED, true),
    bigPerformanceEnabled: enabled && parseBoolean(env.LIVE_BIG_PERFORMANCE_ENABLED, true),
    nailbiterEnabled: enabled && parseBoolean(env.LIVE_NAILBITER_ENABLED, true),
    upsetEnabled: enabled && parseBoolean(env.LIVE_UPSET_ENABLED, true),
    // "Going into the last game (MNF/SNF), Team X needs Y with N to play." Needs
    // the ESPN schedule to know who hasn't played yet.
    lastGameAlertEnabled: enabled && parseBoolean(env.LIVE_LAST_GAME_ALERT_ENABLED, true),
    bigPerformanceThreshold: parseNumber(env.LIVE_BIG_PERFORMANCE_THRESHOLD, 35),
    nailbiterMargin: parseNumber(env.LIVE_NAILBITER_MARGIN, 5),
    // Below this combined score we assume too few players have played to judge a
    // nailbiter/upset, so we hold off (avoids "0.0 vs 0.0 nailbiter!").
    minCombinedForLateAlert: parseNumber(env.LIVE_MIN_COMBINED_FOR_ALERT, 120),
    // Don't fire the last-game alert when the deficit is so large no realistic
    // remaining slate could erase it — that's a decided game, not a "still alive".
    lastGameMaxDeficit: parseNumber(env.LIVE_LAST_GAME_MAX_DEFICIT, 30),
  };
}

export function isWithinGameWindow(parts) {
  return GAME_WINDOWS.some(
    (window) =>
      parts.weekday === window.weekday &&
      parts.hour >= window.startHour &&
      parts.hour <= window.endHour
  );
}

// "Late" enough that a margin is meaningful: Sunday evening, or the back end of
// a Thursday/Monday night window.
export function isLateGameWindow(parts) {
  if (parts.weekday === "Sunday") {
    return parts.hour >= 19;
  }
  if (parts.weekday === "Thursday" || parts.weekday === "Monday") {
    return parts.hour >= 22;
  }
  return false;
}

// Earliest same-weekday checkpoint that is now due and not yet sent.
export function dueSnapshotCheckpoint(parts, sentSnapshots = {}) {
  for (const checkpoint of SNAPSHOT_CHECKPOINTS) {
    if (checkpoint.weekday !== parts.weekday || sentSnapshots[checkpoint.id]) {
      continue;
    }
    const atOrAfter =
      parts.hour > checkpoint.hour ||
      (parts.hour === checkpoint.hour && parts.minute >= checkpoint.minute);
    if (atOrAfter) {
      return checkpoint;
    }
  }
  return null;
}

function resolvePlayerName(player, playerId) {
  return (
    player?.full_name ||
    [player?.first_name, player?.last_name].filter(Boolean).join(" ") ||
    `Player ${playerId}`
  );
}

function formatPoints(value) {
  return (Number(value) || 0).toFixed(1);
}

// Build {rosterId, label, points} for each team in the week, plus the matchup
// pairings, from raw Sleeper entries.
export function buildLiveTeams({ entries, rosterLookup, userLookup }) {
  const normalized = normalizeWeekEntries(entries);
  const teamsByRosterId = new Map();
  for (const entry of normalized) {
    teamsByRosterId.set(entry.rosterId, {
      rosterId: entry.rosterId,
      matchupId: entry.matchupId,
      points: entry.points,
      label: formatRosterLabel(entry.rosterId, rosterLookup, userLookup),
    });
  }
  return teamsByRosterId;
}

export function buildLivePairings(teamsByRosterId) {
  const entries = [...teamsByRosterId.values()].map((team) => ({
    rosterId: team.rosterId,
    matchupId: team.matchupId,
    points: team.points,
  }));
  const grouped = groupWeekEntriesByMatchup(entries);
  const pairings = [];
  for (const pair of grouped.values()) {
    if (pair.length !== 2) {
      continue;
    }
    const [a, b] = pair;
    const teamA = teamsByRosterId.get(a.rosterId);
    const teamB = teamsByRosterId.get(b.rosterId);
    if (!teamA || !teamB) {
      continue;
    }
    pairings.push({ teamA, teamB, margin: Math.abs(teamA.points - teamB.points) });
  }
  return pairings;
}

export function buildSnapshotMessage({ leagueName, week, checkpointLabel, pairings }) {
  if (!pairings.length) {
    return null;
  }

  const lines = pairings
    .slice()
    .sort((left, right) => left.margin - right.margin)
    .map(({ teamA, teamB }) => {
      const leading = teamA.points >= teamB.points ? teamA : teamB;
      const trailing = leading === teamA ? teamB : teamA;
      const leadLabel = truncateLabel(leading.label, TEAM_NAME_MAX_LENGTH);
      const trailLabel = truncateLabel(trailing.label, TEAM_NAME_MAX_LENGTH);
      return `${leadLabel} ${formatPoints(leading.points)} — ${formatPoints(
        trailing.points
      )} ${trailLabel}`;
    });

  const closest = pairings.reduce((best, current) =>
    current.margin < best.margin ? current : best
  );
  const topTeam = [...pairings.reduce((all, pairing) => {
    all.push(pairing.teamA, pairing.teamB);
    return all;
  }, [])].sort((left, right) => right.points - left.points)[0];

  const footerLines = [];
  if (topTeam) {
    footerLines.push(
      `🔥 Top score: ${truncateLabel(topTeam.label, TEAM_NAME_MAX_LENGTH)} (${formatPoints(
        topTeam.points
      )})`
    );
  }
  if (closest && Number.isFinite(closest.margin)) {
    footerLines.push(
      `😬 Closest: ${truncateLabel(closest.teamA.label, TEAM_NAME_MAX_LENGTH)} vs ${truncateLabel(
        closest.teamB.label,
        TEAM_NAME_MAX_LENGTH
      )} (${formatPoints(closest.margin)} apart)`
    );
  }

  const header = `🏟️ ${leagueName} Week ${week} — ${checkpointLabel}`;
  const divider = "—".repeat(Math.max(18, header.length - 12));
  return [header, divider, "", lines.join("\n"), "", footerLines.join("\n")]
    .join("\n")
    .trimEnd();
}

// Starters scoring at/above the threshold this week, across all teams.
export function findBigPerformances({ entries, week, teamsByRosterId, playersById, threshold }) {
  const matchupsByWeek = { [week]: entries };
  const performances = [];
  for (const team of teamsByRosterId.values()) {
    const starters = extractStarterPointsForRoster(matchupsByWeek, week, team.rosterId);
    for (const { playerId, points } of starters) {
      if (points >= threshold) {
        performances.push({
          rosterId: team.rosterId,
          teamLabel: team.label,
          playerId,
          points,
          playerName: resolvePlayerName(playersById?.[playerId], playerId),
        });
      }
    }
  }
  return performances.sort((left, right) => right.points - left.points);
}

export function buildBigPerformanceAlert(performance) {
  const { playerName, teamLabel, points, playerId, rosterId } = performance;
  return {
    signature: `bigperf:${rosterId}:${playerId}:${Math.floor(points)}`,
    message: `🔥 ${playerName} just dropped ${formatPoints(points)} for ${truncateLabel(
      teamLabel,
      TEAM_NAME_MAX_LENGTH
    )}!`,
  };
}

export function buildNailbiterAlerts({ pairings, margin, minCombined }) {
  return pairings
    .filter(
      (pairing) =>
        pairing.teamA.points + pairing.teamB.points >= minCombined &&
        pairing.margin <= margin
    )
    .sort((left, right) => left.margin - right.margin)
    .map(({ teamA, teamB, margin: gap }) => {
      const leading = teamA.points >= teamB.points ? teamA : teamB;
      const trailing = leading === teamA ? teamB : teamA;
      return {
        signature: `nailbiter:${[teamA.rosterId, teamB.rosterId].sort().join("-")}`,
        message: `😬 Nailbiter! ${truncateLabel(
          leading.label,
          TEAM_NAME_MAX_LENGTH
        )} ${formatPoints(leading.points)} — ${formatPoints(
          trailing.points
        )} ${truncateLabel(trailing.label, TEAM_NAME_MAX_LENGTH)} (${formatPoints(
          gap
        )} apart, too close to call)`,
      };
    });
}

// Upset = the team currently LEADING has the worse season record (fewer wins)
// than the team it's beating. Uses roster settings (no Monte Carlo needed).
export function buildUpsetAlerts({ pairings, recordByRosterId, minCombined }) {
  const alerts = [];
  for (const { teamA, teamB } of pairings) {
    if (teamA.points + teamB.points < minCombined) {
      continue;
    }
    const leading = teamA.points >= teamB.points ? teamA : teamB;
    const trailing = leading === teamA ? teamB : teamA;
    const leadRecord = recordByRosterId.get(leading.rosterId);
    const trailRecord = recordByRosterId.get(trailing.rosterId);
    if (!leadRecord || !trailRecord) {
      continue;
    }
    // Underdog leading: fewer wins (and not a tie in wins) than the favorite.
    if (leadRecord.wins < trailRecord.wins) {
      alerts.push({
        signature: `upset:${[teamA.rosterId, teamB.rosterId].sort().join("-")}`,
        message: `🚨 Upset brewing: ${truncateLabel(
          leading.label,
          TEAM_NAME_MAX_LENGTH
        )} (${formatRecord(leadRecord)}) is leading ${truncateLabel(
          trailing.label,
          TEAM_NAME_MAX_LENGTH
        )} (${formatRecord(trailRecord)})!`,
      });
    }
  }
  return alerts;
}

function formatRecord(record) {
  return record.ties > 0
    ? `${record.wins}-${record.losses}-${record.ties}`
    : `${record.wins}-${record.losses}`;
}

export function buildRecordByRosterId(rosters) {
  const map = new Map();
  for (const roster of rosters ?? []) {
    const settings = roster?.settings ?? {};
    map.set(String(roster.roster_id), {
      wins: Number(settings.wins) || 0,
      losses: Number(settings.losses) || 0,
      ties: Number(settings.ties) || 0,
    });
  }
  return map;
}

// Padding added to the deficit so the "needs" number is the points required to
// actually take the lead (exceed the margin), not just tie it.
const POINTS_NEEDED_EPSILON = 0.1;
const MAX_NAMED_PLAYERS = 2;

// Each roster's starters who are in an NFL game that is still pre/in (i.e. have
// points left to put up). Requires the ESPN schedule + the player index (for
// each starter's NFL team).
function buildRemainingByRosterId({ teamsByRosterId, entries, week, playersById, schedule }) {
  const matchupsByWeek = { [week]: entries };
  const remainingByRosterId = new Map();

  for (const team of teamsByRosterId.values()) {
    const starters = extractStarterPointsForRoster(matchupsByWeek, week, team.rosterId);
    const remaining = [];
    for (const { playerId } of starters) {
      const player = playersById?.[playerId];
      const nflTeam = player?.team;
      const state = nflTeam ? getTeamState(schedule, nflTeam) : null;
      if (state === "pre" || state === "in") {
        remaining.push({ playerId, name: resolvePlayerName(player, playerId) });
      }
    }
    remainingByRosterId.set(team.rosterId, remaining);
  }

  return remainingByRosterId;
}

function formatPlayerList(players) {
  const names = players.map((player) => player.name);
  if (names.length <= MAX_NAMED_PLAYERS) {
    return names.join(", ");
  }
  const shown = names.slice(0, MAX_NAMED_PLAYERS);
  return `${shown.join(", ")} +${names.length - MAX_NAMED_PLAYERS} more`;
}

// "Going into the last game" alerts: for each matchup where the only football
// left is the final slot, if the trailing team still has player(s) to play and
// the deficit is realistically catchable, say what they need. Caller must first
// confirm isOnlyLastGameRemaining(schedule).
export function buildLastGameAlerts({
  teamsByRosterId,
  pairings,
  entries,
  week,
  playersById,
  schedule,
  maxDeficit = 30,
}) {
  const remainingByRosterId = buildRemainingByRosterId({
    teamsByRosterId,
    entries,
    week,
    playersById,
    schedule,
  });

  const alerts = [];
  for (const { teamA, teamB } of pairings) {
    const lead = teamA.points >= teamB.points ? teamA : teamB;
    const trail = lead === teamA ? teamB : teamA;
    const margin = lead.points - trail.points;
    if (margin <= 0) {
      continue; // tied — no one is chasing
    }
    if (margin > maxDeficit) {
      continue; // effectively decided
    }

    const trailRemaining = remainingByRosterId.get(trail.rosterId) ?? [];
    if (trailRemaining.length === 0) {
      continue; // nothing left to play — the result is in
    }
    const leadRemaining = remainingByRosterId.get(lead.rosterId) ?? [];

    const needs = (margin + POINTS_NEEDED_EPSILON).toFixed(1);
    const playerWord = trailRemaining.length === 1 ? "player" : "players";
    let message =
      `🌙 Last game: ${truncateLabel(trail.label, TEAM_NAME_MAX_LENGTH)} needs ${needs} ` +
      `with ${trailRemaining.length} ${playerWord} left to play (${formatPlayerList(trailRemaining)}) ` +
      `to catch ${truncateLabel(lead.label, TEAM_NAME_MAX_LENGTH)} (down ${formatPoints(margin)}).`;
    if (leadRemaining.length > 0) {
      message += ` ${truncateLabel(lead.label, TEAM_NAME_MAX_LENGTH)} still has ${leadRemaining.length} to play.`;
    }

    alerts.push({ signature: `lastgame:${trail.rosterId}`, message });
  }

  return alerts;
}

// ---- state ----

async function loadState(stateDir) {
  await fs.mkdir(stateDir, { recursive: true });
  try {
    const fileContents = await fs.readFile(path.join(stateDir, STATE_FILE_NAME), "utf8");
    const parsed = parseJsonFile(fileContents);
    return {
      season: parsed?.season ?? null,
      week: parsed?.week ?? null,
      sentSnapshots: parsed?.sentSnapshots ?? {},
      firedSignatures: Array.isArray(parsed?.firedSignatures) ? parsed.firedSignatures : [],
    };
  } catch (error) {
    return { season: null, week: null, sentSnapshots: {}, firedSignatures: [] };
  }
}

async function saveState(stateDir, state) {
  await fs.mkdir(stateDir, { recursive: true });
  const serialized = {
    updatedAt: new Date().toISOString(),
    season: state.season ?? null,
    week: state.week ?? null,
    sentSnapshots: state.sentSnapshots ?? {},
    firedSignatures: (state.firedSignatures ?? []).slice(-SIGNATURE_RING_LIMIT),
  };
  await fs.writeFile(
    path.join(stateDir, STATE_FILE_NAME),
    JSON.stringify(serialized, null, 2),
    "utf8"
  );
}

function resetStateForWeek(state, season, week) {
  if (state.season !== season || state.week !== week) {
    state.season = season;
    state.week = week;
    state.sentSnapshots = {};
    state.firedSignatures = [];
  }
}

// Assemble every message that is currently due/eligible, in priority order. The
// caller sends only the first (one message per cycle).
export function collectDueMessages({ liveConfig, parts, state, context }) {
  const {
    leagueName,
    week,
    pairings,
    teamsByRosterId,
    entries,
    playersById,
    recordByRosterId,
    schedule,
  } = context;
  const due = [];
  const fired = new Set(state.firedSignatures);

  // 1. "Going into the last game" alerts — highest priority (this is the
  //    marquee moment). Only when the schedule says the final slot is all that's
  //    left and we have the player index to resolve who hasn't played.
  if (
    liveConfig.lastGameAlertEnabled &&
    schedule &&
    playersById &&
    isOnlyLastGameRemaining(schedule)
  ) {
    for (const alert of buildLastGameAlerts({
      teamsByRosterId,
      pairings,
      entries,
      week,
      playersById,
      schedule,
      maxDeficit: liveConfig.lastGameMaxDeficit,
    })) {
      if (!fired.has(alert.signature)) {
        due.push(alert);
      }
    }
  }

  // 2. Reactive alerts (time-sensitive). Big performances any time inside a
  //    game window; nailbiter/upset only late, when margins mean something.
  if (liveConfig.bigPerformanceEnabled && playersById) {
    for (const performance of findBigPerformances({
      entries,
      week,
      teamsByRosterId,
      playersById,
      threshold: liveConfig.bigPerformanceThreshold,
    })) {
      const alert = buildBigPerformanceAlert(performance);
      if (!fired.has(alert.signature)) {
        due.push(alert);
      }
    }
  }

  if (isLateGameWindow(parts)) {
    if (liveConfig.nailbiterEnabled) {
      for (const alert of buildNailbiterAlerts({
        pairings,
        margin: liveConfig.nailbiterMargin,
        minCombined: liveConfig.minCombinedForLateAlert,
      })) {
        if (!fired.has(alert.signature)) {
          due.push(alert);
        }
      }
    }
    if (liveConfig.upsetEnabled) {
      for (const alert of buildUpsetAlerts({
        pairings,
        recordByRosterId,
        minCombined: liveConfig.minCombinedForLateAlert,
      })) {
        if (!fired.has(alert.signature)) {
          due.push(alert);
        }
      }
    }
  }

  // 3. Scheduled snapshot (at most one due checkpoint).
  if (liveConfig.snapshotsEnabled) {
    const checkpoint = dueSnapshotCheckpoint(parts, state.sentSnapshots);
    if (checkpoint) {
      const message = buildSnapshotMessage({
        leagueName,
        week,
        checkpointLabel: checkpoint.label,
        pairings,
      });
      if (message) {
        due.push({ snapshotId: checkpoint.id, message });
      }
    }
  }

  return due;
}

export const liveScoringFeature = {
  id: "live-scoring",

  shouldRun(ctx) {
    const liveConfig = loadLiveScoringConfig();
    if (!liveConfig.enabled) {
      return false;
    }
    const parts = getEasternDateParts(ctx.now ?? new Date());
    return isWithinGameWindow(parts);
  },

  async run(ctx) {
    const liveConfig = loadLiveScoringConfig();
    const now = ctx.now ?? new Date();
    const parts = getEasternDateParts(now);

    const nflState = await ctx.fetchJson("https://api.sleeper.app/v1/state/nfl").catch(() => null);
    const week = Number(nflState?.week);
    const season = String(nflState?.season ?? "").trim();
    if (!season || !Number.isFinite(week) || week < 1) {
      return;
    }

    const leagueId = ctx.leagueId;
    const [league, entries, rosters, users] = await Promise.all([
      ctx.fetchJson(`https://api.sleeper.app/v1/league/${leagueId}`),
      ctx.fetchJson(`https://api.sleeper.app/v1/league/${leagueId}/matchups/${week}`),
      ctx.fetchJson(`https://api.sleeper.app/v1/league/${leagueId}/rosters`),
      ctx.fetchJson(`https://api.sleeper.app/v1/league/${leagueId}/users`),
    ]);

    const weekEntries = Array.isArray(entries) ? entries : [];
    if (weekEntries.length === 0) {
      return;
    }

    const rosterLookup = buildRosterLookup(rosters ?? []);
    const userLookup = buildUserLookup(users ?? []);
    const teamsByRosterId = buildLiveTeams({ entries: weekEntries, rosterLookup, userLookup });
    const pairings = buildLivePairings(teamsByRosterId);
    const recordByRosterId = buildRecordByRosterId(rosters ?? []);
    const leagueName = String(league?.name ?? "League").trim() || "League";

    // Pull the ESPN schedule only when a "last game" alert could actually fire:
    // Monday's whole window (to catch the pre-MNF "going into the last game"
    // moment) or any late window (rare SNF-is-last weeks). isOnlyLastGameRemaining
    // then gates the actual alert.
    let schedule = null;
    if (
      liveConfig.lastGameAlertEnabled &&
      (parts.weekday === "Monday" || isLateGameWindow(parts))
    ) {
      schedule = await fetchSchedule({ fetchJson: ctx.fetchJson, season, week }).catch((error) => {
        ctx.logger.warn(`live-scoring: ESPN schedule fetch failed (${error.message}).`);
        return null;
      });
    }
    const lastGameReady =
      liveConfig.lastGameAlertEnabled && schedule && isOnlyLastGameRemaining(schedule);

    // Only pay for the (large) player index when something actually needs it —
    // a starter already over the big-performance threshold, or a live last-game
    // situation that names the remaining players.
    let playersById = null;
    const needPlayersForBigPerf =
      liveConfig.bigPerformanceEnabled &&
      hasAnyStarterOverThreshold(weekEntries, liveConfig.bigPerformanceThreshold);
    if (needPlayersForBigPerf || lastGameReady) {
      playersById = await ctx.loadPlayersById().catch(() => null);
    }

    const state = await loadState(ctx.stateDir);
    resetStateForWeek(state, season, week);

    const due = collectDueMessages({
      liveConfig,
      parts,
      state,
      context: {
        leagueName,
        week,
        pairings,
        teamsByRosterId,
        schedule,
        entries: weekEntries,
        playersById,
        recordByRosterId,
      },
    });

    if (due.length === 0) {
      return;
    }

    // One message per cycle (Snapchat drops back-to-back sends); the rest are
    // re-collected and trickle out on subsequent cycles.
    const next = due[0];

    if (ctx.dryRun) {
      ctx.logger.log(`[Dry Run] [live-scoring] ${next.message}`);
      return;
    }

    await ctx.sendMessage(next.message, `live scoring (${next.snapshotId ?? next.signature})`);

    if (next.snapshotId) {
      state.sentSnapshots[next.snapshotId] = true;
    } else if (next.signature) {
      state.firedSignatures.push(next.signature);
    }
    await saveState(ctx.stateDir, state);
  },
};

function hasAnyStarterOverThreshold(entries, threshold) {
  for (const entry of entries) {
    const playersPoints = entry?.players_points ?? {};
    for (const playerId of entry?.starters ?? []) {
      if (String(playerId) !== "0" && Number(playersPoints[playerId]) >= threshold) {
        return true;
      }
    }
  }
  return false;
}
