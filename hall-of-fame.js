import { findPlacementEntry, isWeekScored } from "./playoffs.js";
import {
  buildUserLookup,
  DEFAULT_TEAM_NAME_MAX_LENGTH,
  formatOneDecimal,
  groupWeekEntriesByMatchup,
  normalizeWeekEntries,
  STANDINGS_DIVIDER,
  truncateLabel,
} from "./weekly-report.js";

export function createEmptyHallOfFame() {
  return {
    seededFromHistory: false,
    seededAt: null,
    lastMergedSeason: null,
    careerStatsByUserId: {},
  };
}

function ensureCareerEntry(hallOfFame, userId) {
  if (!hallOfFame.careerStatsByUserId[userId]) {
    hallOfFame.careerStatsByUserId[userId] = {
      wins: 0,
      losses: 0,
      ties: 0,
      pointsFor: 0,
      championships: 0,
      runnerUps: 0,
      playoffAppearances: 0,
      seasonsPlayed: 0,
    };
  }
  return hallOfFame.careerStatsByUserId[userId];
}

// Any roster appearing as a *direct* (non-placeholder) t1/t2 value anywhere
// in winners_bracket genuinely played a playoff game that season -- either
// entering Round 1, or entering Round 2 directly via a bye. Simpler and
// equally correct vs. reusing playoffs.js's round-specific helpers, which are
// file-private there anyway.
function collectPlayoffRosterIds(winnersBracket) {
  const rosterIds = new Set();
  for (const entry of winnersBracket ?? []) {
    for (const side of ["t1", "t2"]) {
      const rosterId = entry?.[side];
      if (rosterId != null) {
        rosterIds.add(String(rosterId));
      }
    }
  }
  return rosterIds;
}

// Folds exactly one already-finished season into the career aggregate.
// Idempotent per season via lastMergedSeason -- callers must persist the
// returned object *before* attempting any message send, so a crash between
// merge and send can't cause a season to be double-counted on retry.
export function mergeSeasonIntoHallOfFame(
  hallOfFame,
  { season, rosters, matchupsByWeek, winnersBracket, regularSeasonEndWeek }
) {
  if (!season || hallOfFame.lastMergedSeason === season) {
    return hallOfFame;
  }

  const userIdByRosterId = new Map(
    (rosters ?? []).map((roster) => [String(roster.roster_id), String(roster.owner_id ?? "")])
  );

  // Regular season only -- career W-L-T/points-for mirrors what this league's
  // own standings have always meant (weeks 1..regularSeasonEndWeek); playoff
  // success is tracked separately below via championships/runnerUps/
  // playoffAppearances, the same split the rest of the codebase already uses.
  for (let week = 1; week <= regularSeasonEndWeek; week += 1) {
    const entries = normalizeWeekEntries(matchupsByWeek?.[week] ?? []).filter(
      (entry) => entry.points > 0 && entry.matchupId > 0
    );
    const grouped = groupWeekEntriesByMatchup(entries);

    for (const pair of grouped.values()) {
      if (pair.length !== 2) {
        continue;
      }

      const [left, right] = pair;
      const leftUserId = userIdByRosterId.get(left.rosterId);
      const rightUserId = userIdByRosterId.get(right.rosterId);
      if (!leftUserId || !rightUserId) {
        continue;
      }

      const leftCareer = ensureCareerEntry(hallOfFame, leftUserId);
      const rightCareer = ensureCareerEntry(hallOfFame, rightUserId);

      leftCareer.pointsFor += left.points;
      rightCareer.pointsFor += right.points;

      const difference = left.points - right.points;
      if (Math.abs(difference) < 0.0001) {
        leftCareer.ties += 1;
        rightCareer.ties += 1;
      } else if (difference > 0) {
        leftCareer.wins += 1;
        rightCareer.losses += 1;
      } else {
        rightCareer.wins += 1;
        leftCareer.losses += 1;
      }
    }
  }

  for (const roster of rosters ?? []) {
    const userId = String(roster.owner_id ?? "");
    if (userId) {
      ensureCareerEntry(hallOfFame, userId).seasonsPlayed += 1;
    }
  }

  for (const rosterId of collectPlayoffRosterIds(winnersBracket)) {
    const userId = userIdByRosterId.get(rosterId);
    if (userId) {
      ensureCareerEntry(hallOfFame, userId).playoffAppearances += 1;
    }
  }

  const championshipEntry = findPlacementEntry(winnersBracket, 1);
  if (championshipEntry?.w != null) {
    const championUserId = userIdByRosterId.get(String(championshipEntry.w));
    if (championUserId) {
      ensureCareerEntry(hallOfFame, championUserId).championships += 1;
    }
  }
  if (championshipEntry?.l != null) {
    const runnerUpUserId = userIdByRosterId.get(String(championshipEntry.l));
    if (runnerUpUserId) {
      ensureCareerEntry(hallOfFame, runnerUpUserId).runnerUps += 1;
    }
  }

  hallOfFame.lastMergedSeason = season;
  return hallOfFame;
}

async function fetchSeasonMatchups(leagueId, throughWeek, fetchJson) {
  const weeks = Array.from({ length: throughWeek }, (_, index) => index + 1);
  const results = await Promise.all(
    weeks.map(async (week) => {
      try {
        const matchups = await fetchJson(
          `https://api.sleeper.app/v1/league/${leagueId}/matchups/${week}`
        );
        return [week, Array.isArray(matchups) ? matchups : []];
      } catch (error) {
        return [week, []];
      }
    })
  );
  return Object.fromEntries(results);
}

// One-time full chain walk, mirroring milestones.js's buildRecordBookFromHistory.
// Unlike that record book (re-walked every poll until it seeds successfully),
// this only ever needs to run once: by the time pollForPlayoffRecap calls it,
// the *current* season's regular season + bracket are already fully decided,
// so the current season can be folded in via the exact same per-season merge
// as every prior season -- no separate "current season" special case needed.
export async function buildHallOfFameFromHistory({
  league,
  fetchJson,
  regularSeasonEndWeek,
  logger = console,
}) {
  const hallOfFame = createEmptyHallOfFame();
  const leagues = [];
  let current = league;
  let guard = 0;

  while (current && guard < 25) {
    leagues.push(current);
    const previousId = String(current.previous_league_id ?? "").trim();
    if (!previousId || previousId === "0") {
      break;
    }

    try {
      current = await fetchJson(`https://api.sleeper.app/v1/league/${previousId}`);
    } catch (error) {
      logger.warn?.(`Hall of Fame seed: could not fetch previous league ${previousId}.`);
      break;
    }
    guard += 1;
  }

  // Oldest-to-newest so lastMergedSeason ends up as the most recent season in
  // the chain -- the same value the incremental path would leave behind.
  const orderedLeagues = [...leagues].reverse();

  let seededAny = false;
  for (const seasonLeague of orderedLeagues) {
    const season = String(seasonLeague.season ?? "").trim();
    if (!season) {
      continue;
    }

    try {
      const [rosters, users, winnersBracket] = await Promise.all([
        fetchJson(`https://api.sleeper.app/v1/league/${seasonLeague.league_id}/rosters`),
        fetchJson(`https://api.sleeper.app/v1/league/${seasonLeague.league_id}/users`),
        fetchJson(`https://api.sleeper.app/v1/league/${seasonLeague.league_id}/winners_bracket`),
      ]);
      const matchupsByWeek = await fetchSeasonMatchups(
        seasonLeague.league_id,
        regularSeasonEndWeek,
        fetchJson
      );

      // A freshly-rolled-over "current" league (e.g. next season already
      // created in Sleeper as pre_draft/drafting/in_season) hasn't actually
      // played anything yet -- merging it would fabricate phantom 0-0
      // seasons and playoff appearances from Sleeper's meaningless
      // placeholder winners_bracket. Checking real scored data through the
      // last regular-season week (the same signal isBracketTrustworthy is
      // built on) is more reliable than trusting league.status's timing.
      if (!isWeekScored(matchupsByWeek, regularSeasonEndWeek)) {
        logger.warn?.(
          `Hall of Fame seed: skipped season ${season} (regular season not yet complete).`
        );
        continue;
      }

      mergeSeasonIntoHallOfFame(hallOfFame, {
        season,
        rosters,
        users,
        matchupsByWeek,
        winnersBracket,
        regularSeasonEndWeek,
      });
      seededAny = true;
    } catch (error) {
      logger.warn?.(
        `Hall of Fame seed: skipped season ${seasonLeague.season ?? "?"} (${error.message}).`
      );
    }
  }

  hallOfFame.seededFromHistory = seededAny;
  hallOfFame.seededAt = new Date().toISOString();
  return hallOfFame;
}

function formatUserLabel(userId, userLookup) {
  const user = userLookup.get(String(userId));
  const teamName = user?.metadata?.team_name?.trim();
  const displayName = user?.display_name?.trim();

  if (teamName) {
    return teamName;
  }

  if (displayName) {
    return displayName;
  }

  // No entry in the *current* season's users list at all -- a manager who's
  // since left the league. A raw 18-digit Sleeper snowflake id reads as
  // noise once truncated to fit the label width, so shorten it up front.
  return `Former Manager #${String(userId).slice(-6)}`;
}

// Keyed directly by userId, so unlike formatRosterLabel this needs no
// rosterId hop -- only the *current* season's users list, since career
// stats should always render under each manager's current name.
export function buildHallOfFameReport({ league, users, hallOfFame }) {
  const userLookup = buildUserLookup(users);
  const leagueName = String(league?.name ?? "League").trim() || "League";
  const careerStatsByUserId = hallOfFame?.careerStatsByUserId ?? {};

  const managers = Object.entries(careerStatsByUserId).map(([userId, stats]) => {
    const gamesPlayed = stats.wins + stats.losses + stats.ties;
    const winPct = gamesPlayed > 0 ? (stats.wins + stats.ties * 0.5) / gamesPlayed : 0;
    return {
      userId,
      label: formatUserLabel(userId, userLookup),
      wins: stats.wins,
      losses: stats.losses,
      ties: stats.ties,
      pointsFor: stats.pointsFor,
      championships: stats.championships,
      runnerUps: stats.runnerUps,
      playoffAppearances: stats.playoffAppearances,
      seasonsPlayed: stats.seasonsPlayed,
      winPct,
    };
  });

  if (managers.length === 0) {
    return null;
  }

  managers.sort((a, b) => {
    if (b.championships !== a.championships) {
      return b.championships - a.championships;
    }
    return b.winPct - a.winPct;
  });

  const report = { leagueName, managers };
  report.textMessage = formatHallOfFameMessage(report);
  return report;
}

export function formatHallOfFameMessage({ leagueName, managers }) {
  const headerLine = `📜 ${leagueName} Hall of Fame`;
  // Sized off the header length, trimmed back -- a divider matching the full
  // header wraps to a second line on mobile (same fix as the other features).
  const divider = "—".repeat(Math.max(STANDINGS_DIVIDER.length, headerLine.length - 15));

  const lines = managers.map((manager, index) => {
    const rank = index + 1;
    const record =
      manager.ties > 0
        ? `${manager.wins}-${manager.losses}-${manager.ties}`
        : `${manager.wins}-${manager.losses}`;

    const titleParts = [];
    if (manager.championships > 0) {
      titleParts.push(`🏆x${manager.championships}`);
    }
    if (manager.runnerUps > 0) {
      titleParts.push(`🥈x${manager.runnerUps}`);
    }
    const titleSuffix = titleParts.length > 0 ? ` ${titleParts.join(" ")}` : "";

    return `${rank}. ${truncateLabel(manager.label, DEFAULT_TEAM_NAME_MAX_LENGTH)}${titleSuffix}\n   ${record} · ${formatOneDecimal(
      manager.pointsFor
    )} PF · ${manager.playoffAppearances} playoff trips · ${manager.seasonsPlayed} seasons`;
  });

  return [headerLine, divider, "", lines.join("\n\n")].join("\n");
}
