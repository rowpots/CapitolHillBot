import {
  DEFAULT_TEAM_NAME_MAX_LENGTH,
  groupWeekEntriesByMatchup,
  normalizeWeekEntries,
  STANDINGS_DIVIDER,
  truncateLabel,
} from "./weekly-report.js";

// Tuned against a real season replay (see plan notes) rather than guessed —
// the naive version ("either team qualifies" for Elimination/Clinch) ended up
// classifying nearly every matchup nearly every week, which defeats the
// "marquee games" framing. These tighter bands give 2-6 of 6 matchups
// classified per week instead of a blanket 6/6. Retune after a live season.
const ELIMINATION_ODDS_MAX = 0.2;
const CLINCH_WATCH_ODDS_MIN = 0.85;
// Just under the milestone clinch threshold so this never overlaps with an
// already-announced clinch (milestones.js fires at >= 0.9999).
const CLINCH_MILESTONE_THRESHOLD = 0.9999;
const SHOWDOWN_BAND_MIN = 0.3;
const SHOWDOWN_BAND_MAX = 0.7;
const DRAFT_POSITION_ODDS_MAX = 0.2;

// One week before milestones.js's PLAYOFF_ALERT_MIN_WEEK, since this previews
// the *next* week's implications — odds aren't reliable enough before this.
export const BIG_MATCHUPS_MIN_WEEK = 7;

// Checked in this order; a matchup is assigned to at most one bucket (the
// first one it matches) so the same two teams never get listed twice.
const BUCKET_ORDER = ["elimination", "clinch", "showdown", "draftPosition"];
const BUCKET_LABELS = {
  elimination: "🎯 Elimination Watch",
  clinch: "🔒 Clinch Watch",
  showdown: "⚔️ Playoff Showdown",
  draftPosition: "🏗️ Draft Position Bowl",
};

export function buildBigMatchupsReport({ league, standings, matchupsByWeek, displayWeek }) {
  const standingsByRosterId = new Map(
    standings.map((team) => [String(team.rosterId), team])
  );
  const entries = normalizeWeekEntries(matchupsByWeek?.[displayWeek] ?? []);
  const grouped = groupWeekEntriesByMatchup(entries);

  const buckets = { elimination: [], clinch: [], showdown: [], draftPosition: [] };

  for (const pair of grouped.values()) {
    if (pair.length !== 2) {
      continue;
    }

    const [left, right] = pair;
    const teamLeft = standingsByRosterId.get(left.rosterId);
    const teamRight = standingsByRosterId.get(right.rosterId);
    if (!teamLeft || !teamRight) {
      continue;
    }

    const bucket = classifyMatchup(teamLeft, teamRight);
    if (!bucket) {
      continue;
    }

    buckets[bucket].push(formatMatchupLine(bucket, teamLeft, teamRight));
  }

  const totalClassified = Object.values(buckets).reduce((sum, list) => sum + list.length, 0);
  if (totalClassified === 0) {
    return null;
  }

  const leagueName = String(league?.name ?? "League").trim() || "League";
  const report = { leagueName, week: displayWeek, buckets, totalClassified };
  report.textMessage = formatBigMatchupsMessage(report);
  return report;
}

function classifyMatchup(teamA, teamB) {
  const oddsA = teamA.playoffOdds;
  const oddsB = teamB.playoffOdds;

  if (
    (oddsA > 0 && oddsA <= ELIMINATION_ODDS_MAX) ||
    (oddsB > 0 && oddsB <= ELIMINATION_ODDS_MAX)
  ) {
    return "elimination";
  }

  if (
    (oddsA >= CLINCH_WATCH_ODDS_MIN && oddsA < CLINCH_MILESTONE_THRESHOLD) ||
    (oddsB >= CLINCH_WATCH_ODDS_MIN && oddsB < CLINCH_MILESTONE_THRESHOLD)
  ) {
    return "clinch";
  }

  if (
    oddsA >= SHOWDOWN_BAND_MIN &&
    oddsA <= SHOWDOWN_BAND_MAX &&
    oddsB >= SHOWDOWN_BAND_MIN &&
    oddsB <= SHOWDOWN_BAND_MAX
  ) {
    return "showdown";
  }

  if (oddsA <= DRAFT_POSITION_ODDS_MAX && oddsB <= DRAFT_POSITION_ODDS_MAX) {
    return "draftPosition";
  }

  return null;
}

function isInEliminationDanger(team) {
  return team.playoffOdds > 0 && team.playoffOdds <= ELIMINATION_ODDS_MAX;
}

function isCloseToClinching(team) {
  return (
    team.playoffOdds >= CLINCH_WATCH_ODDS_MIN &&
    team.playoffOdds < CLINCH_MILESTONE_THRESHOLD
  );
}

// Elimination/Clinch are about one (or sometimes both) team's individual
// stakes, so name names instead of a plain "A vs. B" — Showdown/Draft
// Position Bowl are about both teams equally by definition, so "vs." already
// says enough there.
function formatMatchupLine(bucket, teamA, teamB) {
  const labelA = truncateLabel(teamA.label, DEFAULT_TEAM_NAME_MAX_LENGTH);
  const labelB = truncateLabel(teamB.label, DEFAULT_TEAM_NAME_MAX_LENGTH);

  if (bucket === "elimination") {
    const aInDanger = isInEliminationDanger(teamA);
    const bInDanger = isInEliminationDanger(teamB);
    if (aInDanger && bInDanger) {
      return `${labelA} and ${labelB} are both in danger of elimination`;
    }
    const [atRisk, opponent] = aInDanger ? [labelA, labelB] : [labelB, labelA];
    return `${atRisk} is in danger of elimination vs. ${opponent}`;
  }

  if (bucket === "clinch") {
    const aClose = isCloseToClinching(teamA);
    const bClose = isCloseToClinching(teamB);
    if (aClose && bClose) {
      return `${labelA} and ${labelB} could both clinch a playoff spot`;
    }
    const [clinching, opponent] = aClose ? [labelA, labelB] : [labelB, labelA];
    return `${clinching} could clinch a playoff spot vs. ${opponent}`;
  }

  const [higher, lower] = teamA.playoffOdds >= teamB.playoffOdds ? [labelA, labelB] : [labelB, labelA];
  return `${higher} vs. ${lower}`;
}

export function formatBigMatchupsMessage({ leagueName, week, buckets }) {
  const headerLine = `📅 ${leagueName} Week ${week} Matchups to Watch`;
  const divider = "—".repeat(
    Math.max(STANDINGS_DIVIDER.length, headerLine.length - 15) + 6
  );

  const blocks = [];
  for (const bucketKey of BUCKET_ORDER) {
    const lines = buckets[bucketKey];
    if (!lines || lines.length === 0) {
      continue;
    }
    blocks.push(`${BUCKET_LABELS[bucketKey]}\n${lines.join("\n")}`);
  }

  return [headerLine, divider, "", blocks.join("\n\n")].join("\n");
}
