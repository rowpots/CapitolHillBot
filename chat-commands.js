// Two-way chat commands: parsing + pure message builders for the commands the
// bot answers when a league member types them in the group chat. The reading of
// the chat DOM lives in snapbot.js (readChatMessages); the poller wiring + data
// fetching lives in index.js (pollForChatCommands). This module is pure/testable
// and reuses the same label/format helpers as the rest of the bot's posts.
import {
  buildRosterLookup,
  buildUserLookup,
  DEFAULT_TEAM_NAME_MAX_LENGTH,
  formatOneDecimal,
  formatRosterLabel,
  groupWeekEntriesByMatchup,
  normalizeWeekEntries,
  STANDINGS_DIVIDER,
  truncateLabel,
} from "./weekly-report.js";

export const DEFAULT_COMMAND_PREFIX = "!";

// The advertised command set. `name` is what follows the prefix; `usage` is the
// help-line text. Adding a command here surfaces it in !help; its handler is
// wired in index.js buildCommandReply (and preview-chat-commands.js).
export const COMMANDS = [
  { name: "help", usage: "help", description: "List the commands you can use" },
  { name: "standings", usage: "standings", description: "Current league standings" },
  { name: "record", usage: "record <team>", description: "A team's record + rank" },
  { name: "power", usage: "power", description: "Power rankings" },
  { name: "matchup", usage: "matchup [team]", description: "This week's matchups" },
  { name: "trade", usage: "trade <a> for <b>", description: "Grade a hypothetical trade" },
  { name: "hof", usage: "hof", description: "All-time Hall of Fame" },
];

// Parses one chat message into a command, or null if it isn't one. Case- and
// whitespace-tolerant: "!Standings  BOB" -> { name: "standings", args: ["BOB"] }.
export function parseCommand(text, prefix = DEFAULT_COMMAND_PREFIX) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith(prefix) || trimmed.length <= prefix.length) {
    return null;
  }

  const body = trimmed.slice(prefix.length).trim();
  const parts = body.split(/\s+/);
  const name = (parts.shift() ?? "").toLowerCase();
  if (!name) {
    return null;
  }

  return { name, args: parts, argString: parts.join(" ").trim() };
}

// A stable per-message identity for dedupe. Snapchat exposes no message ids, so
// (sender + normalized text) is the best available signature; the trade-off is
// that the exact same command from the same person is answered once until it
// ages out of the handled-signature ring (acceptable for v1).
export function commandSignature(message) {
  const from = String(message?.from ?? "").trim().toLowerCase();
  const text = String(message?.text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return `${from}::${text}`;
}

export function buildHelpMessage(prefix = DEFAULT_COMMAND_PREFIX, leagueName = "League") {
  const header = `🤖 ${leagueName} Bot — Commands`;
  const lines = COMMANDS.map((command) => `${prefix}${command.usage} — ${command.description}`);
  return [header, dividerFor(header), "", lines.join("\n")].join("\n");
}

// Standings straight from each roster's Sleeper-maintained settings (wins /
// losses / ties / fpts), so this works year-round (final record in the
// offseason, live record mid-season) with a single /rosters fetch -- no
// week-by-week matchup pull needed.
export function buildStandingsFromRosters({ rosters, users }) {
  const rosterLookup = buildRosterLookup(rosters);
  const userLookup = buildUserLookup(users);

  const teams = (rosters ?? []).map((roster) => {
    const settings = roster?.settings ?? {};
    const wins = Number(settings.wins) || 0;
    const losses = Number(settings.losses) || 0;
    const ties = Number(settings.ties) || 0;
    const pointsFor = (Number(settings.fpts) || 0) + (Number(settings.fpts_decimal) || 0) / 100;
    const gamesPlayed = wins + losses + ties;
    const winPct = gamesPlayed > 0 ? (wins + ties * 0.5) / gamesPlayed : 0;

    return {
      rosterId: String(roster.roster_id),
      label: formatRosterLabel(String(roster.roster_id), rosterLookup, userLookup),
      wins,
      losses,
      ties,
      pointsFor,
      gamesPlayed,
      winPct,
    };
  });

  teams.sort((a, b) => b.winPct - a.winPct || b.pointsFor - a.pointsFor);
  return teams;
}

export function formatStandingsMessage({ leagueName = "League", teams, seasonNote = null }) {
  if (!teams || teams.length === 0) {
    return "No standings are available yet.";
  }

  const header = `📊 ${leagueName} Standings${seasonNote ? ` (${seasonNote})` : ""}`;
  const lines = teams.map((team, index) => {
    const record = formatRecord(team);
    return `${index + 1}. ${truncateLabel(team.label, DEFAULT_TEAM_NAME_MAX_LENGTH)}  ${record} · ${formatOneDecimal(
      team.pointsFor
    )} PF`;
  });

  return [header, dividerFor(header), "", lines.join("\n")].join("\n");
}

export function buildTeamRecordMessage({
  leagueName = "League",
  teams,
  query,
  prefix = DEFAULT_COMMAND_PREFIX,
  seasonNote = null,
}) {
  if (!query) {
    return `Usage: ${prefix}record <team name>`;
  }
  if (!teams || teams.length === 0) {
    return "No standings are available yet.";
  }

  const match = findTeamByQuery(teams, query);
  if (!match) {
    return `No team found matching "${query}".`;
  }

  const rank = teams.indexOf(match) + 1;
  const where = seasonNote ? `${leagueName}, ${seasonNote}` : leagueName;
  return `${truncateLabel(match.label, DEFAULT_TEAM_NAME_MAX_LENGTH)} — ${formatRecord(match)}, ${formatOneDecimal(
    match.pointsFor
  )} PF (#${rank} of ${teams.length} in ${where})`;
}

function findTeamByQuery(teams, query) {
  const needle = String(query).trim().toLowerCase();
  if (!needle) {
    return null;
  }

  // Prefer an exact (case-insensitive) label match, then a substring match, so
  // "!record bob" finds "Bob's Team" but an exact name still wins over a partial.
  return (
    teams.find((team) => team.label.toLowerCase() === needle) ||
    teams.find((team) => team.label.toLowerCase().includes(needle)) ||
    null
  );
}

function formatRecord(team) {
  return team.ties > 0
    ? `${team.wins}-${team.losses}-${team.ties}`
    : `${team.wins}-${team.losses}`;
}

// ---- !matchup -------------------------------------------------------------

// Turns a raw Sleeper matchups array into head-to-head pairings with labels and
// points. Returns *all* pairings for the week; filtering to one team is a
// separate step (filterMatchupPairings) so callers can tell "no schedule this
// week at all" (empty here) apart from "that team isn't playing" (empty filter).
export function buildMatchupPairings({ matchups, rosters, users }) {
  const rosterLookup = buildRosterLookup(rosters);
  const userLookup = buildUserLookup(users);
  const grouped = groupWeekEntriesByMatchup(normalizeWeekEntries(matchups ?? []));

  const pairings = [];
  for (const pair of grouped.values()) {
    if (pair.length !== 2) {
      continue;
    }
    const sides = pair
      .map((entry) => ({
        label: formatRosterLabel(entry.rosterId, rosterLookup, userLookup),
        points: entry.points,
      }))
      .sort((a, b) => b.points - a.points);
    pairings.push({ a: sides[0], b: sides[1] });
  }

  return pairings;
}

// Narrows pairings to the one involving a named team (substring, case-
// insensitive). An empty query returns every pairing unchanged.
export function filterMatchupPairings(pairings, teamQuery = "") {
  const needle = String(teamQuery).trim().toLowerCase();
  if (!needle) {
    return pairings;
  }
  return pairings.filter(
    (pairing) =>
      pairing.a.label.toLowerCase().includes(needle) ||
      pairing.b.label.toLowerCase().includes(needle)
  );
}

export function formatMatchupsMessage({ leagueName = "League", weekLabel, pairings, seasonNote = null }) {
  if (!pairings || pairings.length === 0) {
    return "No matchups to show right now.";
  }

  const header = `🏈 ${leagueName} — ${weekLabel}${seasonNote ? ` (${seasonNote})` : ""}`;
  // When the week is still being played every team shows 0.0, so only print
  // scores once at least one point has been posted.
  const anyScored = pairings.some((p) => p.a.points > 0 || p.b.points > 0);

  const lines = pairings.map((pairing) => {
    const a = truncateLabel(pairing.a.label, DEFAULT_TEAM_NAME_MAX_LENGTH);
    const b = truncateLabel(pairing.b.label, DEFAULT_TEAM_NAME_MAX_LENGTH);
    if (!anyScored) {
      return `${a}  vs  ${b}`;
    }
    return `${a}  ${formatOneDecimal(pairing.a.points)} — ${formatOneDecimal(pairing.b.points)}  ${b}`;
  });

  return [header, dividerFor(header), "", lines.join("\n")].join("\n");
}

// ---- !trade ---------------------------------------------------------------

// Splits "!trade A, B for C" into { sideA: ["A","B"], sideB: ["C"] }. Accepts
// " for ", "|", or "/" between the two sides and comma / "+" within a side.
export function parseTradeCommand(argString) {
  const raw = String(argString ?? "").trim();
  if (!raw) {
    return null;
  }

  const parts = raw.split(/\s+for\s+|\s*\|\s*|\s+\/\s+/i);
  if (parts.length !== 2) {
    return null;
  }

  const splitSide = (side) =>
    side
      .split(/\s*,\s*|\s+\+\s+/)
      .map((name) => name.trim())
      .filter(Boolean);

  const sideA = splitSide(parts[0]);
  const sideB = splitSide(parts[1]);
  if (sideA.length === 0 || sideB.length === 0) {
    return null;
  }
  return { sideA, sideB };
}

// Builds a normalized-name -> [player, ...] index from Sleeper's players map for
// fuzzy `!trade` lookups. Only keeps players with a fantasy-relevant position.
export function buildPlayerNameIndex(playersById) {
  const FANTASY_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);
  const index = new Map();

  for (const id of Object.keys(playersById ?? {})) {
    const player = playersById[id];
    if (!player) {
      continue;
    }
    const position = String(player.position ?? "").toUpperCase();
    if (!FANTASY_POSITIONS.has(position)) {
      continue;
    }
    const fullName =
      player.full_name || [player.first_name, player.last_name].filter(Boolean).join(" ");
    if (!fullName) {
      continue;
    }
    const key = normalizePlayerName(fullName);
    if (!key) {
      continue;
    }
    if (!index.has(key)) {
      index.set(key, []);
    }
    index.get(key).push({ id, ...player, displayName: fullName });
  }

  return index;
}

function normalizePlayerName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[.'`]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Resolves a free-text name to a single player, preferring an exact normalized
// match and, among same-name players, the one with the highest dynasty value
// (so "Lamar Jackson" lands on the QB, not an obscure namesake).
function resolvePlayer(name, index, valueBook) {
  const key = normalizePlayerName(name);
  if (!key) {
    // A name that normalizes to nothing (e.g. just "Jr") would otherwise make
    // the loose fallback's startsWith("") match every player.
    return null;
  }
  let candidates = index.get(key);

  if (!candidates || candidates.length === 0) {
    // Loose fallback: a unique key that starts with / contains the query.
    const keys = [...index.keys()].filter((k) => k.startsWith(key) || k.includes(key));
    if (keys.length > 0) {
      candidates = keys.flatMap((k) => index.get(k));
    }
  }
  if (!candidates || candidates.length === 0) {
    return null;
  }

  return candidates
    .map((player) => ({ player, value: valueBook?.getPlayerValue(player) ?? null }))
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1))[0].player;
}

export function buildTradeEvaluationMessage({ argString, playerIndex, valueBook, prefix = DEFAULT_COMMAND_PREFIX }) {
  const parsed = parseTradeCommand(argString);
  if (!parsed) {
    return `Usage: ${prefix}trade <players> for <players>  —  e.g. ${prefix}trade Lamar Jackson for Jayden Daniels`;
  }

  const sideA = resolveSide(parsed.sideA, playerIndex, valueBook);
  const sideB = resolveSide(parsed.sideB, playerIndex, valueBook);

  const unresolved = [...sideA.unresolved, ...sideB.unresolved];
  if (sideA.players.length === 0 || sideB.players.length === 0) {
    const missing = unresolved.length ? ` Couldn't find: ${unresolved.join(", ")}.` : "";
    return `I couldn't read both sides of that trade.${missing} Try full player names.`;
  }

  const lines = ["⚖️ Trade Check"];
  lines.push(dividerFor(lines[0]));
  lines.push(formatTradeSide("Side 1", sideA));
  lines.push(formatTradeSide("Side 2", sideB));
  lines.push("");

  const baseline = Math.max((sideA.total + sideB.total) / 2, 1);
  // Each side ends up holding the *other* side's package, so Side 1's value
  // swing is what it receives (sideB) minus what it gives (sideA). The side that
  // gives less value comes out ahead.
  const side1Score = (sideB.total - sideA.total) / baseline;
  const grade1 = gradeFromScore(side1Score).grade;
  const grade2 = gradeFromScore(-side1Score).grade;

  const diff = Math.round(Math.abs(sideB.total - sideA.total));
  if (diff <= baseline * 0.05) {
    lines.push(`Dead even — ${formatOneDecimal(sideA.total)} vs ${formatOneDecimal(sideB.total)}. Grades ${grade1}/${grade2}.`);
  } else {
    const winner = sideA.total < sideB.total ? "Side 1" : "Side 2";
    lines.push(`${winner} comes out ahead by ${diff.toLocaleString()} in DynastyProcess value.`);
    lines.push(`Grades — Side 1: ${grade1} · Side 2: ${grade2}`);
  }

  if (unresolved.length) {
    lines.push("");
    lines.push(`(Skipped unrecognized: ${unresolved.join(", ")})`);
  }

  return lines.join("\n");
}

function resolveSide(names, playerIndex, valueBook) {
  const players = [];
  const unresolved = [];
  let total = 0;

  for (const name of names) {
    const player = resolvePlayer(name, playerIndex, valueBook);
    if (!player) {
      unresolved.push(name);
      continue;
    }
    const value = valueBook?.getPlayerValue(player) ?? 0;
    total += value;
    players.push({ player, value });
  }

  return { players, unresolved, total };
}

function formatTradeSide(label, side) {
  const parts = side.players.map((entry) => {
    const meta = [entry.player.position, entry.player.team].filter(Boolean).join("-");
    const valueLabel = entry.value > 0 ? ` (${Math.round(entry.value).toLocaleString()})` : "";
    return `${entry.player.displayName}${meta ? ` [${meta}]` : ""}${valueLabel}`;
  });
  return `${label}: ${parts.join(", ")}  =  ${formatOneDecimal(side.total)}`;
}

// Same grade thresholds as the live trade engine's buildTradeGrade (index.js).
// Duplicated here deliberately so the command stays self-contained until the
// trade engine is extracted into its own module.
function gradeFromScore(score) {
  if (score >= 0.7) return { grade: "A+" };
  if (score >= 0.45) return { grade: "A" };
  if (score >= 0.25) return { grade: "A-" };
  if (score >= 0.12) return { grade: "B+" };
  if (score >= 0.05) return { grade: "B" };
  if (score >= -0.05) return { grade: "C" };
  if (score >= -0.12) return { grade: "C-" };
  if (score >= -0.25) return { grade: "D" };
  return { grade: "F" };
}

// A divider sized to the header but trimmed back, matching the other features'
// fix for headers wrapping to a second line on mobile.
function dividerFor(header) {
  return "—".repeat(Math.max(STANDINGS_DIVIDER.length, header.length - 10));
}
