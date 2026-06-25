const DEFAULT_SIMULATION_COUNT = 10000;
const DEFAULT_REGULAR_SEASON_END_WEEK = 14;
const DEFAULT_PLAYOFF_TEAM_COUNT = 6;
export const DEFAULT_TEAM_NAME_MAX_LENGTH = 24;
const EASTERN_TIME_ZONE = "America/New_York";
export const STANDINGS_DIVIDER = "———————————————————————————";
const POWER_RANKING_WEIGHTS = {
  scoring: 0.4,
  allPlay: 0.25,
  winPct: 0.2,
  recentForm: 0.15,
};
const POWER_RANKING_RECENT_WEEKS = 3;
const POWER_SCORE_MIN = 40;
const POWER_SCORE_MAX = 99;

export function buildWeeklyReport({
  league,
  rosters,
  users,
  matchupsByWeek,
  throughWeek,
  regularSeasonEndWeek = DEFAULT_REGULAR_SEASON_END_WEEK,
  playoffTeams = DEFAULT_PLAYOFF_TEAM_COUNT,
  byeTeams = resolveByeTeamCount(playoffTeams),
  simulationCount = DEFAULT_SIMULATION_COUNT,
}) {
  const normalizedWeek = clampWeek(throughWeek, regularSeasonEndWeek);
  if (normalizedWeek < 1) {
    throw new Error("Weekly reports require a completed week between 1 and 14.");
  }

  const rosterLookup = buildRosterLookup(rosters);
  const userLookup = buildUserLookup(users);
  const standings = buildStandings({
    rosters,
    rosterLookup,
    userLookup,
    matchupsByWeek,
    throughWeek: normalizedWeek,
  });

  const remainingSchedule = buildRemainingSchedule({
    matchupsByWeek,
    startWeek: normalizedWeek + 1,
    endWeek: regularSeasonEndWeek,
  });

  const simulation = simulatePlayoffOdds({
    standings,
    remainingSchedule,
    playoffTeams,
    byeTeams,
    simulationCount,
    season: league?.season,
    leagueId: league?.league_id,
    throughWeek: normalizedWeek,
  });

  const rankedStandings = rankStandings(standings).map((team) => ({
    ...team,
    playoffOdds: simulation.playoffOddsByRosterId.get(team.rosterId) ?? 0,
    byeOdds: simulation.byeOddsByRosterId.get(team.rosterId) ?? 0,
  }));

  return {
    leagueName: league?.name?.trim() || "Fantasy League",
    season: String(league?.season ?? ""),
    week: normalizedWeek,
    playoffTeams,
    byeTeams,
    simulationCount,
    standings: rankedStandings,
    textMessage: formatWeeklyReportMessage({
      leagueName: league?.name?.trim() || "Fantasy League",
      week: normalizedWeek,
      standings: rankedStandings,
      includeByeOdds: byeTeams > 0,
    }),
  };
}

export function findLatestCompletedWeek(
  matchupsByWeek,
  regularSeasonEndWeek = DEFAULT_REGULAR_SEASON_END_WEEK
) {
  let latestCompletedWeek = 0;

  for (let week = 1; week <= regularSeasonEndWeek; week += 1) {
    const matchups = matchupsByWeek?.[week] ?? [];
    const scoredEntries = matchups.filter(
      (entry) => getMatchupPoints(entry) > 0 && Number(entry?.matchup_id) > 0
    );

    if (scoredEntries.length > 0) {
      latestCompletedWeek = week;
    }
  }

  return latestCompletedWeek;
}

export function formatWeeklyReportMessage({
  leagueName,
  week,
  standings,
  includeByeOdds,
}) {
  const blocks = [];

  for (const team of standings) {
    const oddsBits = [`PO ${formatPercent(team.playoffOdds)}`];
    // Only surface bye odds when they are non-zero — every eliminated team
    // showing "Bye 0%" is just clutter.
    if (includeByeOdds && (team.byeOdds ?? 0) > 0) {
      oddsBits.push(`Bye ${formatPercent(team.byeOdds)}`);
    }

    const headline = `${formatRankPrefix(team.rank)} ${truncateLabel(
      team.label,
      DEFAULT_TEAM_NAME_MAX_LENGTH
    )}   ${formatRecord(team)}`;
    const detail = `   PF ${formatPointsForDisplay(team.pointsFor)}  ·  ${oddsBits.join(
      "  ·  "
    )}`;

    blocks.push(`${headline}\n${detail}`);
  }

  const header = [`🏈 ${leagueName} Week ${week} Standings`, STANDINGS_DIVIDER];
  return `${header.join("\n")}\n${blocks.join("\n\n")}`;
}

export function buildWeeklyRecap({
  league,
  rosters,
  users,
  matchupsByWeek,
  week,
}) {
  const numericWeek = Number(week);
  if (!Number.isFinite(numericWeek) || numericWeek < 1) {
    return null;
  }

  const rosterLookup = buildRosterLookup(rosters);
  const userLookup = buildUserLookup(users);
  const labelFor = (rosterId) =>
    formatRosterLabel(rosterId, rosterLookup, userLookup);

  const entries = normalizeWeekEntries(matchupsByWeek?.[numericWeek] ?? []);
  if (entries.length === 0) {
    return null;
  }

  let topScorer = null;
  let lowScorer = null;
  for (const entry of entries) {
    if (!topScorer || entry.points > topScorer.points) {
      topScorer = entry;
    }
    if (!lowScorer || entry.points < lowScorer.points) {
      lowScorer = entry;
    }
  }

  const matchups = [];
  for (const matchupEntries of groupWeekEntriesByMatchup(entries).values()) {
    if (matchupEntries.length !== 2) {
      continue;
    }

    const [left, right] = matchupEntries;
    const margin = Math.abs(left.points - right.points);
    const isTie = margin < 0.0001;
    const winner = left.points >= right.points ? left : right;
    const loser = winner === left ? right : left;

    matchups.push({ margin, isTie, winner, loser });
  }

  let biggestBlowout = null;
  let closestGame = null;
  for (const matchup of matchups) {
    if (!biggestBlowout || matchup.margin > biggestBlowout.margin) {
      biggestBlowout = matchup;
    }
    if (!closestGame || matchup.margin < closestGame.margin) {
      closestGame = matchup;
    }
  }

  const leagueName = league?.name?.trim() || "Fantasy League";
  const recap = {
    week: numericWeek,
    leagueName,
    topScorer: topScorer
      ? { label: labelFor(topScorer.rosterId), points: topScorer.points }
      : null,
    lowScorer: lowScorer
      ? { label: labelFor(lowScorer.rosterId), points: lowScorer.points }
      : null,
    biggestBlowout: biggestBlowout
      ? {
          winner: labelFor(biggestBlowout.winner.rosterId),
          loser: labelFor(biggestBlowout.loser.rosterId),
          margin: biggestBlowout.margin,
          isTie: biggestBlowout.isTie,
        }
      : null,
    closestGame: closestGame
      ? {
          winner: labelFor(closestGame.winner.rosterId),
          loser: labelFor(closestGame.loser.rosterId),
          margin: closestGame.margin,
          isTie: closestGame.isTie,
        }
      : null,
  };

  recap.textMessage = formatWeeklyRecapMessage(recap);
  return recap;
}

export function formatWeeklyRecapMessage({
  week,
  topScorer,
  lowScorer,
  biggestBlowout,
  closestGame,
}) {
  const blocks = [];

  if (topScorer) {
    blocks.push(
      `🔥 Top Score\n${truncateLabel(
        topScorer.label,
        DEFAULT_TEAM_NAME_MAX_LENGTH
      )} — ${formatOneDecimal(topScorer.points)}`
    );
  }

  if (lowScorer) {
    blocks.push(
      `🧊 Low Score\n${truncateLabel(
        lowScorer.label,
        DEFAULT_TEAM_NAME_MAX_LENGTH
      )} — ${formatOneDecimal(lowScorer.points)}`
    );
  }

  if (biggestBlowout) {
    blocks.push(`💥 Biggest Blowout\n${formatMatchupLine(biggestBlowout)}`);
  }

  if (closestGame) {
    blocks.push(`😬 Closest Game\n${formatMatchupLine(closestGame)}`);
  }

  // Lead with blank lines so the recap (sent as its own message right after the
  // standings) has a visual buffer instead of butting up against it.
  return ["", "", `📊 Week ${week} Matchups Recap`, "", blocks.join("\n\n")].join(
    "\n"
  );
}

export function formatMatchupLine({ winner, loser, margin, isTie }) {
  const winnerLabel = truncateLabel(winner, DEFAULT_TEAM_NAME_MAX_LENGTH);
  const loserLabel = truncateLabel(loser, DEFAULT_TEAM_NAME_MAX_LENGTH);

  if (isTie) {
    return `${winnerLabel} tied ${loserLabel}`;
  }

  return `${winnerLabel} def. ${loserLabel} by ${formatOneDecimal(margin)}`;
}

export function buildPowerRankings({
  league,
  rosters,
  users,
  matchupsByWeek,
  throughWeek,
  week,
  previousOrder = [],
}) {
  const numericThroughWeek = Number(throughWeek);
  if (!Number.isFinite(numericThroughWeek) || numericThroughWeek < 1) {
    return null;
  }

  // The display week is the week these rankings are *for* (the upcoming slate),
  // which is one past the last completed week unless caller overrides it.
  const displayWeek = Number.isFinite(Number(week))
    ? Number(week)
    : numericThroughWeek + 1;

  const rosterLookup = buildRosterLookup(rosters);
  const userLookup = buildUserLookup(users);
  const standings = buildStandings({
    rosters,
    rosterLookup,
    userLookup,
    matchupsByWeek,
    throughWeek: numericThroughWeek,
  });

  if (!standings.some((team) => team.gamesPlayed > 0)) {
    return null;
  }

  const allPlayByRosterId = computeAllPlayWinPct(matchupsByWeek, numericThroughWeek);

  const metrics = standings.map((team) => ({
    rosterId: team.rosterId,
    label: team.label,
    ppg: team.gamesPlayed > 0 ? team.pointsFor / team.gamesPlayed : 0,
    recentForm: average(team.weeklyScores.slice(-POWER_RANKING_RECENT_WEEKS)),
    winPct: getWinPercentage(team),
    allPlay: allPlayByRosterId.get(team.rosterId) ?? 0,
  }));

  const ppgNorm = buildMinMaxNormalizer(metrics.map((m) => m.ppg));
  const recentNorm = buildMinMaxNormalizer(metrics.map((m) => m.recentForm));

  const scored = metrics.map((m) => ({
    ...m,
    composite:
      POWER_RANKING_WEIGHTS.scoring * ppgNorm(m.ppg) +
      POWER_RANKING_WEIGHTS.allPlay * m.allPlay +
      POWER_RANKING_WEIGHTS.winPct * m.winPct +
      POWER_RANKING_WEIGHTS.recentForm * recentNorm(m.recentForm),
  }));

  const scoreNorm = buildMinMaxNormalizer(scored.map((m) => m.composite));
  const previousRankByRosterId = new Map(
    (Array.isArray(previousOrder) ? previousOrder : []).map((rosterId, index) => [
      String(rosterId),
      index + 1,
    ])
  );

  const ranked = scored
    .map((m) => ({
      ...m,
      score:
        POWER_SCORE_MIN +
        scoreNorm(m.composite) * (POWER_SCORE_MAX - POWER_SCORE_MIN),
    }))
    .sort(comparePowerTeams)
    .map((team, index) => {
      const rank = index + 1;
      const previousRank = previousRankByRosterId.get(String(team.rosterId));
      return {
        rosterId: team.rosterId,
        label: team.label,
        score: team.score,
        rank,
        movement: previousRank ? previousRank - rank : null,
      };
    });

  const result = {
    leagueName: league?.name?.trim() || "Fantasy League",
    week: displayWeek,
    throughWeek: numericThroughWeek,
    teams: ranked,
    order: ranked.map((team) => team.rosterId),
  };
  result.textMessage = formatPowerRankingsMessage(result);
  return result;
}

export function formatPowerRankingsMessage({ leagueName, week, teams }) {
  const blocks = teams.map(
    (team) =>
      `${formatRankPrefix(team.rank)} ${truncateLabel(
        team.label,
        DEFAULT_TEAM_NAME_MAX_LENGTH
      )}   ${formatOneDecimal(team.score)}  ${formatMovement(team.movement)}`
  );

  const header = [
    `📈 ${leagueName} Week ${week} Power Rankings`,
    STANDINGS_DIVIDER,
    "Score /100  ·  ↑↓ vs last week",
  ];

  return `${header.join("\n")}\n\n${blocks.join("\n\n")}`;
}

export function isWeekdayAfterHourInEastern(date, weekday, hour24) {
  const parts = getEasternDateParts(date);
  return parts.weekday === weekday && parts.hour >= hour24;
}

export function isTuesdayAfterHourInEastern(date, hour24) {
  return isWeekdayAfterHourInEastern(date, "Tuesday", hour24);
}

export function isThursdayAfterHourInEastern(date, hour24) {
  return isWeekdayAfterHourInEastern(date, "Thursday", hour24);
}

// Minute-granular gate for sends that need to land close to a specific clock
// time (e.g. "30 min before kickoff") rather than just "sometime after hour X".
export function isWeekdayAtOrAfterTimeInEastern(date, weekday, hour24, minute = 0) {
  const parts = getEasternDateParts(date);
  if (parts.weekday !== weekday) {
    return false;
  }

  if (parts.hour !== hour24) {
    return parts.hour > hour24;
  }

  return parts.minute >= minute;
}

function buildStandings({
  rosters,
  rosterLookup,
  userLookup,
  matchupsByWeek,
  throughWeek,
}) {
  const standingsByRosterId = new Map(
    rosters.map((roster) => {
      const rosterId = String(roster.roster_id);
      return [
        rosterId,
        {
          rosterId,
          label: formatRosterLabel(rosterId, rosterLookup, userLookup),
          division: Number(roster?.settings?.division ?? 0) || null,
          wins: 0,
          losses: 0,
          ties: 0,
          gamesPlayed: 0,
          pointsFor: 0,
          pointsAgainst: 0,
          weeklyScores: [],
        },
      ];
    })
  );

  for (let week = 1; week <= throughWeek; week += 1) {
    const entries = normalizeWeekEntries(matchupsByWeek?.[week] ?? []);
    const groupedMatchups = groupWeekEntriesByMatchup(entries);

    for (const entry of entries) {
      const team = standingsByRosterId.get(entry.rosterId);
      if (!team) {
        continue;
      }

      team.pointsFor += entry.points;
      team.weeklyScores.push(entry.points);
    }

    for (const matchupEntries of groupedMatchups.values()) {
      if (matchupEntries.length !== 2) {
        continue;
      }

      const [leftEntry, rightEntry] = matchupEntries;
      const leftTeam = standingsByRosterId.get(leftEntry.rosterId);
      const rightTeam = standingsByRosterId.get(rightEntry.rosterId);

      if (!leftTeam || !rightTeam) {
        continue;
      }

      leftTeam.gamesPlayed += 1;
      rightTeam.gamesPlayed += 1;
      leftTeam.pointsAgainst += rightEntry.points;
      rightTeam.pointsAgainst += leftEntry.points;

      const difference = leftEntry.points - rightEntry.points;
      if (Math.abs(difference) < 0.0001) {
        leftTeam.ties += 1;
        rightTeam.ties += 1;
      } else if (difference > 0) {
        leftTeam.wins += 1;
        rightTeam.losses += 1;
      } else {
        rightTeam.wins += 1;
        leftTeam.losses += 1;
      }
    }
  }

  return Array.from(standingsByRosterId.values());
}

function buildRemainingSchedule({ matchupsByWeek, startWeek, endWeek }) {
  const remainingSchedule = [];

  for (let week = startWeek; week <= endWeek; week += 1) {
    const entries = normalizeWeekEntries(matchupsByWeek?.[week] ?? []);
    const groupedMatchups = groupWeekEntriesByMatchup(entries);

    for (const [matchupId, matchupEntries] of groupedMatchups.entries()) {
      if (matchupEntries.length !== 2) {
        continue;
      }

      remainingSchedule.push({
        week,
        matchupId,
        rosterIds: matchupEntries.map((entry) => entry.rosterId),
      });
    }
  }

  return remainingSchedule;
}

function simulatePlayoffOdds({
  standings,
  remainingSchedule,
  playoffTeams,
  byeTeams,
  simulationCount,
  season,
  leagueId,
  throughWeek,
}) {
  const rankedBaseStandings = rankStandings(standings);
  const playoffOddsByRosterId = new Map(
    standings.map((team) => [team.rosterId, 0])
  );
  const byeOddsByRosterId = new Map(standings.map((team) => [team.rosterId, 0]));

  if (remainingSchedule.length === 0) {
    for (const team of rankedBaseStandings.slice(0, playoffTeams)) {
      playoffOddsByRosterId.set(team.rosterId, 1);
    }

    for (const team of rankedBaseStandings.slice(0, byeTeams)) {
      byeOddsByRosterId.set(team.rosterId, 1);
    }

    return {
      playoffOddsByRosterId,
      byeOddsByRosterId,
    };
  }

  const leagueScoreSamples = standings.flatMap((team) => team.weeklyScores);
  const leagueMean = average(leagueScoreSamples) || 120;
  const leagueStandardDeviation =
    Math.max(standardDeviation(leagueScoreSamples), 10) || 20;
  const ratingsByRosterId = new Map(
    standings.map((team) => [
      team.rosterId,
      buildTeamRating({
        weeklyScores: team.weeklyScores,
        leagueMean,
        leagueStandardDeviation,
      }),
    ])
  );

  const random = createSeededRandom(
    `${leagueId ?? "league"}:${season ?? "season"}:${throughWeek}`
  );

  for (let simulationIndex = 0; simulationIndex < simulationCount; simulationIndex += 1) {
    const simulatedStandings = standings.map((team) => ({
      rosterId: team.rosterId,
      label: team.label,
      wins: team.wins,
      losses: team.losses,
      ties: team.ties,
      gamesPlayed: team.gamesPlayed,
      pointsFor: team.pointsFor,
      pointsAgainst: team.pointsAgainst,
    }));
    const simulatedByRosterId = new Map(
      simulatedStandings.map((team) => [team.rosterId, team])
    );

    for (const matchup of remainingSchedule) {
      const [leftRosterId, rightRosterId] = matchup.rosterIds;
      const leftTeam = simulatedByRosterId.get(leftRosterId);
      const rightTeam = simulatedByRosterId.get(rightRosterId);
      const leftRating = ratingsByRosterId.get(leftRosterId);
      const rightRating = ratingsByRosterId.get(rightRosterId);

      if (!leftTeam || !rightTeam || !leftRating || !rightRating) {
        continue;
      }

      const leftScore = sampleScore(leftRating, random);
      const rightScore = sampleScore(rightRating, random);

      leftTeam.gamesPlayed += 1;
      rightTeam.gamesPlayed += 1;
      leftTeam.pointsFor += leftScore;
      rightTeam.pointsFor += rightScore;
      leftTeam.pointsAgainst += rightScore;
      rightTeam.pointsAgainst += leftScore;

      const difference = leftScore - rightScore;
      if (Math.abs(difference) < 0.0001) {
        leftTeam.ties += 1;
        rightTeam.ties += 1;
      } else if (difference > 0) {
        leftTeam.wins += 1;
        rightTeam.losses += 1;
      } else {
        rightTeam.wins += 1;
        leftTeam.losses += 1;
      }
    }

    const rankedSimulation = rankStandings(simulatedStandings);
    for (const team of rankedSimulation.slice(0, playoffTeams)) {
      playoffOddsByRosterId.set(
        team.rosterId,
        (playoffOddsByRosterId.get(team.rosterId) ?? 0) + 1
      );
    }

    for (const team of rankedSimulation.slice(0, byeTeams)) {
      byeOddsByRosterId.set(
        team.rosterId,
        (byeOddsByRosterId.get(team.rosterId) ?? 0) + 1
      );
    }
  }

  for (const [rosterId, count] of playoffOddsByRosterId.entries()) {
    playoffOddsByRosterId.set(rosterId, count / simulationCount);
  }

  for (const [rosterId, count] of byeOddsByRosterId.entries()) {
    byeOddsByRosterId.set(rosterId, count / simulationCount);
  }

  return {
    playoffOddsByRosterId,
    byeOddsByRosterId,
  };
}

function buildTeamRating({ weeklyScores, leagueMean, leagueStandardDeviation }) {
  const gamesPlayed = weeklyScores.length;
  const sampleMean = average(weeklyScores) || leagueMean;
  const sampleStandardDeviation = standardDeviation(weeklyScores);
  const regressedMean =
    (sampleMean * gamesPlayed + leagueMean * 4) / Math.max(gamesPlayed + 4, 1);
  const regressedStandardDeviation =
    (sampleStandardDeviation * Math.max(gamesPlayed - 1, 0) +
      leagueStandardDeviation * 3) /
    Math.max(gamesPlayed + 2, 1);

  return {
    mean: regressedMean,
    standardDeviation: clampNumber(regressedStandardDeviation, 10, 35),
  };
}

function sampleScore(teamRating, random) {
  return Math.max(
    0,
    teamRating.mean + sampleStandardNormal(random) * teamRating.standardDeviation
  );
}

function rankStandings(standings) {
  return [...standings]
    .sort(compareStandings)
    .map((team, index) => ({
      ...team,
      rank: index + 1,
    }));
}

function compareStandings(left, right) {
  const leftWinPct = getWinPercentage(left);
  const rightWinPct = getWinPercentage(right);

  if (rightWinPct !== leftWinPct) {
    return rightWinPct - leftWinPct;
  }

  if (right.pointsFor !== left.pointsFor) {
    return right.pointsFor - left.pointsFor;
  }

  if (left.pointsAgainst !== right.pointsAgainst) {
    return left.pointsAgainst - right.pointsAgainst;
  }

  return left.label.localeCompare(right.label, "en-US");
}

function getWinPercentage(team) {
  if (!team.gamesPlayed) {
    return 0;
  }

  return (team.wins + team.ties * 0.5) / team.gamesPlayed;
}

export function groupWeekEntriesByMatchup(entries) {
  const grouped = new Map();

  for (const entry of entries) {
    if (!entry.matchupId) {
      continue;
    }

    if (!grouped.has(entry.matchupId)) {
      grouped.set(entry.matchupId, []);
    }

    grouped.get(entry.matchupId).push(entry);
  }

  return grouped;
}

export function normalizeWeekEntries(entries) {
  return entries
    .map((entry) => ({
      rosterId: String(entry?.roster_id ?? ""),
      matchupId: Number(entry?.matchup_id ?? 0) || 0,
      points: getMatchupPoints(entry),
    }))
    .filter((entry) => entry.rosterId);
}

function getMatchupPoints(entry) {
  const points = Number(
    entry?.custom_points != null ? entry.custom_points : entry?.points
  );
  return Number.isFinite(points) ? points : 0;
}

function resolveByeTeamCount(playoffTeams) {
  if (playoffTeams === 6) {
    return 2;
  }

  return 0;
}

function clampWeek(week, regularSeasonEndWeek) {
  const numericWeek = Number(week);
  if (!Number.isFinite(numericWeek)) {
    return 0;
  }

  return Math.max(0, Math.min(regularSeasonEndWeek, Math.trunc(numericWeek)));
}

export function buildRosterLookup(rosters) {
  return new Map(rosters.map((roster) => [String(roster.roster_id), roster]));
}

export function buildUserLookup(users) {
  return new Map(users.map((user) => [String(user.user_id), user]));
}

export function formatRosterLabel(rosterId, rosterLookup, userLookup) {
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

function getEasternDateParts(date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TIME_ZONE,
    weekday: "long",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);

  return {
    weekday: parts.find((part) => part.type === "weekday")?.value ?? "",
    hour: Number(parts.find((part) => part.type === "hour")?.value ?? "0") || 0,
    minute: Number(parts.find((part) => part.type === "minute")?.value ?? "0") || 0,
  };
}

function formatRecord(team) {
  return team.ties > 0
    ? `${team.wins}-${team.losses}-${team.ties}`
    : `${team.wins}-${team.losses}`;
}

function formatRankPrefix(rank) {
  if (rank === 1) {
    return "🥇";
  }
  if (rank === 2) {
    return "🥈";
  }
  if (rank === 3) {
    return "🥉";
  }

  return `${rank}.`;
}

function formatPointsForDisplay(value) {
  return String(Math.round(Number(value) || 0));
}

function formatMovement(movement) {
  if (!Number.isFinite(movement) || movement === 0) {
    return "—";
  }

  return movement > 0 ? `↑${movement}` : `↓${Math.abs(movement)}`;
}

function computeAllPlayWinPct(matchupsByWeek, throughWeek) {
  const allPlayWins = new Map();
  const allPlayGames = new Map();

  for (let week = 1; week <= throughWeek; week += 1) {
    const entries = normalizeWeekEntries(matchupsByWeek?.[week] ?? []);
    if (entries.length < 2) {
      continue;
    }

    for (const entry of entries) {
      let credit = 0;
      for (const other of entries) {
        if (other === entry) {
          continue;
        }

        if (entry.points > other.points) {
          credit += 1;
        } else if (Math.abs(entry.points - other.points) < 0.0001) {
          credit += 0.5;
        }
      }

      allPlayWins.set(entry.rosterId, (allPlayWins.get(entry.rosterId) ?? 0) + credit);
      allPlayGames.set(
        entry.rosterId,
        (allPlayGames.get(entry.rosterId) ?? 0) + (entries.length - 1)
      );
    }
  }

  const winPctByRosterId = new Map();
  for (const [rosterId, games] of allPlayGames.entries()) {
    winPctByRosterId.set(rosterId, games > 0 ? allPlayWins.get(rosterId) / games : 0);
  }

  return winPctByRosterId;
}

function buildMinMaxNormalizer(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  const min = finite.length ? Math.min(...finite) : 0;
  const max = finite.length ? Math.max(...finite) : 0;
  const range = max - min;

  return (value) => {
    if (range <= 0 || !Number.isFinite(value)) {
      // Everyone equal (or no spread): treat as the middle of the band.
      return range <= 0 ? 0.5 : 0;
    }

    return (value - min) / range;
  };
}

function comparePowerTeams(left, right) {
  if (right.composite !== left.composite) {
    return right.composite - left.composite;
  }

  if (right.ppg !== left.ppg) {
    return right.ppg - left.ppg;
  }

  if (right.winPct !== left.winPct) {
    return right.winPct - left.winPct;
  }

  return left.label.localeCompare(right.label, "en-US");
}

function formatPercent(value) {
  return `${Math.round((value ?? 0) * 100)}%`;
}

export function formatOneDecimal(value) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value ?? 0);
}

export function truncateLabel(value, maxLength) {
  const label = String(value ?? "").trim();
  if (label.length <= maxLength) {
    return label;
  }

  return `${label.slice(0, Math.max(maxLength - 3, 1)).trimEnd()}...`;
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function standardDeviation(values) {
  if (!Array.isArray(values) || values.length < 2) {
    return 0;
  }

  const mean = average(values);
  const variance =
    values.reduce((total, value) => total + (value - mean) ** 2, 0) /
    values.length;
  return Math.sqrt(variance);
}

function clampNumber(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function createSeededRandom(seedText) {
  let hash = 2166136261;

  for (let index = 0; index < seedText.length; index += 1) {
    hash ^= seedText.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  let state = hash >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleStandardNormal(random) {
  const left = Math.max(random(), Number.EPSILON);
  const right = Math.max(random(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(left)) * Math.cos(2 * Math.PI * right);
}
