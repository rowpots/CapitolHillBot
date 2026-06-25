import {
  buildRosterLookup,
  buildUserLookup,
  computeAllPlayWinPct,
  DEFAULT_TEAM_NAME_MAX_LENGTH,
  formatOneDecimal,
  formatRosterLabel,
  groupWeekEntriesByMatchup,
  normalizeWeekEntries,
  STANDINGS_DIVIDER,
  truncateLabel,
} from "./weekly-report.js";
import { collectAllStarterPerformances, findTopPerformances } from "./player-points.js";

// Mirrors milestones.js's MIN_STREAK_RECORD guard -- a short/irregular split
// (bye weeks, missed games) shouldn't crown a Most Improved/Luckiest
// "winner" off a couple of garbage-time games.
const MIN_GAMES_FOR_AWARD = 4;

function computeRecordByRosterId(matchupsByWeek, rosters, startWeek, endWeek) {
  const recordByRosterId = new Map(
    (rosters ?? []).map((roster) => [
      String(roster.roster_id),
      { wins: 0, losses: 0, ties: 0, gamesPlayed: 0 },
    ])
  );

  for (let week = startWeek; week <= endWeek; week += 1) {
    const entries = normalizeWeekEntries(matchupsByWeek?.[week] ?? []);
    const grouped = groupWeekEntriesByMatchup(entries);

    for (const pair of grouped.values()) {
      if (pair.length !== 2) {
        continue;
      }

      const [left, right] = pair;
      const leftRecord = recordByRosterId.get(left.rosterId);
      const rightRecord = recordByRosterId.get(right.rosterId);
      if (!leftRecord || !rightRecord) {
        continue;
      }

      leftRecord.gamesPlayed += 1;
      rightRecord.gamesPlayed += 1;

      const difference = left.points - right.points;
      if (Math.abs(difference) < 0.0001) {
        leftRecord.ties += 1;
        rightRecord.ties += 1;
      } else if (difference > 0) {
        leftRecord.wins += 1;
        rightRecord.losses += 1;
      } else {
        rightRecord.wins += 1;
        leftRecord.losses += 1;
      }
    }
  }

  for (const record of recordByRosterId.values()) {
    record.winPct =
      record.gamesPlayed > 0 ? (record.wins + record.ties * 0.5) / record.gamesPlayed : null;
  }

  return recordByRosterId;
}

function computeMostImprovedAndCollapse({
  matchupsByWeek,
  rosters,
  rosterLookup,
  userLookup,
  splitWeek,
  regularSeasonEndWeek,
}) {
  const firstHalf = computeRecordByRosterId(matchupsByWeek, rosters, 1, splitWeek);
  const secondHalf = computeRecordByRosterId(
    matchupsByWeek,
    rosters,
    splitWeek + 1,
    regularSeasonEndWeek
  );

  const deltas = [];
  for (const [rosterId, second] of secondHalf.entries()) {
    const first = firstHalf.get(rosterId);
    if (
      !first ||
      first.gamesPlayed < MIN_GAMES_FOR_AWARD ||
      second.gamesPlayed < MIN_GAMES_FOR_AWARD ||
      first.winPct == null ||
      second.winPct == null
    ) {
      continue;
    }

    deltas.push({
      rosterId,
      label: formatRosterLabel(rosterId, rosterLookup, userLookup),
      delta: second.winPct - first.winPct,
      firstWinPct: first.winPct,
      secondWinPct: second.winPct,
    });
  }

  if (deltas.length === 0) {
    return { mostImproved: null, biggestCollapse: null };
  }

  const sorted = [...deltas].sort((a, b) => b.delta - a.delta);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  return {
    mostImproved: best.delta > 0 ? best : null,
    biggestCollapse: worst.delta < 0 ? worst : null,
  };
}

function computeLuckAwards({
  matchupsByWeek,
  rosters,
  rosterLookup,
  userLookup,
  regularSeasonEndWeek,
}) {
  const actualRecordByRosterId = computeRecordByRosterId(
    matchupsByWeek,
    rosters,
    1,
    regularSeasonEndWeek
  );
  const allPlayWinPctByRosterId = computeAllPlayWinPct(matchupsByWeek, regularSeasonEndWeek);

  const gaps = [];
  for (const [rosterId, actual] of actualRecordByRosterId.entries()) {
    if (actual.gamesPlayed < MIN_GAMES_FOR_AWARD || actual.winPct == null) {
      continue;
    }

    const allPlayWinPct = allPlayWinPctByRosterId.get(rosterId);
    if (allPlayWinPct == null) {
      continue;
    }

    gaps.push({
      rosterId,
      label: formatRosterLabel(rosterId, rosterLookup, userLookup),
      gap: actual.winPct - allPlayWinPct,
      actualWinPct: actual.winPct,
      allPlayWinPct,
    });
  }

  if (gaps.length === 0) {
    return { luckiest: null, unluckiest: null };
  }

  const sorted = [...gaps].sort((a, b) => b.gap - a.gap);
  const luckiest = sorted[0];
  const unluckiest = sorted[sorted.length - 1];

  return {
    luckiest: luckiest.gap > 0 ? luckiest : null,
    unluckiest: unluckiest.gap < 0 ? unluckiest : null,
  };
}

function computeTradeAwards(tradeHistoryEntries) {
  const gradedSides = [];
  for (const entry of tradeHistoryEntries ?? []) {
    for (const side of entry.grades ?? []) {
      if (typeof side.gradeScore !== "number") {
        continue;
      }

      gradedSides.push({
        transactionId: entry.transactionId,
        rosterId: side.rosterId,
        label: side.label,
        gradeScore: side.gradeScore,
        grade: side.grade,
        netValue: side.netValue,
      });
    }
  }

  if (gradedSides.length === 0) {
    return { bestTrade: null, worstTrade: null };
  }

  const sorted = [...gradedSides].sort((a, b) => b.gradeScore - a.gradeScore);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  return {
    bestTrade: best.gradeScore > 0 ? best : null,
    worstTrade: worst.gradeScore < 0 ? worst : null,
  };
}

function resolvePlayerDisplay(playerId, playersById) {
  const player = playersById?.[playerId];
  const playerName =
    player?.full_name ||
    [player?.first_name, player?.last_name].filter(Boolean).join(" ") ||
    `Player ${playerId}`;
  return { playerName, position: player?.position ?? "" };
}

function computeBestSingleGamePerformance({
  matchupsByWeek,
  startWeek,
  endWeek,
  rosterLookup,
  userLookup,
  playersById,
}) {
  const [top] = findTopPerformances({ matchupsByWeek, startWeek, endWeek, limit: 1 });
  if (!top) {
    return null;
  }

  const { playerName, position } = resolvePlayerDisplay(top.playerId, playersById);

  return {
    week: top.week,
    rosterId: top.rosterId,
    label: formatRosterLabel(top.rosterId, rosterLookup, userLookup),
    playerId: top.playerId,
    playerName,
    position,
    points: top.points,
  };
}

// "Steal"/"bust" are framed as a rank-delta: how much better or worse a
// rookie's season-long output ranked among this draft class compared to
// where they were actually picked. A late pick who finished as a top
// performer scores a large positive delta (steal); an early pick who
// finished near the bottom scores a large negative delta (bust).
function computeDraftStealAndBust({
  draftResultsSnapshot,
  matchupsByWeek,
  startWeek,
  endWeek,
  rosterLookup,
  userLookup,
}) {
  const picks = (draftResultsSnapshot?.picks ?? []).filter((pick) => pick.playerId);
  if (picks.length === 0) {
    return { steal: null, bust: null };
  }

  const performances = collectAllStarterPerformances({ matchupsByWeek, startWeek, endWeek });
  const pointsByPlayerId = new Map();
  for (const performance of performances) {
    pointsByPlayerId.set(
      performance.playerId,
      (pointsByPlayerId.get(performance.playerId) ?? 0) + performance.points
    );
  }

  const byPickNo = [...picks].sort((a, b) => a.pickNo - b.pickNo);
  const byPoints = [...picks].sort(
    (a, b) => (pointsByPlayerId.get(b.playerId) ?? 0) - (pointsByPlayerId.get(a.playerId) ?? 0)
  );
  const performanceRankByPlayerId = new Map(
    byPoints.map((pick, index) => [pick.playerId, index + 1])
  );

  const evaluations = byPickNo.map((pick, index) => {
    const draftRank = index + 1;
    const performanceRank = performanceRankByPlayerId.get(pick.playerId) ?? draftRank;
    return {
      pickNo: pick.pickNo,
      round: pick.round,
      rosterId: pick.rosterId,
      label: formatRosterLabel(pick.rosterId, rosterLookup, userLookup),
      playerId: pick.playerId,
      playerName: pick.playerName,
      position: pick.position,
      seasonPoints: pointsByPlayerId.get(pick.playerId) ?? 0,
      draftRank,
      performanceRank,
      rankDelta: draftRank - performanceRank,
    };
  });

  const sortedByDelta = [...evaluations].sort((a, b) => b.rankDelta - a.rankDelta);
  const steal = sortedByDelta[0];
  const bust = sortedByDelta[sortedByDelta.length - 1];

  return {
    steal: steal?.rankDelta > 0 ? steal : null,
    bust: bust?.rankDelta < 0 && bust.playerId !== steal?.playerId ? bust : null,
  };
}

export function buildAwardsCeremonyReport({
  league,
  rosters,
  users,
  matchupsByWeek,
  regularSeasonEndWeek,
  fullSeasonMatchupsByWeek = matchupsByWeek,
  lastWeek = regularSeasonEndWeek,
  tradeHistoryEntries = [],
  draftResultsSnapshot = null,
  playersById = {},
}) {
  const rosterLookup = buildRosterLookup(rosters);
  const userLookup = buildUserLookup(users);
  const leagueName = String(league?.name ?? "League").trim() || "League";
  const splitWeek = Math.max(1, Math.floor(regularSeasonEndWeek / 2));

  const { mostImproved, biggestCollapse } = computeMostImprovedAndCollapse({
    matchupsByWeek,
    rosters,
    rosterLookup,
    userLookup,
    splitWeek,
    regularSeasonEndWeek,
  });
  const { luckiest, unluckiest } = computeLuckAwards({
    matchupsByWeek,
    rosters,
    rosterLookup,
    userLookup,
    regularSeasonEndWeek,
  });
  const { bestTrade, worstTrade } = computeTradeAwards(tradeHistoryEntries);
  const bestPerformance = computeBestSingleGamePerformance({
    matchupsByWeek: fullSeasonMatchupsByWeek,
    startWeek: 1,
    endWeek: lastWeek,
    rosterLookup,
    userLookup,
    playersById,
  });
  const { steal, bust } = computeDraftStealAndBust({
    draftResultsSnapshot,
    matchupsByWeek: fullSeasonMatchupsByWeek,
    startWeek: 1,
    endWeek: lastWeek,
    rosterLookup,
    userLookup,
  });

  const hasAnyAward = [
    mostImproved,
    biggestCollapse,
    luckiest,
    unluckiest,
    bestTrade,
    worstTrade,
    bestPerformance,
    steal,
    bust,
  ].some(Boolean);

  if (!hasAnyAward) {
    return null;
  }

  const report = {
    leagueName,
    mostImproved,
    biggestCollapse,
    luckiest,
    unluckiest,
    bestTrade,
    worstTrade,
    bestPerformance,
    steal,
    bust,
  };
  report.textMessage = formatAwardsCeremonyMessage(report);
  return report;
}

function formatPercent(value) {
  return `${Math.round((value ?? 0) * 100)}%`;
}

function formatPercentDelta(value) {
  const rounded = Math.round((value ?? 0) * 100);
  return rounded >= 0 ? `+${rounded}%` : `${rounded}%`;
}

function formatPlayerLine(playerName, position) {
  return position ? `${playerName} (${position})` : playerName;
}

export function formatAwardsCeremonyMessage({
  leagueName,
  mostImproved,
  biggestCollapse,
  luckiest,
  unluckiest,
  bestTrade,
  worstTrade,
  bestPerformance,
  steal,
  bust,
}) {
  const headerLine = `🏆 ${leagueName} Season Awards`;
  // Sized off the header length, trimmed back -- a divider matching the full
  // header wraps to a second line on mobile (same fix as the other features).
  const divider = "—".repeat(Math.max(STANDINGS_DIVIDER.length, headerLine.length - 15));

  const blocks = [];

  if (mostImproved) {
    blocks.push(
      `🚀 Most Improved\n${truncateLabel(
        mostImproved.label,
        DEFAULT_TEAM_NAME_MAX_LENGTH
      )} — ${formatPercentDelta(mostImproved.delta)} win rate (2nd half vs. 1st)`
    );
  }

  if (biggestCollapse) {
    blocks.push(
      `📉 Biggest Collapse\n${truncateLabel(
        biggestCollapse.label,
        DEFAULT_TEAM_NAME_MAX_LENGTH
      )} — ${formatPercentDelta(biggestCollapse.delta)} win rate (2nd half vs. 1st)`
    );
  }

  if (luckiest) {
    blocks.push(
      `🍀 Luckiest Manager\n${truncateLabel(
        luckiest.label,
        DEFAULT_TEAM_NAME_MAX_LENGTH
      )} — ${formatPercent(luckiest.actualWinPct)} record vs. ${formatPercent(
        luckiest.allPlayWinPct
      )} all-play`
    );
  }

  if (unluckiest) {
    blocks.push(
      `💀 Unluckiest Manager\n${truncateLabel(
        unluckiest.label,
        DEFAULT_TEAM_NAME_MAX_LENGTH
      )} — ${formatPercent(unluckiest.actualWinPct)} record vs. ${formatPercent(
        unluckiest.allPlayWinPct
      )} all-play`
    );
  }

  if (bestTrade) {
    blocks.push(
      `🤝 Best Trade of the Year\n${truncateLabel(
        bestTrade.label,
        DEFAULT_TEAM_NAME_MAX_LENGTH
      )} (Grade: ${bestTrade.grade})`
    );
  }

  if (worstTrade) {
    blocks.push(
      `🥴 Worst Trade of the Year\n${truncateLabel(
        worstTrade.label,
        DEFAULT_TEAM_NAME_MAX_LENGTH
      )} (Grade: ${worstTrade.grade})`
    );
  }

  if (bestPerformance) {
    blocks.push(
      `🌟 Best Single-Game Performance\n${formatPlayerLine(
        bestPerformance.playerName,
        bestPerformance.position
      )} — ${formatOneDecimal(bestPerformance.points)} pts (Week ${
        bestPerformance.week
      }, ${truncateLabel(bestPerformance.label, DEFAULT_TEAM_NAME_MAX_LENGTH)})`
    );
  }

  if (steal) {
    blocks.push(
      `💎 Draft Steal of the Year\n${formatPlayerLine(
        steal.playerName,
        steal.position
      )} — Pick ${steal.pickNo}, ${formatOneDecimal(steal.seasonPoints)} pts (${truncateLabel(
        steal.label,
        DEFAULT_TEAM_NAME_MAX_LENGTH
      )})`
    );
  }

  if (bust) {
    blocks.push(
      `🪦 Draft Bust\n${formatPlayerLine(
        bust.playerName,
        bust.position
      )} — Pick ${bust.pickNo}, ${formatOneDecimal(bust.seasonPoints)} pts (${truncateLabel(
        bust.label,
        DEFAULT_TEAM_NAME_MAX_LENGTH
      )})`
    );
  }

  return [headerLine, divider, "", blocks.join("\n\n")].join("\n");
}
