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
import { gradeSwap } from "./trade-grading.js";

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
  { name: "trade", usage: "trade <a> for <b>", description: "Grade a hypothetical trade (players or picks)" },
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

// Detects an "@bot" tag anywhere in a message. Returns { question } with the tag
// stripped out, { question: "" } for a bare tag (the asker's next message is the
// question), or null if no handle is tagged. Handles are matched case-
// insensitively and may contain spaces (a Snapchat display name), so they're
// regex-escaped; a trailing word boundary keeps "@capitolhillbots" from matching.
export function parseMention(text, handles = []) {
  const raw = String(text ?? "");
  for (const handle of handles) {
    const cleaned = String(handle ?? "").trim().replace(/^@/, "");
    if (!cleaned) {
      continue;
    }
    const escaped = cleaned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`@\\s?${escaped}(?![\\w])[\\s:,!?.-]*`, "i");
    if (pattern.test(raw)) {
      const question = raw.replace(pattern, " ").replace(/\s+/g, " ").trim();
      return { question };
    }
  }
  return null;
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

// Phone keyboards autocorrect ' and " into curly quotes, which would otherwise
// make "Ja’Marr Chase" a different name from "Ja'Marr Chase".
function straightenQuotes(text) {
  return String(text ?? "").replace(/[‘’‛′]/g, "'").replace(/[“”″]/g, '"');
}

// Splits "!trade A, B for C" into { sideA: ["A","B"], sideB: ["C"] }. Between
// the two sides it accepts "for", "vs", "versus", "|", " / ", "<>" or "↔";
// within a side, commas, "+", "and" or "&".
export function parseTradeCommand(argString) {
  const raw = straightenQuotes(argString).trim();
  if (!raw) {
    return null;
  }

  const parts = raw.split(/\s+(?:for|vs\.?|versus)\s+|\s*(?:\||<->|<>|↔)\s*|\s+\/\s+/i);
  if (parts.length !== 2) {
    return null;
  }

  const splitSide = (side) =>
    side
      .split(/\s*,\s*|\s*\+\s*|\s+(?:and|&)\s+/i)
      .map((name) => name.trim())
      .filter(Boolean);

  const sideA = splitSide(parts[0]);
  const sideB = splitSide(parts[1]);
  if (sideA.length === 0 || sideB.length === 0) {
    return null;
  }
  return { sideA, sideB };
}

const PICK_ROUND_WORDS = new Map([
  ["1", 1], ["1st", 1], ["first", 1],
  ["2", 2], ["2nd", 2], ["second", 2],
  ["3", 3], ["3rd", 3], ["third", 3],
  ["4", 4], ["4th", 4], ["fourth", 4],
  ["5", 5], ["5th", 5], ["fifth", 5],
]);

// Reads a draft-pick mention: "2027 1st", "'27 early 2nd", "2028 round 1",
// "late first". Returns null for anything that isn't purely a pick, so player
// names never get swallowed. A missing year means the next rookie draft.
export function parsePickToken(text, now = new Date()) {
  const lowered = straightenQuotes(text).toLowerCase();
  let rest = lowered.replace(/[.']/g, " ");

  let tier = null;
  rest = rest.replace(/\b(early|mid|middle|late)\b/, (match) => {
    tier = match.startsWith("mid") ? "Mid" : match[0].toUpperCase() + match.slice(1);
    return " ";
  });

  let season = null;
  rest = rest.replace(/\b(?:20)?(2[5-9]|3[0-5])\b/, (match, yy) => {
    season = 2000 + Number(yy);
    return " ";
  });

  const words = rest
    .split(/\s+/)
    .filter((word) => word && !["round", "rounder", "rd", "pick", "picks", "rookie"].includes(word));
  if (words.length !== 1 || !PICK_ROUND_WORDS.has(words[0])) {
    return null;
  }
  // A bare digit ("2") only counts as a round when the word "round" is there.
  if (/^\d$/.test(words[0]) && !/\b(round|rd)\b/.test(lowered)) {
    return null;
  }

  if (season == null) {
    // The rookie draft runs in May; after that, "a 1st" means next year's.
    season = now.getMonth() >= 4 ? now.getFullYear() + 1 : now.getFullYear();
  }

  return { season, round: PICK_ROUND_WORDS.get(words[0]), tier };
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
  return straightenQuotes(name)
    .toLowerCase()
    .replace(/[.'`]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// When the second-best match is worth at least this share of the best one, the
// name is genuinely ambiguous ("brown": A.J. vs Amon-Ra St.) and we ask rather
// than guess. Below it, the star is almost certainly who was meant
// ("allen" -> Josh, not Braelon, at ~36%).
const AMBIGUOUS_VALUE_RATIO = 0.5;

// Initials and nicknames people actually type, mapped to the full name.
const PLAYER_NICKNAMES = new Map([
  ["cmc", "christian mccaffrey"],
  ["jsn", "jaxon smith njigba"],
  ["arsb", "amon ra st brown"],
  ["sun god", "amon ra st brown"],
  ["btj", "brian thomas"],
  ["mhj", "marvin harrison"],
  ["kw3", "kenneth walker"],
  ["ajb", "aj brown"],
  ["jt", "jonathan taylor"],
  ["tlaw", "trevor lawrence"],
  ["cd", "ceedee lamb"],
  ["mvs", "marquez valdes scantling"],
]);

// Resolves free text to one player. Tries, in order: the exact full name, a
// last-name match, any whole-word match, a substring, then a typo-tolerant
// match. Within the first tier that finds anyone, the most valuable player
// wins unless a second one is close enough in value to be a real ambiguity.
// Returns { player } | { ambiguous: [players] } | null.
function resolvePlayer(name, index, valueBook) {
  const typed = normalizePlayerName(name);
  const key = PLAYER_NICKNAMES.get(typed) ?? typed;
  // A name that normalizes to nothing (e.g. just "Jr") or a single letter
  // would match half the league.
  if (key.length < 2) {
    return null;
  }

  const tiers = [
    (k) => k === key,
    (k) => k.endsWith(` ${key}`),
    (k) => ` ${k} `.includes(` ${key} `),
    (k) => k.includes(key),
  ];
  for (const matches of tiers) {
    const keys = [...index.keys()].filter(matches);
    if (keys.length > 0) {
      return pickBestCandidate(keys.flatMap((k) => index.get(k)), valueBook);
    }
  }

  const typoKeys = findTypoMatches(key, index);
  return typoKeys.length
    ? pickBestCandidate(typoKeys.flatMap((k) => index.get(k)), valueBook)
    : null;
}

function pickBestCandidate(candidates, valueBook) {
  const ranked = candidates
    .map((player) => ({ player, value: valueBook?.getPlayerValue(player) ?? 0 }))
    .sort(
      (a, b) =>
        b.value - a.value || Number(Boolean(b.player.team)) - Number(Boolean(a.player.team))
    );

  const [best, runnerUp] = ranked;
  if (best.value > 0 && runnerUp && runnerUp.value >= best.value * AMBIGUOUS_VALUE_RATIO) {
    return {
      ambiguous: ranked
        .filter((entry) => entry.value >= best.value * AMBIGUOUS_VALUE_RATIO)
        .slice(0, 3)
        .map((entry) => entry.player),
    };
  }
  return { player: best.player };
}

// Closest names by edit distance, against both the full name and the last
// name. Only near misses count: 2 edits, or 1 for short names.
function findTypoMatches(key, index) {
  const maxDistance = key.length < 6 ? 1 : 2;
  let bestDistance = Infinity;
  let bestKeys = [];

  for (const k of index.keys()) {
    const lastName = k.split(" ").slice(1).join(" ");
    const distance = Math.min(
      levenshtein(key, k),
      lastName ? levenshtein(key, lastName) : Infinity
    );
    if (distance > maxDistance || distance > bestDistance) {
      continue;
    }
    if (distance < bestDistance) {
      bestDistance = distance;
      bestKeys = [];
    }
    bestKeys.push(k);
  }

  return bestKeys;
}

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 2) {
    return Infinity;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length];
}

export function buildTradeEvaluationMessage({
  argString,
  playerIndex,
  valueBook,
  prefix = DEFAULT_COMMAND_PREFIX,
  totalRosters = 12,
  now = new Date(),
}) {
  const parsed = parseTradeCommand(argString);
  if (!parsed) {
    return [
      'To check a trade, put "for" between the two sides:',
      `${prefix}trade Bijan Robinson for Puka Nacua`,
      `${prefix}trade jefferson and 2027 1st for chase`,
    ].join("\n");
  }

  const context = { playerIndex, valueBook, totalRosters, now };
  const sideA = resolveSide(parsed.sideA, context);
  const sideB = resolveSide(parsed.sideB, context);

  const ambiguous = [...sideA.ambiguous, ...sideB.ambiguous];
  if (ambiguous.length) {
    return ambiguous
      .map(({ name, players }) => `Which ${titleCase(name)}? ${formatNameOptions(players)}`)
      .concat("Add a first name and try again.")
      .join("\n");
  }

  // Grading a partial trade would be confidently wrong, so a name we can't
  // place stops the check instead of being skipped.
  const unresolved = [...sideA.unresolved, ...sideB.unresolved];
  if (unresolved.length) {
    return `Couldn't find: ${unresolved.join(", ")}. Check the spelling or use the full name.`;
  }

  const knownValueCount = sideA.knownCount + sideB.knownCount;
  const side1 = gradeSwap({
    sentValue: sideA.total,
    receivedValue: sideB.total,
    sentCount: sideA.knownCount,
    receivedCount: sideB.knownCount,
    knownValueCount,
  });
  const side2 = gradeSwap({
    sentValue: sideB.total,
    receivedValue: sideA.total,
    sentCount: sideB.knownCount,
    receivedCount: sideA.knownCount,
    knownValueCount,
  });

  const header = "⚖️ Trade Check";
  const lines = [
    formatTradeSide("Side 1 sends", sideA, side1.sentConsolidationBonus),
    formatTradeSide("Side 2 sends", sideB, side1.receivedConsolidationBonus),
    "",
  ];

  if (!knownValueCount) {
    lines.push("None of these have a trade value, so I can't grade it.");
  } else if (side1.gradeLabel === side2.gradeLabel) {
    lines.push(`${side1.gradeLabel} — fair for both sides.`);
  } else {
    const winner = side1.netValue > 0 ? "Side 1" : "Side 2";
    const margin = Math.abs(Math.round(side1.netValue));
    lines.push(`${winner} wins by ${margin.toLocaleString()}.`);
    lines.push(`Side 1: ${side1.gradeLabel} · Side 2: ${side2.gradeLabel}`);
  }

  const footer = formatValueSourceLine(valueBook);
  if (footer) {
    lines.push("", footer);
  }

  return [header, dividerFor(header), "", lines.join("\n")].join("\n");
}

function resolveSide(names, { playerIndex, valueBook, totalRosters, now }) {
  const assets = [];
  const unresolved = [];
  const ambiguous = [];

  for (const name of names) {
    const pick = parsePickToken(name, now);
    if (pick) {
      const value = valueBook?.getPickValue({ ...pick, totalRosters }) ?? null;
      const tierLabel = pick.tier ? `${pick.tier} ` : "";
      assets.push({ label: `${pick.season} ${tierLabel}${formatPickRound(pick.round)}`, value });
      continue;
    }

    const result = resolvePlayer(name, playerIndex, valueBook);
    if (!result) {
      unresolved.push(name);
    } else if (result.ambiguous) {
      ambiguous.push({ name, players: result.ambiguous });
    } else {
      const { player } = result;
      const meta = [player.position, player.team].filter(Boolean).join("-");
      assets.push({
        label: `${player.displayName}${meta ? ` [${meta}]` : ""}`,
        value: valueBook?.getPlayerValue(player) ?? null,
      });
    }
  }

  // Only valued assets count as pieces for the consolidation premium, the
  // same rule the live trade posts use.
  const known = assets.filter((asset) => asset.value > 0);
  return {
    assets,
    unresolved,
    ambiguous,
    knownCount: known.length,
    total: known.reduce((sum, asset) => sum + asset.value, 0),
  };
}

function formatTradeSide(label, side, consolidationBonus) {
  const parts = side.assets.map((asset) =>
    asset.value > 0
      ? `${asset.label} ${Math.round(asset.value).toLocaleString()}`
      : `${asset.label} (no value)`
  );
  const bonus =
    consolidationBonus > 0 ? ` + ${consolidationBonus.toLocaleString()} consolidation` : "";
  const total = Math.round(side.total + consolidationBonus).toLocaleString();
  return `${label}: ${parts.join(" · ")}${bonus} = ${total}`;
}

function formatNameOptions(players) {
  const labels = players.map((player) =>
    player.team ? `${player.displayName} (${player.team})` : player.displayName
  );
  return labels.length > 1
    ? `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`
    : labels[0];
}

function titleCase(text) {
  return String(text).replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function formatPickRound(round) {
  return ["1st", "2nd", "3rd", "4th", "5th"][round - 1] ?? `Round ${round}`;
}

export function formatValueSourceLine(valueBook) {
  if (!valueBook?.source) {
    return null;
  }
  const format = valueBook.valueMode === "2qb" ? "superflex " : "";
  const date = valueBook.sourceDate ? new Date(valueBook.sourceDate) : null;
  const asOf =
    date && !Number.isNaN(date.getTime())
      ? ` as of ${date.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          timeZone: "America/New_York",
        })}`
      : "";
  return `${valueBook.source} ${format}values${asOf}`;
}

// A divider sized to the header but trimmed back, matching the other features'
// fix for headers wrapping to a second line on mobile.
function dividerFor(header) {
  return "—".repeat(Math.max(STANDINGS_DIVIDER.length, header.length - 10));
}
