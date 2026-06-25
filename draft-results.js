import { buildRosterLookup, buildUserLookup, formatRosterLabel } from "./weekly-report.js";

// Pure post-draft snapshot capture — kept separate from draft-preview.js
// since it's a different lifecycle stage (post-draft vs. pre-draft), the
// same way playoffs.js separates bracket-reveal/weekly/recap by stage. This
// never sends a chat message; it only persists facts for later reuse by
// awards.js (Draft Steal/Bust needs to know what was drafted and where).
export function isDraftComplete(draft) {
  return String(draft?.status ?? "").trim() === "complete";
}

function resolvePickPlayerName(pick, playersById) {
  const metadataName = [pick?.metadata?.first_name, pick?.metadata?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (metadataName) {
    return metadataName;
  }

  const player = playersById?.[pick?.player_id];
  return (
    player?.full_name ||
    [player?.first_name, player?.last_name].filter(Boolean).join(" ") ||
    `Player ${pick?.player_id}`
  );
}

function resolvePickPosition(pick, playersById) {
  return pick?.metadata?.position || playersById?.[pick?.player_id]?.position || "";
}

export function buildDraftResultsSnapshot({ league, draft, picks, rosters, users, playersById }) {
  const rosterLookup = buildRosterLookup(rosters);
  const userLookup = buildUserLookup(users);

  const sortedPicks = [...(picks ?? [])].sort(
    (a, b) => (Number(a?.pick_no) || 0) - (Number(b?.pick_no) || 0)
  );

  return {
    draftId: draft?.draft_id ?? null,
    season: String(league?.season ?? "").trim() || null,
    leagueId: league?.league_id ?? null,
    snapshotAt: new Date().toISOString(),
    picks: sortedPicks.map((pick) => {
      const rosterId = String(pick?.roster_id ?? "");
      return {
        pickNo: Number(pick?.pick_no) || 0,
        round: Number(pick?.round) || 0,
        rosterId,
        ownerLabel: formatRosterLabel(rosterId, rosterLookup, userLookup),
        playerId: pick?.player_id != null ? String(pick.player_id) : null,
        playerName: resolvePickPlayerName(pick, playersById),
        position: resolvePickPosition(pick, playersById),
      };
    }),
  };
}
