const DEFAULT_SIMULATION_COUNT = 10000;
const DEFAULT_REGULAR_SEASON_END_WEEK = 14;
const DEFAULT_PLAYOFF_TEAM_COUNT = 6;
const DEFAULT_TEAM_NAME_MAX_LENGTH = 24;
const EASTERN_TIME_ZONE = "America/New_York";

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
  const lines = [`Week ${week} Standings`, leagueName, ""];

  for (const team of standings) {
    const oddsBits = [`PO ${formatPercent(team.playoffOdds)}`];
    if (includeByeOdds) {
      oddsBits.push(`Bye ${formatPercent(team.byeOdds)}`);
    }

    lines.push(
      `${team.rank}. ${truncateLabel(team.label, DEFAULT_TEAM_NAME_MAX_LENGTH)} ${formatRecord(team)} | PF ${formatOneDecimal(team.pointsFor)} | ${oddsBits.join(
        " | "
      )}`
    );
  }

  return lines.join("\n");
}

export function isTuesdayAfterHourInEastern(date, hour24) {
  const parts = getEasternDateParts(date);
  return parts.weekday === "Tuesday" && parts.hour >= hour24;
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

function groupWeekEntriesByMatchup(entries) {
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

function normalizeWeekEntries(entries) {
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

function buildRosterLookup(rosters) {
  return new Map(rosters.map((roster) => [String(roster.roster_id), roster]));
}

function buildUserLookup(users) {
  return new Map(users.map((user) => [String(user.user_id), user]));
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

function getEasternDateParts(date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TIME_ZONE,
    weekday: "long",
    hour: "numeric",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);

  return {
    weekday: parts.find((part) => part.type === "weekday")?.value ?? "",
    hour: Number(parts.find((part) => part.type === "hour")?.value ?? "0") || 0,
  };
}

function formatRecord(team) {
  return team.ties > 0
    ? `${team.wins}-${team.losses}-${team.ties}`
    : `${team.wins}-${team.losses}`;
}

function formatPercent(value) {
  return `${Math.round((value ?? 0) * 100)}%`;
}

function formatOneDecimal(value) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value ?? 0);
}

function truncateLabel(value, maxLength) {
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
