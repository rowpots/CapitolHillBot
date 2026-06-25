import {
  DEFAULT_TEAM_NAME_MAX_LENGTH,
  formatMatchupLine,
  formatOneDecimal,
  normalizeWeekEntries,
  STANDINGS_DIVIDER,
  truncateLabel,
} from "./weekly-report.js";
import {
  longestWinStreakForSeason,
  realWeekMatchups,
  realWeekScores,
} from "./milestones.js";

// winners_bracket is a meaningless placeholder until the regular season is
// fully complete (confirmed against the live league: pre-season it already
// returns a fully-shaped bracket with nonsense roster ids) -- every caller
// must check this before trusting anything read from that endpoint.
export function isBracketTrustworthy(
  latestCompletedRegularSeasonWeek,
  regularSeasonEndWeek
) {
  return latestCompletedRegularSeasonWeek >= regularSeasonEndWeek;
}

// findLatestCompletedWeek always scans from week 1, which chokes on the bye
// week noise (matchup_id: null) in weeks 15+ if misapplied -- playoff pollers
// only ever need "is *this* specific week done," hence a dedicated check.
export function isWeekScored(matchupsByWeek, week) {
  return normalizeWeekEntries(matchupsByWeek?.[week] ?? []).some(
    (entry) => entry.points > 0 && entry.matchupId > 0
  );
}

export function buildSeedAssignments(standings) {
  const bySeed = new Map();
  const seedByRosterId = new Map();
  for (const team of standings) {
    bySeed.set(team.rank, team);
    seedByRosterId.set(String(team.rosterId), team.rank);
  }
  return { bySeed, seedByRosterId };
}

export function indexBracketEntries(winnersBracket) {
  const byMatchupNumber = new Map();
  for (const entry of winnersBracket ?? []) {
    const matchupNumber = Number(entry?.m);
    if (Number.isFinite(matchupNumber)) {
      byMatchupNumber.set(matchupNumber, entry);
    }
  }
  return byMatchupNumber;
}

// Resolves one side of a winners_bracket matchup entry to a real team, or a
// recursive "Winner of (A vs B)" placeholder when the source game isn't
// decided yet. Works unchanged for the pre-season projected reveal (every
// slot past Round 1 is a placeholder) and for in-progress weeks (real names
// fill in automatically as w/l populate) -- labelFor is injected so callers
// can opt into seed-prefixed labels (bracket reveal) or plain ones (weekly
// report/recap) without branching inside the resolver itself.
export function resolveBracketSlot({ side, entry, byMatchupNumber, labelFor }) {
  const directRosterId = entry?.[side];
  if (directRosterId != null) {
    const rosterId = String(directRosterId);
    return { resolved: true, rosterId, label: labelFor(rosterId) };
  }

  const fromRef = entry?.[`${side}_from`];
  if (!fromRef) {
    return { resolved: false, rosterId: null, label: "TBD" };
  }

  const [kind] = Object.keys(fromRef);
  const sourceEntry = byMatchupNumber.get(Number(fromRef[kind]));
  if (!sourceEntry) {
    return { resolved: false, rosterId: null, label: "TBD" };
  }

  const decidedRosterId = kind === "w" ? sourceEntry.w : sourceEntry.l;
  if (decidedRosterId != null) {
    const rosterId = String(decidedRosterId);
    return { resolved: true, rosterId, label: labelFor(rosterId) };
  }

  const left = resolveBracketSlot({ side: "t1", entry: sourceEntry, byMatchupNumber, labelFor });
  const right = resolveBracketSlot({ side: "t2", entry: sourceEntry, byMatchupNumber, labelFor });
  const verb = kind === "w" ? "Winner" : "Loser";
  return { resolved: false, rosterId: null, label: `${verb} of (${left.label} vs ${right.label})` };
}

function getRoundOneEntries(winnersBracket) {
  return (winnersBracket ?? [])
    .filter((entry) => Number(entry.r) === 1)
    .sort((a, b) => Number(a.m) - Number(b.m));
}

function getRoundTwoEntries(winnersBracket) {
  return (winnersBracket ?? [])
    .filter((entry) => Number(entry.r) === 2 && entry.p == null)
    .sort((a, b) => Number(a.m) - Number(b.m));
}

export function findPlacementEntry(winnersBracket, placement) {
  return (winnersBracket ?? []).find((entry) => Number(entry.p) === placement);
}

// A seed is "on a bye" if its roster id appears as a *direct* t1/t2 value on
// a (non-placement) round-2 entry with no matching _from key for that side.
export function getByeRosterIds(winnersBracket) {
  const byes = [];
  for (const entry of getRoundTwoEntries(winnersBracket)) {
    for (const side of ["t1", "t2"]) {
      const rosterId = entry[side];
      const hasFrom = entry[`${side}_from`] != null;
      if (rosterId != null && !hasFrom) {
        byes.push(String(rosterId));
      }
    }
  }
  return byes;
}

function buildLabelLookup(standings) {
  return new Map((standings ?? []).map((team) => [String(team.rosterId), team]));
}

function resolveLeagueName(league) {
  return String(league?.name ?? "League").trim() || "League";
}

function formatRecordFor(team) {
  if (!team) {
    return "";
  }
  const { wins, losses, ties } = team;
  return ties > 0 ? `(${wins}-${losses}-${ties})` : `(${wins}-${losses})`;
}

// Looks up both rosters' real scores for a week directly by roster id
// (rather than via groupWeekEntriesByMatchup's matchup_id pairing), since the
// two roster ids are already known unambiguously from the bracket itself.
function describeGameResult(matchupsByWeek, week, rosterIdA, labelA, rosterIdB, labelB) {
  const entries = normalizeWeekEntries(matchupsByWeek?.[week] ?? []);
  const entryA = entries.find((entry) => entry.rosterId === String(rosterIdA));
  const entryB = entries.find((entry) => entry.rosterId === String(rosterIdB));
  if (!entryA || !entryB) {
    return null;
  }

  const isTie = Math.abs(entryA.points - entryB.points) < 0.0001;
  const winnerIsA = entryA.points >= entryB.points;
  const margin = Math.abs(entryA.points - entryB.points);

  return {
    winnerRosterId: winnerIsA ? rosterIdA : rosterIdB,
    loserRosterId: winnerIsA ? rosterIdB : rosterIdA,
    winnerPoints: winnerIsA ? entryA.points : entryB.points,
    loserPoints: winnerIsA ? entryB.points : entryA.points,
    margin,
    isTie,
    textLine: formatMatchupLine({
      winner: winnerIsA ? labelA : labelB,
      loser: winnerIsA ? labelB : labelA,
      margin,
      isTie,
    }),
  };
}

function describeFromRef(fromRef, letterByMatchupNumber) {
  if (!fromRef) {
    return "TBD";
  }
  const [kind] = Object.keys(fromRef);
  const letter = letterByMatchupNumber.get(Number(fromRef[kind])) ?? "?";
  const verb = kind === "w" ? "Winner" : "Loser";
  return `${verb} of Game ${letter}`;
}

export function buildPlayoffBracketReveal({ league, standings, winnersBracket, playoffWeekStart }) {
  if (!Array.isArray(winnersBracket) || winnersBracket.length === 0) {
    return null;
  }

  const round1Entries = getRoundOneEntries(winnersBracket);
  if (round1Entries.length === 0) {
    return null;
  }

  const teamByRosterId = buildLabelLookup(standings);
  const { bySeed, seedByRosterId } = buildSeedAssignments(standings);
  const labelFor = (rosterId) => teamByRosterId.get(String(rosterId))?.label ?? `Roster ${rosterId}`;
  const seededLabelFor = (rosterId) => {
    const seed = seedByRosterId.get(String(rosterId));
    return seed ? `Seed ${seed} ${labelFor(rosterId)}` : labelFor(rosterId);
  };

  const byMatchupNumber = indexBracketEntries(winnersBracket);
  const byeRosterIds = getByeRosterIds(winnersBracket);
  const totalPlayoffTeams = byeRosterIds.length + round1Entries.length * 2;

  const seedLines = [];
  for (let seed = 1; seed <= totalPlayoffTeams; seed += 1) {
    const team = bySeed.get(seed);
    if (!team) {
      continue;
    }
    const isBye = byeRosterIds.includes(String(team.rosterId));
    const label = truncateLabel(team.label, DEFAULT_TEAM_NAME_MAX_LENGTH);
    seedLines.push(`Seed ${seed}: ${label} ${formatRecordFor(team)}${isBye ? " — BYE" : ""}`);
  }

  const round1Lines = round1Entries.map(
    (entry) => `${seededLabelFor(entry.t1)} vs. ${seededLabelFor(entry.t2)}`
  );

  const round2Entries = getRoundTwoEntries(winnersBracket);
  const letterByMatchupNumber = new Map();
  const round2Lines = round2Entries.map((entry, index) => {
    const letter = String.fromCharCode(65 + index);
    letterByMatchupNumber.set(Number(entry.m), letter);
    const teamA = resolveBracketSlot({ side: "t1", entry, byMatchupNumber, labelFor: seededLabelFor });
    const teamB = resolveBracketSlot({ side: "t2", entry, byMatchupNumber, labelFor: seededLabelFor });
    return `Game ${letter}: ${teamA.label} vs. ${teamB.label}`;
  });

  const placement5Entry = findPlacementEntry(winnersBracket, 5);
  let placementLine = null;
  if (placement5Entry) {
    const teamA = resolveBracketSlot({ side: "t1", entry: placement5Entry, byMatchupNumber, labelFor: seededLabelFor });
    const teamB = resolveBracketSlot({ side: "t2", entry: placement5Entry, byMatchupNumber, labelFor: seededLabelFor });
    placementLine = `5th/6th Place: ${teamA.label} vs. ${teamB.label}`;
  }

  const champEntry = findPlacementEntry(winnersBracket, 1);
  const thirdEntry = findPlacementEntry(winnersBracket, 3);
  const champLine = champEntry
    ? `Championship: ${describeFromRef(champEntry.t1_from, letterByMatchupNumber)} vs. ${describeFromRef(champEntry.t2_from, letterByMatchupNumber)}`
    : null;
  const thirdLine = thirdEntry
    ? `3rd Place: ${describeFromRef(thirdEntry.t1_from, letterByMatchupNumber)} vs. ${describeFromRef(thirdEntry.t2_from, letterByMatchupNumber)}`
    : null;

  const report = {
    leagueName: resolveLeagueName(league),
    totalPlayoffTeams,
    seedLines,
    round1Week: playoffWeekStart,
    round1Lines,
    round2Week: playoffWeekStart + 1,
    round2Lines,
    placementLine,
    round3Week: playoffWeekStart + 2,
    champLine,
    thirdLine,
  };
  report.textMessage = formatPlayoffBracketRevealMessage(report);
  return report;
}

export function formatPlayoffBracketRevealMessage({
  leagueName,
  totalPlayoffTeams,
  seedLines,
  round1Week,
  round1Lines,
  round2Week,
  round2Lines,
  placementLine,
  round3Week,
  champLine,
  thirdLine,
}) {
  const headerLine = `🏆 ${leagueName} Playoff Bracket`;
  const divider = "—".repeat(Math.max(STANDINGS_DIVIDER.length, headerLine.length - 15));

  const lines = [
    headerLine,
    divider,
    "",
    `${totalPlayoffTeams} teams, 3 rounds. Round 1 kicks off Week ${round1Week}.`,
    "",
    ...seedLines,
    "",
    `Round 1 (Week ${round1Week})`,
    ...round1Lines,
    "",
    `Round 2 (Week ${round2Week}, projected)`,
    ...round2Lines,
  ];

  if (placementLine) {
    lines.push(placementLine);
  }

  lines.push("", `Round 3 (Week ${round3Week}, projected)`);
  if (champLine) {
    lines.push(champLine);
  }
  if (thirdLine) {
    lines.push(thirdLine);
  }

  return lines.join("\n");
}

export function buildWeeklyPlayoffReport({ league, standings, winnersBracket, matchupsByWeek, displayWeek, playoffWeekStart }) {
  if (!Array.isArray(winnersBracket) || winnersBracket.length === 0) {
    return null;
  }

  const round1Week = playoffWeekStart;
  const round2Week = playoffWeekStart + 1;
  const round3Week = playoffWeekStart + 2;
  if (![round1Week, round2Week, round3Week].includes(displayWeek)) {
    return null;
  }

  const teamByRosterId = buildLabelLookup(standings);
  const labelFor = (rosterId) => teamByRosterId.get(String(rosterId))?.label ?? `Roster ${rosterId}`;
  const byMatchupNumber = indexBracketEntries(winnersBracket);
  const round1Entries = getRoundOneEntries(winnersBracket);
  const round2Entries = getRoundTwoEntries(winnersBracket);
  const placement5Entry = findPlacementEntry(winnersBracket, 5);
  const champEntry = findPlacementEntry(winnersBracket, 1);
  const thirdEntry = findPlacementEntry(winnersBracket, 3);

  const sections = [];

  if (displayWeek === round1Week) {
    const byeRosterIds = getByeRosterIds(winnersBracket);
    if (byeRosterIds.length > 0) {
      sections.push({ heading: "On a Bye", lines: byeRosterIds.map((rosterId) => labelFor(rosterId)) });
    }
    sections.push({
      heading: "Round 1",
      lines: round1Entries.map(
        (entry) => `${labelFor(entry.t1)} ${formatRecordFor(teamByRosterId.get(String(entry.t1)))} vs. ${labelFor(entry.t2)} ${formatRecordFor(teamByRosterId.get(String(entry.t2)))}`
      ),
    });
  }

  if (displayWeek === round2Week) {
    const round1Results = round1Entries
      .map((entry) => describeGameResult(matchupsByWeek, round1Week, entry.t1, labelFor(entry.t1), entry.t2, labelFor(entry.t2)))
      .filter(Boolean);
    if (round1Results.length > 0) {
      sections.push({ heading: "Round 1 Results", lines: round1Results.map((result) => result.textLine) });
    }

    const semiLines = round2Entries.map((entry) => {
      const teamA = resolveBracketSlot({ side: "t1", entry, byMatchupNumber, labelFor });
      const teamB = resolveBracketSlot({ side: "t2", entry, byMatchupNumber, labelFor });
      return `${teamA.label} vs. ${teamB.label}`;
    });
    if (semiLines.length > 0) {
      sections.push({ heading: "Round 2 Semifinals (this week)", lines: semiLines });
    }

    if (placement5Entry) {
      const teamA = resolveBracketSlot({ side: "t1", entry: placement5Entry, byMatchupNumber, labelFor });
      const teamB = resolveBracketSlot({ side: "t2", entry: placement5Entry, byMatchupNumber, labelFor });
      sections.push({ heading: "5th/6th Place Game (this week)", lines: [`${teamA.label} vs. ${teamB.label}`] });
    }
  }

  if (displayWeek === round3Week) {
    const semiResults = round2Entries
      .map((entry) => {
        const teamA = resolveBracketSlot({ side: "t1", entry, byMatchupNumber, labelFor });
        const teamB = resolveBracketSlot({ side: "t2", entry, byMatchupNumber, labelFor });
        return describeGameResult(matchupsByWeek, round2Week, teamA.rosterId, teamA.label, teamB.rosterId, teamB.label);
      })
      .filter(Boolean);

    const resultLines = semiResults.map((result) => result.textLine);

    if (placement5Entry) {
      const teamA = resolveBracketSlot({ side: "t1", entry: placement5Entry, byMatchupNumber, labelFor });
      const teamB = resolveBracketSlot({ side: "t2", entry: placement5Entry, byMatchupNumber, labelFor });
      const placementResult = describeGameResult(matchupsByWeek, round2Week, teamA.rosterId, teamA.label, teamB.rosterId, teamB.label);
      if (placementResult) {
        resultLines.push(`${placementResult.textLine} (5th Place)`);
      }
    }

    if (resultLines.length > 0) {
      sections.push({ heading: "Round 2 Results", lines: resultLines });
    }

    if (semiResults.length === 2) {
      const [gameA, gameB] = semiResults;
      sections.push({
        heading: null,
        lines: [
          `🏆 ${labelFor(gameA.winnerRosterId)} and ${labelFor(gameB.winnerRosterId)} are headed to the Championship!`,
          `🥉 ${labelFor(gameA.loserRosterId)} and ${labelFor(gameB.loserRosterId)} will play for 3rd Place.`,
        ],
      });
    }

    if (champEntry) {
      const teamA = resolveBracketSlot({ side: "t1", entry: champEntry, byMatchupNumber, labelFor });
      const teamB = resolveBracketSlot({ side: "t2", entry: champEntry, byMatchupNumber, labelFor });
      sections.push({ heading: "Championship (this week)", lines: [`${teamA.label} vs. ${teamB.label}`] });
    }

    if (thirdEntry) {
      const teamA = resolveBracketSlot({ side: "t1", entry: thirdEntry, byMatchupNumber, labelFor });
      const teamB = resolveBracketSlot({ side: "t2", entry: thirdEntry, byMatchupNumber, labelFor });
      sections.push({ heading: "3rd Place Game (this week)", lines: [`${teamA.label} vs. ${teamB.label}`] });
    }
  }

  if (sections.length === 0) {
    return null;
  }

  const report = { leagueName: resolveLeagueName(league), week: displayWeek, sections };
  report.textMessage = formatWeeklyPlayoffReportMessage(report);
  return report;
}

export function formatWeeklyPlayoffReportMessage({ leagueName, week, sections }) {
  const headerLine = `🏈 ${leagueName} Week ${week} Playoffs`;
  const divider = "—".repeat(Math.max(STANDINGS_DIVIDER.length, headerLine.length - 15));
  const blocks = sections.map((section) =>
    section.heading ? `${section.heading}\n${section.lines.join("\n")}` : section.lines.join("\n")
  );

  return [headerLine, divider, "", blocks.join("\n\n")].join("\n");
}

export function buildChampionshipRecap({ league, standings, winnersBracket, matchupsByWeek, playoffWeekStart }) {
  if (!Array.isArray(winnersBracket) || winnersBracket.length === 0) {
    return null;
  }

  const round3Week = playoffWeekStart + 2;
  const teamByRosterId = buildLabelLookup(standings);
  const labelFor = (rosterId) => teamByRosterId.get(String(rosterId))?.label ?? `Roster ${rosterId}`;
  const byMatchupNumber = indexBracketEntries(winnersBracket);

  const champEntry = findPlacementEntry(winnersBracket, 1);
  if (!champEntry) {
    return null;
  }

  const champA = resolveBracketSlot({ side: "t1", entry: champEntry, byMatchupNumber, labelFor });
  const champB = resolveBracketSlot({ side: "t2", entry: champEntry, byMatchupNumber, labelFor });
  const champResult = describeGameResult(matchupsByWeek, round3Week, champA.rosterId, champA.label, champB.rosterId, champB.label);
  if (!champResult) {
    return null;
  }

  let thirdResult = null;
  const thirdEntry = findPlacementEntry(winnersBracket, 3);
  if (thirdEntry) {
    const thirdA = resolveBracketSlot({ side: "t1", entry: thirdEntry, byMatchupNumber, labelFor });
    const thirdB = resolveBracketSlot({ side: "t2", entry: thirdEntry, byMatchupNumber, labelFor });
    thirdResult = describeGameResult(matchupsByWeek, round3Week, thirdA.rosterId, thirdA.label, thirdB.rosterId, thirdB.label);
  }

  const report = {
    leagueName: resolveLeagueName(league),
    championLine: `🥇 ${labelFor(champResult.winnerRosterId)} is your champion! (${formatOneDecimal(champResult.winnerPoints)} - ${formatOneDecimal(champResult.loserPoints)} over ${labelFor(champResult.loserRosterId)})`,
    thirdLine: thirdResult ? `🥉 3rd Place: ${thirdResult.textLine}` : null,
  };
  report.textMessage = formatChampionshipRecapMessage(report);
  return report;
}

export function formatChampionshipRecapMessage({ leagueName, championLine, thirdLine }) {
  const headerLine = `🏆 ${leagueName} Champion`;
  const divider = "—".repeat(Math.max(STANDINGS_DIVIDER.length, headerLine.length - 15));
  const lines = [headerLine, divider, "", championLine];

  if (thirdLine) {
    lines.push("", thirdLine);
  }

  return lines.join("\n");
}

export function buildSeasonRecap({ league, standings, winnersBracket, matchupsByWeek, playoffWeekStart, lastPlayoffWeek }) {
  if (!Array.isArray(winnersBracket) || winnersBracket.length === 0) {
    return null;
  }

  const round2Week = playoffWeekStart + 1;
  const round3Week = playoffWeekStart + 2;
  const teamByRosterId = buildLabelLookup(standings);
  const labelFor = (rosterId) => teamByRosterId.get(String(rosterId))?.label ?? `Roster ${rosterId}`;
  const byMatchupNumber = indexBracketEntries(winnersBracket);

  const champEntry = findPlacementEntry(winnersBracket, 1);
  if (!champEntry) {
    return null;
  }

  const resolvedPair = (entry) => [
    resolveBracketSlot({ side: "t1", entry, byMatchupNumber, labelFor }),
    resolveBracketSlot({ side: "t2", entry, byMatchupNumber, labelFor }),
  ];

  const [champA, champB] = resolvedPair(champEntry);
  const champResult = describeGameResult(matchupsByWeek, round3Week, champA.rosterId, champA.label, champB.rosterId, champB.label);
  if (!champResult) {
    return null;
  }

  const finalOrder = [
    { place: 1, rosterId: champResult.winnerRosterId },
    { place: 2, rosterId: champResult.loserRosterId },
  ];

  const thirdEntry = findPlacementEntry(winnersBracket, 3);
  if (thirdEntry) {
    const [thirdA, thirdB] = resolvedPair(thirdEntry);
    const thirdResult = describeGameResult(matchupsByWeek, round3Week, thirdA.rosterId, thirdA.label, thirdB.rosterId, thirdB.label);
    if (thirdResult) {
      finalOrder.push({ place: 3, rosterId: thirdResult.winnerRosterId });
      finalOrder.push({ place: 4, rosterId: thirdResult.loserRosterId });
    }
  }

  const placement5Entry = findPlacementEntry(winnersBracket, 5);
  if (placement5Entry) {
    const [fifthA, fifthB] = resolvedPair(placement5Entry);
    const placementResult = describeGameResult(matchupsByWeek, round2Week, fifthA.rosterId, fifthA.label, fifthB.rosterId, fifthB.label);
    if (placementResult) {
      finalOrder.push({ place: 5, rosterId: placementResult.winnerRosterId });
      finalOrder.push({ place: 6, rosterId: placementResult.loserRosterId });
    }
  }

  const placedRosterIds = new Set(finalOrder.map((entry) => String(entry.rosterId)));
  const remainingBySeed = (standings ?? [])
    .filter((team) => !placedRosterIds.has(String(team.rosterId)))
    .sort((a, b) => a.rank - b.rank);

  let nextPlace = finalOrder.length + 1;
  for (const team of remainingBySeed) {
    finalOrder.push({ place: nextPlace, rosterId: team.rosterId });
    nextPlace += 1;
  }

  const standingsLines = finalOrder.map(({ place, rosterId }) => {
    const team = teamByRosterId.get(String(rosterId));
    const label = truncateLabel(labelFor(rosterId), DEFAULT_TEAM_NAME_MAX_LENGTH);
    if (place === 1) {
      return `${place}. ${label} (Champion)`;
    }
    if (place === 2) {
      return `${place}. ${label} (Runner-up)`;
    }
    if (place <= 6) {
      return `${place}. ${label}`;
    }
    return `${place}. ${label} ${formatRecordFor(team)}`;
  });

  let highest = null;
  let lowest = null;
  let biggestBlowout = null;
  for (let week = 1; week <= lastPlayoffWeek; week += 1) {
    for (const entry of realWeekScores(matchupsByWeek, week)) {
      if (!highest || entry.points > highest.points) {
        highest = { ...entry, week };
      }
      if (!lowest || entry.points < lowest.points) {
        lowest = { ...entry, week };
      }
    }
    for (const matchup of realWeekMatchups(matchupsByWeek, week)) {
      if (!biggestBlowout || matchup.margin > biggestBlowout.margin) {
        biggestBlowout = { ...matchup, week };
      }
    }
  }

  const streak = longestWinStreakForSeason(matchupsByWeek, lastPlayoffWeek, labelFor);

  const report = {
    leagueName: resolveLeagueName(league),
    standingsLines,
    highestSuperlative: highest
      ? { label: truncateLabel(labelFor(highest.rosterId), DEFAULT_TEAM_NAME_MAX_LENGTH), points: highest.points, week: highest.week }
      : null,
    lowestSuperlative: lowest
      ? { label: truncateLabel(labelFor(lowest.rosterId), DEFAULT_TEAM_NAME_MAX_LENGTH), points: lowest.points, week: lowest.week }
      : null,
    blowoutSuperlative: biggestBlowout
      ? {
          winnerLabel: truncateLabel(labelFor(biggestBlowout.winnerRosterId), DEFAULT_TEAM_NAME_MAX_LENGTH),
          loserLabel: truncateLabel(labelFor(biggestBlowout.loserRosterId), DEFAULT_TEAM_NAME_MAX_LENGTH),
          margin: biggestBlowout.margin,
          week: biggestBlowout.week,
        }
      : null,
    streak: streak ? { ...streak, label: truncateLabel(streak.label, DEFAULT_TEAM_NAME_MAX_LENGTH) } : null,
  };
  report.textMessage = formatSeasonRecapMessage(report);
  return report;
}

export function formatSeasonRecapMessage({ leagueName, standingsLines, highestSuperlative, lowestSuperlative, blowoutSuperlative, streak }) {
  const lines = ["", "", `📋 ${leagueName} Final Standings — Season Recap`, "", ...standingsLines];

  const superlativeLines = [];
  if (highestSuperlative) {
    superlativeLines.push(`🔥 Highest Score: ${highestSuperlative.label} — ${formatOneDecimal(highestSuperlative.points)} (Wk ${highestSuperlative.week})`);
  }
  if (lowestSuperlative) {
    superlativeLines.push(`🧊 Lowest Score: ${lowestSuperlative.label} — ${formatOneDecimal(lowestSuperlative.points)} (Wk ${lowestSuperlative.week})`);
  }
  if (blowoutSuperlative) {
    superlativeLines.push(`💥 Biggest Blowout: ${blowoutSuperlative.winnerLabel} def. ${blowoutSuperlative.loserLabel} by ${formatOneDecimal(blowoutSuperlative.margin)} (Wk ${blowoutSuperlative.week})`);
  }
  if (streak) {
    superlativeLines.push(`🏃 Longest Win Streak: ${streak.label} — ${streak.length} games`);
  }

  if (superlativeLines.length > 0) {
    lines.push("", "Season Superlatives", ...superlativeLines);
  }

  return lines.join("\n");
}
