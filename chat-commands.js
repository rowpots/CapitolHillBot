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

// A divider sized to the header but trimmed back, matching the other features'
// fix for headers wrapping to a second line on mobile.
function dividerFor(header) {
  return "—".repeat(Math.max(STANDINGS_DIVIDER.length, header.length - 10));
}
