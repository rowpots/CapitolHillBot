// Dumps the Phase-1 analytics for the live league without sending anything:
// a dynasty-value power ranking of every roster (total value, positional split,
// win-now/rebuild tilt) plus the top mutually-beneficial trade ideas the finder
// surfaces. Print-only by design — chat commands (a later phase) expose this in
// the group chat. Run:
//   node preview-roster-analysis.js                 (uses VALUE_SOURCE / DYNASTY_VALUE_MODE from .env)
//   node preview-roster-analysis.js --source ktc    (override the value source)
//   node preview-roster-analysis.js --mode 1qb      (override superflex/1QB mode)
//   node preview-roster-analysis.js --ideas 12      (how many trade ideas to list)
import path from "path";
import { fileURLToPath } from "url";

import dotenv from "dotenv";

import { describeError, installTimestampedConsole } from "./logging.js";
import { loadValueBook } from "./dynasty-values.js";
import {
  buildRosterValuations,
  describeTradeIdea,
  findTrades,
  rankRosters,
} from "./roster-analysis.js";

dotenv.config();
installTimestampedConsole();

const STATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), ".state");
const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error("Unable to preview roster analysis.");
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const leagueId = process.env.SLEEPER_LEAGUE_ID?.trim();
  if (!leagueId) {
    throw new Error("Missing SLEEPER_LEAGUE_ID in .env.");
  }

  const source = args.source ?? process.env.VALUE_SOURCE?.trim() ?? "dynastyprocess";
  const preferredMode = args.mode ?? process.env.DYNASTY_VALUE_MODE?.trim() ?? "auto";
  const ideaCount = Number.isFinite(Number(args.ideas)) ? Number(args.ideas) : 8;

  const league = await fetchJson(`https://api.sleeper.app/v1/league/${leagueId}`);
  const leagueName = String(league?.name ?? "League").trim() || "League";

  const [rosters, users, playersById, valueBook] = await Promise.all([
    fetchJson(`https://api.sleeper.app/v1/league/${leagueId}/rosters`),
    fetchJson(`https://api.sleeper.app/v1/league/${leagueId}/users`),
    fetchJson("https://api.sleeper.app/v1/players/nfl"),
    loadValueBook({
      source,
      cacheDir: STATE_DIR,
      preferredMode,
      league,
      logger: console,
    }),
  ]);

  const valuations = buildRosterValuations({
    rosters,
    users,
    playersById,
    valueBook,
    league,
  });
  const ranked = rankRosters(valuations);
  const ideas = findTrades({ valuations, options: { maxIdeas: ideaCount } });

  printRankings({ leagueName, valueBook, ranked });
  printTradeIdeas({ valueBook, ideas });
}

function printRankings({ leagueName, valueBook, ranked }) {
  console.log("");
  console.log(
    `📊 ${leagueName} — Dynasty Value Rankings ` +
      `(${valueBook.source}, ${valueBook.valueMode}, as of ${valueBook.sourceDate ?? "latest"})`
  );
  console.log("=".repeat(72));

  for (const team of ranked) {
    const split = ["QB", "RB", "WR", "TE"]
      .map((pos) => `${pos} ${short(team.byPosition[pos])}`)
      .join(" · ");
    const tilt = team.tilt.avgAge
      ? `${team.tilt.label} (avg ${team.tilt.avgAge.toFixed(1)})`
      : team.tilt.label;

    console.log(
      `${String(team.rank).padStart(2)}. ${team.label.padEnd(22)} ` +
        `${short(team.totalValue).padStart(6)}  ` +
        `(${(team.share * 100).toFixed(1)}%)  [${tilt}]`
    );
    console.log(
      `    ${split}   |   starters ${short(team.starterValue)} / depth ${short(team.depthValue)}`
    );
  }
}

function printTradeIdeas({ valueBook, ideas }) {
  console.log("");
  console.log(`🤝 Trade Finder — top ${ideas.length} mutually-beneficial ideas`);
  console.log("=".repeat(72));

  if (ideas.length === 0) {
    console.log("No fair, need-matching trades surfaced. (Try --ideas or a wider band.)");
    return;
  }

  const valueLabel = `${valueBook.source} value`;
  ideas.forEach((idea, index) => {
    console.log(`${index + 1}. ${describeTradeIdea(idea, { valueLabel })}`);
  });
}

// Compact number formatting (values run into the thousands): 9996 -> "10.0k".
function short(value) {
  const numeric = Number(value) || 0;
  if (numeric >= 1000) {
    return `${(numeric / 1000).toFixed(1)}k`;
  }
  return String(Math.round(numeric));
}

async function fetchJson(url) {
  let response = null;
  try {
    response = await fetch(url, {
      headers: {
        "user-agent": "tradebot-snapchat-bridge/1.0",
        accept: "application/json",
      },
    });
  } catch (error) {
    throw new Error(`Network request failed for ${url}: ${describeError(error)}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new Error(`Request failed for ${url} with status ${response.status}.`);
  }
  return response.json();
}

function parseArgs(rawArgs) {
  const options = {};
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--source") {
      options.source = rawArgs[i + 1];
      i += 1;
    } else if (arg.startsWith("--source=")) {
      options.source = arg.slice("--source=".length);
    } else if (arg === "--mode") {
      options.mode = rawArgs[i + 1];
      i += 1;
    } else if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
    } else if (arg === "--ideas") {
      options.ideas = rawArgs[i + 1];
      i += 1;
    } else if (arg.startsWith("--ideas=")) {
      options.ideas = arg.slice("--ideas=".length);
    }
  }
  return options;
}
