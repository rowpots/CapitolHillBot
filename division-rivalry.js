import {
  buildRosterLookup,
  buildUserLookup,
  DEFAULT_TEAM_NAME_MAX_LENGTH,
  formatMatchupLine,
  formatOneDecimal,
  formatRosterLabel,
  groupWeekEntriesByMatchup,
  normalizeWeekEntries,
  STANDINGS_DIVIDER,
  truncateLabel,
} from "./weekly-report.js";

// The regular season is split into 4 "quarters" for the rivalry tracker so it
// doesn't compete with the weekly Tuesday recap / Thursday rankings cadence —
// posted once after each of these weeks completes, instead of every week.
export const RIVALRY_QUARTER_WEEKS = [4, 7, 11, 14];

export function getDivisionNames(league) {
  return {
    1: cleanDivisionName(league?.metadata?.division_1, "Division 1"),
    2: cleanDivisionName(league?.metadata?.division_2, "Division 2"),
  };
}

export function buildDivisionRivalryReport({
  league,
  rosters,
  users,
  matchupsByWeek,
  throughWeek,
  allTimeSeries = null,
}) {
  const rosterLookup = buildRosterLookup(rosters);
  const userLookup = buildUserLookup(users);
  const divisionByRosterId = new Map(
    rosters.map((roster) => [
      String(roster.roster_id),
      Number(roster?.settings?.division ?? 0) || 0,
    ])
  );

  const divisionNames = getDivisionNames(league);

  let firstWins = 0;
  let secondWins = 0;
  let ties = 0;
  let firstPoints = 0;
  let secondPoints = 0;
  let biggestBlowout = null;
  let closestGame = null;

  // Per-team interdivision record, so each division's best/worst rivalry
  // performer can be called out alongside the overall series tally.
  const recordsByRosterId = new Map();
  const recordFor = (rosterId) => {
    if (!recordsByRosterId.has(rosterId)) {
      recordsByRosterId.set(rosterId, { wins: 0, losses: 0, ties: 0, pointsFor: 0 });
    }
    return recordsByRosterId.get(rosterId);
  };

  for (let week = 1; week <= throughWeek; week += 1) {
    const entries = normalizeWeekEntries(matchupsByWeek?.[week] ?? []);
    const grouped = groupWeekEntriesByMatchup(entries);

    for (const pair of grouped.values()) {
      if (pair.length !== 2) {
        continue;
      }

      const [left, right] = pair;
      const leftDivision = divisionByRosterId.get(left.rosterId) ?? 0;
      const rightDivision = divisionByRosterId.get(right.rosterId) ?? 0;

      // Only interdivision games count toward the rivalry series — a game
      // between two teams in the same division isn't a "rivalry" matchup.
      if (!leftDivision || !rightDivision || leftDivision === rightDivision) {
        continue;
      }

      const firstSide = leftDivision === 1 ? left : right;
      const secondSide = leftDivision === 1 ? right : left;
      const firstRecord = recordFor(firstSide.rosterId);
      const secondRecord = recordFor(secondSide.rosterId);
      firstRecord.pointsFor += firstSide.points;
      secondRecord.pointsFor += secondSide.points;
      firstPoints += firstSide.points;
      secondPoints += secondSide.points;

      if (firstSide.points > secondSide.points) {
        firstWins += 1;
        firstRecord.wins += 1;
        secondRecord.losses += 1;
      } else if (secondSide.points > firstSide.points) {
        secondWins += 1;
        secondRecord.wins += 1;
        firstRecord.losses += 1;
      } else {
        ties += 1;
        firstRecord.ties += 1;
        secondRecord.ties += 1;
      }

      const margin = Math.abs(firstSide.points - secondSide.points);
      const isTie = firstSide.points === secondSide.points;
      const winnerSide = firstSide.points >= secondSide.points ? firstSide : secondSide;
      const loserSide = firstSide.points >= secondSide.points ? secondSide : firstSide;
      const gameDetail = {
        week,
        winner: formatRosterLabel(winnerSide.rosterId, rosterLookup, userLookup),
        loser: formatRosterLabel(loserSide.rosterId, rosterLookup, userLookup),
        margin,
        isTie,
      };

      if (!biggestBlowout || margin > biggestBlowout.margin) {
        biggestBlowout = gameDetail;
      }
      if (!closestGame || margin < closestGame.margin) {
        closestGame = gameDetail;
      }
    }
  }

  const totalGames = firstWins + secondWins + ties;
  if (totalGames === 0) {
    return null;
  }

  const leagueName = String(league?.name ?? "League").trim() || "League";
  const report = {
    leagueName,
    week: throughWeek,
    divisionNames,
    firstWins,
    secondWins,
    ties,
    totalGames,
    firstPoints,
    secondPoints,
    biggestBlowout,
    // Skip showing the same single game twice when only one game has been
    // played so far this quarter.
    closestGame: closestGame === biggestBlowout ? null : closestGame,
    allTimeSeries,
    firstDivisionStandout: findStandout({
      divisionNumber: 1,
      divisionByRosterId,
      recordsByRosterId,
      rosterLookup,
      userLookup,
    }),
    secondDivisionStandout: findStandout({
      divisionNumber: 2,
      divisionByRosterId,
      recordsByRosterId,
      rosterLookup,
      userLookup,
    }),
  };
  report.textMessage = formatDivisionRivalryMessage(report);
  return report;
}

function findStandout({
  divisionNumber,
  divisionByRosterId,
  recordsByRosterId,
  rosterLookup,
  userLookup,
}) {
  const candidates = [...recordsByRosterId.entries()]
    .filter(([rosterId]) => divisionByRosterId.get(rosterId) === divisionNumber)
    .map(([rosterId, record]) => ({
      label: formatRosterLabel(rosterId, rosterLookup, userLookup),
      ...record,
    }))
    .sort(
      (a, b) =>
        b.wins - b.losses - (a.wins - a.losses) || b.pointsFor - a.pointsFor
    );

  if (candidates.length === 0) {
    return null;
  }

  const top = candidates[0];
  const bottom = candidates[candidates.length - 1];
  // Only one team has played an interdivision game so far this quarter —
  // nothing to contrast yet.
  if (top === bottom) {
    return { top, bottom: null };
  }

  return { top, bottom };
}

// Walks the previous_league_id chain (same approach as the milestone record
// book) and tallies the interdivision series across every season whose
// division names match this season's two division names. A season that used
// different (or no) division names simply doesn't contribute — there's no
// reliable way to map its divisions onto the current rivalry.
export async function buildAllTimeDivisionSeries({
  league,
  fetchJson,
  regularSeasonEndWeek,
  currentThroughWeek,
  currentDivisionNames,
  logger = console,
}) {
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
      logger.warn?.(`Division rivalry seed: could not fetch previous league ${previousId}.`);
      break;
    }
    guard += 1;
  }

  let firstWins = 0;
  let secondWins = 0;
  let ties = 0;
  let seasonsCounted = 0;

  for (const seasonLeague of leagues) {
    const isCurrent = String(seasonLeague.league_id) === String(league.league_id);
    const through = isCurrent ? currentThroughWeek : regularSeasonEndWeek;
    if (through < 1) {
      continue;
    }

    const seasonDivisionNames = {
      1: cleanDivisionName(seasonLeague?.metadata?.division_1, ""),
      2: cleanDivisionName(seasonLeague?.metadata?.division_2, ""),
    };
    const mapping = mapDivisionNumbersByName(seasonDivisionNames, currentDivisionNames);
    if (!mapping) {
      continue;
    }

    try {
      const [rosters, matchupsByWeek] = await Promise.all([
        fetchJson(`https://api.sleeper.app/v1/league/${seasonLeague.league_id}/rosters`),
        fetchSeasonMatchups(seasonLeague.league_id, through, fetchJson),
      ]);

      const divisionByRosterId = new Map(
        rosters.map((roster) => [
          String(roster.roster_id),
          Number(roster?.settings?.division ?? 0) || 0,
        ])
      );

      for (let week = 1; week <= through; week += 1) {
        const entries = normalizeWeekEntries(matchupsByWeek?.[week] ?? []);
        const grouped = groupWeekEntriesByMatchup(entries);

        for (const pair of grouped.values()) {
          if (pair.length !== 2) {
            continue;
          }

          const [left, right] = pair;
          const leftDivision = divisionByRosterId.get(left.rosterId) ?? 0;
          const rightDivision = divisionByRosterId.get(right.rosterId) ?? 0;
          if (!leftDivision || !rightDivision || leftDivision === rightDivision) {
            continue;
          }

          const leftMapped = mapping[leftDivision];
          const rightMapped = mapping[rightDivision];
          if (!leftMapped || !rightMapped) {
            continue;
          }

          const firstSide = leftMapped === 1 ? left : right;
          const secondSide = leftMapped === 1 ? right : left;

          if (firstSide.points > secondSide.points) {
            firstWins += 1;
          } else if (secondSide.points > firstSide.points) {
            secondWins += 1;
          } else {
            ties += 1;
          }
        }
      }

      seasonsCounted += 1;
    } catch (error) {
      logger.warn?.(
        `Division rivalry seed: skipped season ${seasonLeague.season ?? "?"} (${error.message}).`
      );
    }
  }

  const totalGames = firstWins + secondWins + ties;
  if (seasonsCounted === 0 || totalGames === 0) {
    return null;
  }

  return { firstWins, secondWins, ties, totalGames, seasonsCounted };
}

function mapDivisionNumbersByName(seasonDivisionNames, currentDivisionNames) {
  const mapping = {};

  for (const seasonNumber of [1, 2]) {
    const seasonName = seasonDivisionNames[seasonNumber];
    if (!seasonName) {
      return null;
    }

    if (seasonName === currentDivisionNames[1]) {
      mapping[seasonNumber] = 1;
    } else if (seasonName === currentDivisionNames[2]) {
      mapping[seasonNumber] = 2;
    } else {
      return null;
    }
  }

  // Both of this season's divisions matched the same current division name —
  // not a usable 1-to-1 mapping.
  if (mapping[1] === mapping[2]) {
    return null;
  }

  return mapping;
}

async function fetchSeasonMatchups(leagueId, throughWeek, fetchJson) {
  const results = await Promise.all(
    Array.from({ length: throughWeek }, (_, index) => index + 1).map(async (week) => [
      week,
      await fetchJson(`https://api.sleeper.app/v1/league/${leagueId}/matchups/${week}`),
    ])
  );
  return Object.fromEntries(results);
}

export function formatDivisionRivalryMessage({
  leagueName,
  week,
  divisionNames,
  firstWins,
  secondWins,
  ties,
  totalGames,
  firstPoints,
  secondPoints,
  biggestBlowout,
  closestGame,
  allTimeSeries,
  firstDivisionStandout,
  secondDivisionStandout,
}) {
  const tieSuffix = ties > 0 ? `-${ties}` : "";
  const seasonLine =
    firstWins === secondWins
      ? `This season: tied ${firstWins}-${secondWins}${tieSuffix} · ${totalGames} game${
          totalGames === 1 ? "" : "s"
        } played`
      : firstWins > secondWins
      ? `This season: ${divisionNames[1]} lead ${firstWins}-${secondWins}${tieSuffix} · ${totalGames} game${
          totalGames === 1 ? "" : "s"
        } played`
      : `This season: ${divisionNames[2]} lead ${secondWins}-${firstWins}${tieSuffix} · ${totalGames} game${
          totalGames === 1 ? "" : "s"
        } played`;

  const headerLine = `🏛️ ${leagueName} Division Rivalry — Through Week ${week}`;
  // Sized off the header length, but trimmed back — a divider matching the
  // full header wraps to a second line on mobile.
  const divider = "—".repeat(
    Math.max(STANDINGS_DIVIDER.length, headerLine.length - 15)
  );

  const lines = [
    headerLine,
    divider,
    "",
    `${divisionNames[1]} vs. ${divisionNames[2]}`,
    seasonLine,
  ];

  if (allTimeSeries) {
    const { firstWins: atFirst, secondWins: atSecond, ties: atTies, seasonsCounted } =
      allTimeSeries;
    const atTieSuffix = atTies > 0 ? `-${atTies}` : "";
    const allTimeLine =
      atFirst === atSecond
        ? `All-time: tied ${atFirst}-${atSecond}${atTieSuffix} (${seasonsCounted} season${
            seasonsCounted === 1 ? "" : "s"
          })`
        : atFirst > atSecond
        ? `All-time: ${divisionNames[1]} lead ${atFirst}-${atSecond}${atTieSuffix} (${seasonsCounted} season${
            seasonsCounted === 1 ? "" : "s"
          })`
        : `All-time: ${divisionNames[2]} lead ${atSecond}-${atFirst}${atTieSuffix} (${seasonsCounted} season${
            seasonsCounted === 1 ? "" : "s"
          })`;
    lines.push(allTimeLine);
  }

  lines.push("");
  lines.push(
    `📊 Total Points: ${truncateLabel(divisionNames[1], DEFAULT_TEAM_NAME_MAX_LENGTH)} ${formatOneDecimal(
      firstPoints
    )} - ${formatOneDecimal(secondPoints)} ${truncateLabel(
      divisionNames[2],
      DEFAULT_TEAM_NAME_MAX_LENGTH
    )}`
  );

  if (biggestBlowout) {
    lines.push("");
    lines.push(
      `💥 Biggest Blowout (Wk ${biggestBlowout.week})\n${formatMatchupLine(biggestBlowout)}`
    );
  }

  if (closestGame) {
    lines.push("");
    lines.push(
      `😬 Closest Game (Wk ${closestGame.week})\n${formatMatchupLine(closestGame)}`
    );
  }

  for (const [name, standout] of [
    [divisionNames[1], firstDivisionStandout],
    [divisionNames[2], secondDivisionStandout],
  ]) {
    if (!standout) {
      continue;
    }

    lines.push("");
    lines.push(`🔥 ${name} MVP: ${standout.top.label} (${formatRecord(standout.top)})`);
    if (standout.bottom) {
      lines.push(
        `🧊 ${name} Bust: ${standout.bottom.label} (${formatRecord(standout.bottom)})`
      );
    }
  }

  return lines.join("\n");
}

function formatRecord({ wins, losses, ties }) {
  return ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

function cleanDivisionName(value, fallback) {
  const trimmed = String(value ?? "").trim();
  return trimmed || fallback;
}
