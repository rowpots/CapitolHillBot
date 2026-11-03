// Trade-analysis engine: turns a Sleeper trade transaction into the per-team
// ledger, grades, verdict/roast, and text post. Moved out of index.js unchanged
// except that the roast settings arrive via options instead of the global config
// (the poller, delivery, and trade-history I/O stay in index.js). Pure apart
// from a console.warn when one trade fails to grade; the grading math lives in
// trade-grading.js and is shared with the `!trade` command.
import { getRoastForSeverity } from "./roast-templates.js";
import { gradeSwap } from "./trade-grading.js";
import { formatRosterLabel } from "./weekly-report.js";

const VERDICT_EPSILON = 100;
// Graded for every trade (not just newly-discovered ones) so the persisted
// trade-history log always carries up-to-date grades for awards/recap use,
// not just whatever was in scope at notification time. A trade that fails to
// grade this cycle (e.g. valueBook unavailable) is simply absent from the map
// and self-heals next poll, since saveTradeHistoryLog rebuilds from scratch
// every cycle against the same full trade list.
export function buildTradeAnalysisByTransactionId(trades, options) {
  const analysisByTransactionId = new Map();

  for (const trade of trades) {
    try {
      analysisByTransactionId.set(
        String(trade.transaction_id),
        buildTradeAnalysis(trade, { ...options, allTrades: trades })
      );
    } catch (error) {
      console.warn(`Unable to grade trade ${trade.transaction_id} this cycle.`);
      console.warn(error.message);
    }
  }

  return analysisByTransactionId;
}

export function buildTradeAnalysis(
  trade,
  {
    allTrades,
    league,
    playersById,
    rosterLookup,
    userLookup,
    valueBook,
    totalRosters,
    roastMode,
    roastThreshold,
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
    // Piece counts drive the consolidation premium, so only assets we can
    // actually value should count — an ungraded throw-in must not inflate the
    // gap and buy a bonus.
    const sentCount = countKnownValueAssets(sentAssets);
    const receivedCount = countKnownValueAssets(receivedAssets);
    const {
      receivedConsolidationBonus,
      sentConsolidationBonus,
      rawNetValue,
      netValue,
      ...gradeData
    } = gradeSwap({ sentValue, receivedValue, sentCount, receivedCount, knownValueCount });

    return {
      rosterId,
      label: formatRosterLabel(rosterId, rosterLookup, userLookup),
      sentAssets,
      receivedAssets,
      sentValue,
      receivedValue,
      receivedConsolidationBonus,
      sentConsolidationBonus,
      rawNetValue,
      netValue,
      unknownAssetCount,
      knownValueCount,
      grade: gradeData.grade,
      gradeFlavor: gradeData.gradeFlavor,
      gradeLabel: gradeData.gradeLabel,
      gradeScore: gradeData.score,
    };
  });

  const verdict = buildVerdict(teams, valueBook, { roastMode, roastThreshold });
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

function buildVerdict(teams, valueBook, roast) {
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
    roastText: buildRoastText(teams, winner, anyUnknownValues, roast),
    winnerRosterIds,
  };
}

function buildRoastText(teams, winner, anyUnknownValues, { roastMode, roastThreshold }) {
  if (
    !roastMode ||
    anyUnknownValues ||
    teams.length !== 2 ||
    winner.netValue < roastThreshold
  ) {
    return null;
  }

  const loser = teams.find((team) => team.rosterId !== winner.rosterId);
  if (!loser) {
    return null;
  }

  const severity =
    winner.netValue >= roastThreshold * 4
      ? "severe"
      : winner.netValue >= roastThreshold * 2
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
  // Surface the consolidation premium rather than folding it silently into the
  // net, so a fair-looking grade on a lopsided-looking pile is explainable.
  const consolidationSuffix = (bonus) =>
    bonus ? ` (${formatSignedValue(bonus)} consolidation)` : "";
  const pieces = [
    `${team.unknownAssetCount ? "Known sent" : "Sent"} ${formatValue(
      team.sentValue
    )}${consolidationSuffix(team.sentConsolidationBonus)}`,
    `${team.unknownAssetCount ? "Known received" : "Received"} ${formatValue(
      team.receivedValue
    )}${consolidationSuffix(team.receivedConsolidationBonus)}`,
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
    section += `\n\nVerdict: ${team.gradeLabel ?? team.grade}`;

    sections.push(section);
  }

  return sections.join("\n\n");
}

export function buildTradeHistoryContext(allTrades, currentTrade, rosterLookup, userLookup) {
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

export function getTradeRosterIds(trade) {
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

export function formatTimestamp(value) {
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
