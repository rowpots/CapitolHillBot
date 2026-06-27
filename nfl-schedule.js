// NFL game-status source for live scoring. Sleeper exposes current fantasy
// points per player but NOT whether a player's NFL game has kicked off, so to
// answer "Team X is going into the last game down 5 with one player left to
// play" we need to know each NFL team's game state (pre / in / post) and which
// teams are in the final game slot of the week. The free ESPN public scoreboard
// gives both, with no API key.
//
// ESPN is an unofficial endpoint, so `parseScoreboard` is kept pure (unit-test
// it against a saved payload) and team abbreviations are normalized to
// Sleeper's conventions (Sleeper player records use Sleeper abbreviations).

const ESPN_SCOREBOARD_URL =
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

// ESPN → Sleeper abbreviation differences. Most match exactly; these are the
// known mismatches. Anything else passes through uppercased unchanged.
const ABBREV_NORMALIZE = {
  WSH: "WAS",
  JAC: "JAX",
  OAK: "LV",
  LA: "LAR", // ESPN occasionally uses "LA" for the Rams
  STL: "LAR",
  SD: "LAC",
};

export function normalizeTeamAbbrev(abbrev) {
  const upper = String(abbrev ?? "").trim().toUpperCase();
  return ABBREV_NORMALIZE[upper] ?? upper;
}

// Pure: ESPN scoreboard JSON → { season, week, games:[{ teams, state, kickoffMs }] }.
// state is "pre" | "in" | "post"; kickoffMs is the game's start time (ms epoch).
export function parseScoreboard(scoreboard) {
  const events = Array.isArray(scoreboard?.events) ? scoreboard.events : [];
  const games = [];

  for (const event of events) {
    const competition = event?.competitions?.[0] ?? {};
    const state = String(
      competition?.status?.type?.state ?? event?.status?.type?.state ?? ""
    ).toLowerCase();
    const kickoffMs = Date.parse(competition?.date ?? event?.date ?? "") || 0;
    const teams = (competition?.competitors ?? [])
      .map((competitor) => normalizeTeamAbbrev(competitor?.team?.abbreviation))
      .filter(Boolean);

    if (teams.length === 0) {
      continue;
    }
    games.push({ teams, state, kickoffMs });
  }

  return {
    season: String(scoreboard?.season?.year ?? "").trim(),
    week: Number(scoreboard?.week?.number) || null,
    games,
  };
}

export async function fetchSchedule({ fetchJson, season, week }) {
  const params = new URLSearchParams({ seasontype: "2" });
  if (week) {
    params.set("week", String(week));
  }
  if (season) {
    params.set("dates", String(season));
  }
  const scoreboard = await fetchJson(`${ESPN_SCOREBOARD_URL}?${params.toString()}`);
  return parseScoreboard(scoreboard);
}

function lastKickoffMs(schedule) {
  return (schedule?.games ?? []).reduce((max, game) => Math.max(max, game.kickoffMs), 0);
}

// "pre" | "in" | "post" | null (null = bye / not on this week's slate).
export function getTeamState(schedule, teamAbbrev) {
  const team = normalizeTeamAbbrev(teamAbbrev);
  const game = (schedule?.games ?? []).find((candidate) => candidate.teams.includes(team));
  return game?.state ?? null;
}

export function isInLastGame(schedule, teamAbbrev) {
  const team = normalizeTeamAbbrev(teamAbbrev);
  const last = lastKickoffMs(schedule);
  if (!last) {
    return false;
  }
  return (schedule?.games ?? []).some(
    (game) => game.kickoffMs === last && game.teams.includes(team)
  );
}

// True only when every game except the final slot has finished AND the final
// slot hasn't — i.e. "the only football left this week is the last game"
// (Monday Night, or Sunday Night on a rare MNF-less week). This is the gate for
// the "going into the last game" alert.
export function isOnlyLastGameRemaining(schedule) {
  const games = schedule?.games ?? [];
  if (games.length === 0) {
    return false;
  }
  const last = lastKickoffMs(schedule);
  if (!last) {
    return false;
  }

  let lastSlotLive = false;
  for (const game of games) {
    if (game.kickoffMs === last) {
      if (game.state === "pre" || game.state === "in") {
        lastSlotLive = true;
      }
    } else if (game.state !== "post") {
      return false; // an earlier game isn't finished yet
    }
  }
  return lastSlotLive;
}

// Test/preview helper: turn any schedule (e.g. a completed week where every game
// is "post") into a "going into the last game" state by forcing the final slot
// to "pre" and everything earlier to "post". Lets the preview exercise the alert
// against historical data.
export function simulateGoingIntoLastGame(schedule) {
  const last = lastKickoffMs(schedule);
  return {
    ...schedule,
    games: (schedule?.games ?? []).map((game) => ({
      ...game,
      state: game.kickoffMs === last ? "pre" : "post",
    })),
  };
}
