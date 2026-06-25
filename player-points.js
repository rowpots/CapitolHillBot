// Pure extraction utilities over raw Sleeper matchup entries. matchupsByWeek
// is already fetched everywhere (weekly report, power rankings, milestones,
// playoffs) but every consumer so far has only read roster_id/matchup_id/
// points off each entry — players_points (player_id -> points) and starters
// (array of started player_ids) pass through untouched. These helpers are
// the first code in the repo to read those two fields.

// Sleeper fills empty/bye starter slots with the literal string "0".
function isRealPlayerId(playerId) {
  return Boolean(playerId) && String(playerId) !== "0";
}

export function extractStarterPointsForRoster(matchupsByWeek, week, rosterId) {
  const entries = matchupsByWeek?.[week] ?? [];
  const entry = entries.find(
    (candidate) => String(candidate?.roster_id ?? "") === String(rosterId)
  );

  if (!entry) {
    return [];
  }

  const playersPoints = entry.players_points ?? {};
  return (entry.starters ?? [])
    .filter((playerId) => isRealPlayerId(playerId))
    .map((playerId) => ({
      playerId: String(playerId),
      points: Number(playersPoints[playerId]) || 0,
    }));
}

export function collectAllStarterPerformances({ matchupsByWeek, startWeek, endWeek }) {
  const performances = [];

  for (let week = startWeek; week <= endWeek; week += 1) {
    const entries = matchupsByWeek?.[week] ?? [];
    for (const entry of entries) {
      const rosterId = String(entry?.roster_id ?? "");
      if (!rosterId) {
        continue;
      }

      const playersPoints = entry.players_points ?? {};
      for (const playerId of entry.starters ?? []) {
        if (!isRealPlayerId(playerId)) {
          continue;
        }

        performances.push({
          week,
          rosterId,
          playerId: String(playerId),
          points: Number(playersPoints[playerId]) || 0,
        });
      }
    }
  }

  return performances;
}

export function findTopPerformances({
  matchupsByWeek,
  startWeek,
  endWeek,
  limit = 1,
}) {
  const performances = collectAllStarterPerformances({
    matchupsByWeek,
    startWeek,
    endWeek,
  });

  return performances.sort((a, b) => b.points - a.points).slice(0, limit);
}
