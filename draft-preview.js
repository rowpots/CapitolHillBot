import {
  buildRosterLookup,
  buildUserLookup,
  DEFAULT_TEAM_NAME_MAX_LENGTH,
  formatRosterLabel,
  STANDINGS_DIVIDER,
  truncateLabel,
} from "./weekly-report.js";

const TOP_ROOKIE_COUNT = 12;

// One-shot countdown gate, not a weekday/hour-of-day gate like the other
// features — kept here instead of weekly-report.js since nothing else needs it.
export function isWithinDraftPreviewWindow(nowMs, startTimeMs, leadHours) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(startTimeMs)) {
    return false;
  }

  const leadMs = Math.max(0, Number(leadHours) || 0) * 60 * 60 * 1000;
  return nowMs >= startTimeMs - leadMs && nowMs < startTimeMs;
}

// slot_to_roster_id only reflects the *originally assigned* roster for each
// slot. Pick trading is on in this league, so a slot's real current owner has
// to be cross-checked against traded_picks (round + season + roster_id ->
// owner_id) before it's safe to show as the actual Round 1 order.
export function resolveRoundOneOrder({ draft, rosters, users, tradedPicks }) {
  const slotToRosterId = draft?.slot_to_roster_id ?? {};
  const slots = Object.keys(slotToRosterId)
    .map((slot) => Number(slot))
    .filter((slot) => Number.isFinite(slot))
    .sort((a, b) => a - b);

  if (slots.length === 0) {
    return [];
  }

  const rosterLookup = buildRosterLookup(rosters);
  const userLookup = buildUserLookup(users);
  const season = String(draft?.season ?? "").trim();

  const currentOwnerByOriginalRoster = new Map(
    (tradedPicks ?? [])
      .filter((pick) => Number(pick.round) === 1 && String(pick.season) === season)
      .map((pick) => [String(pick.roster_id), pick.owner_id])
  );

  return slots.map((slot) => {
    const originalRosterId = String(slotToRosterId[slot]);
    const currentRosterId = String(
      currentOwnerByOriginalRoster.get(originalRosterId) ?? originalRosterId
    );
    return {
      slot,
      label: formatRosterLabel(currentRosterId, rosterLookup, userLookup),
    };
  });
}

// years_exp === 0 alone also matches long-retired players whose historical
// records never got the field populated (e.g. Kurt Warner) — active === true
// is what actually narrows this down to the real current draft class.
export function selectTopAvailableRookies({
  playersById,
  valueBook,
  rosters,
  limit = TOP_ROOKIE_COUNT,
}) {
  if (!playersById || !valueBook) {
    return [];
  }

  const rosteredPlayerIds = new Set();
  for (const roster of rosters ?? []) {
    for (const playerId of [...(roster.players ?? []), ...(roster.taxi ?? [])]) {
      rosteredPlayerIds.add(String(playerId));
    }
  }

  const candidates = [];
  for (const [playerId, player] of Object.entries(playersById)) {
    if (player?.years_exp !== 0 || player?.active !== true) {
      continue;
    }

    if (rosteredPlayerIds.has(String(playerId))) {
      continue;
    }

    const value = valueBook.getPlayerValue(player);
    if (value == null) {
      continue;
    }

    candidates.push({
      name:
        player.full_name || [player.first_name, player.last_name].filter(Boolean).join(" "),
      position: player.position ?? "",
      team: player.team ?? "FA",
      value,
    });
  }

  candidates.sort((a, b) => b.value - a.value);
  return candidates.slice(0, limit);
}

export function buildDraftPreviewReport({
  league,
  draft,
  rosters,
  users,
  tradedPicks,
  playersById,
  valueBook,
}) {
  const roundOneOrder = resolveRoundOneOrder({ draft, rosters, users, tradedPicks });
  if (roundOneOrder.length === 0) {
    return null;
  }

  const topRookies = selectTopAvailableRookies({ playersById, valueBook, rosters });
  const leagueName = String(league?.name ?? "League").trim() || "League";
  const totalRounds = Number(draft?.settings?.rounds) || 0;
  const totalPicks = totalRounds * roundOneOrder.length;
  const startTimeMs = Number(draft?.start_time);

  const report = {
    leagueName,
    draftId: draft?.draft_id ?? null,
    startTimeMs: Number.isFinite(startTimeMs) ? startTimeMs : null,
    totalRounds,
    totalPicks,
    roundOneOrder,
    topRookies,
  };
  report.textMessage = formatDraftPreviewMessage(report);
  return report;
}

function formatDraftStartTime(startTimeMs) {
  if (!Number.isFinite(startTimeMs)) {
    return "soon";
  }

  return (
    new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/New_York",
    }).format(new Date(startTimeMs)) + " ET"
  );
}

export function formatDraftPreviewMessage({
  leagueName,
  startTimeMs,
  totalRounds,
  totalPicks,
  roundOneOrder,
  topRookies,
}) {
  const headerLine = `🎓 ${leagueName} Rookie Draft Preview`;
  // Sized off the header length, trimmed back — a divider matching the full
  // header wraps to a second line on mobile (same fix as the other features).
  const divider = "—".repeat(Math.max(STANDINGS_DIVIDER.length, headerLine.length - 15));

  const lines = [
    headerLine,
    divider,
    "",
    `Draft kicks off ${formatDraftStartTime(startTimeMs)} — ${totalRounds} round${
      totalRounds === 1 ? "" : "s"
    }, ${totalPicks} picks total`,
    "",
    "Round 1 Order",
    ...roundOneOrder.map(
      ({ slot, label }) => `${slot}. ${truncateLabel(label, DEFAULT_TEAM_NAME_MAX_LENGTH)}`
    ),
  ];

  if (topRookies.length > 0) {
    lines.push("");
    lines.push("🔥 Top Available Rookies");
    lines.push(
      ...topRookies.map(
        (rookie, index) => `${index + 1}. ${rookie.name} (${rookie.position}, ${rookie.team})`
      )
    );
  }

  return lines.join("\n");
}
