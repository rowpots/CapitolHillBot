// Ask the @mention bot a question from the terminal -- no Snapchat involved. Builds
// the same league snapshot the live bot uses, calls Claude Haiku, and prints the
// reply plus token usage and cost. Each run is one real (tiny) API charge and
// does NOT count against the live bot's monthly budget state. Run:
//   node preview-ai-mention.js --ask "who's the best team?"
//   node preview-ai-mention.js --ask "how's my team?" --sender Jake   (Jake as mapped in AI_MENTION_MEMBER_TEAMS)
//   node preview-ai-mention.js --snapshot          (print the league snapshot only, no API call)
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import dotenv from "dotenv";

import { describeError, installTimestampedConsole } from "./logging.js";
import { parseMention } from "./chat-commands.js";
import { loadValueBook } from "./dynasty-values.js";
import {
  askClaude,
  buildLeagueSnapshot,
  buildSystemPrompt,
  loadAiMentionConfig,
  normalizeMemberName,
} from "./ai-mention.js";

dotenv.config();
installTimestampedConsole();

const STATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), ".state");
const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error("Unable to preview AI mention.");
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const leagueId = process.env.SLEEPER_LEAGUE_ID?.trim();
  if (!leagueId) {
    throw new Error("Missing SLEEPER_LEAGUE_ID in .env.");
  }
  const aiConfig = loadAiMentionConfig();

  const league = await fetchJson(`https://api.sleeper.app/v1/league/${leagueId}`);
  const [playersById, valueBook] = await Promise.all([
    loadCachedPlayers(),
    loadValueBook({
      source: process.env.VALUE_SOURCE?.trim() || "dynastyprocess",
      cacheDir: STATE_DIR,
      preferredMode: process.env.DYNASTY_VALUE_MODE?.trim() || "auto",
      league,
      logger: console,
    }).catch((error) => {
      console.warn(`Value book unavailable (${error.message}); snapshot will skip values.`);
      return null;
    }),
  ]);
  const snapshot = await buildLeagueSnapshot({
    leagueId,
    fetchJson,
    playersById,
    valueBook,
    memberTeams: aiConfig.memberTeams,
  });
  const { text } = snapshot;
  console.log(`League snapshot: ${text.length} chars (~${Math.round(text.length / 4)} tokens).`);

  if (args.snapshot) {
    console.log("\n" + text);
    return;
  }
  if (!args.ask) {
    throw new Error('Pass --ask "<question>" (or --snapshot).');
  }
  if (!aiConfig.hasApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set in .env.");
  }

  // Accept the question with or without the tag, the way it'd be typed in chat.
  const question = parseMention(args.ask, aiConfig.handles)?.question || args.ask;
  const sender = args.sender || "Someone";
  const senderTeam = snapshot.teamBySender.get(normalizeMemberName(sender)) ?? null;
  console.log(`>> ${sender}${senderTeam ? ` (${senderTeam})` : ""}: ${question}`);

  const result = await askClaude({
    question,
    sender,
    senderTeam,
    systemPrompt: buildSystemPrompt({ snapshot: text }),
    maxOutputTokens: aiConfig.maxOutputTokens,
  });

  console.log("--- reply ---");
  console.log(result.text ? `@${sender} ${result.text}` : "(no reply — see warnings above)");
  console.log("-------------");
  if (result.usage) {
    console.log(
      `Model: ${result.model} · ` +
        `Tokens: ${result.usage.input_tokens} in / ${result.usage.output_tokens} out · ` +
        `cost $${result.costUsd.toFixed(5)} · ` +
        `≈ ${Math.floor(aiConfig.monthlyBudgetUsd / Math.max(result.costUsd, 1e-6))} questions per ` +
        `$${aiConfig.monthlyBudgetUsd} monthly budget`
    );
  }
}

// Reuse the live bot's 24h players cache when present (any age is fine for a
// preview); otherwise fall back to answering without rosters.
async function loadCachedPlayers() {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(STATE_DIR, "players-nfl.json"), "utf8"));
    if (parsed?.playersById) {
      return parsed.playersById;
    }
  } catch (error) {
    // fall through
  }
  console.log("No .state/players-nfl.json cache; fetching the Sleeper player index...");
  return fetchJson("https://api.sleeper.app/v1/players/nfl").catch(() => null);
}

async function fetchJson(url) {
  let response = null;
  try {
    response = await fetch(url, {
      headers: { "user-agent": "tradebot-snapchat-bridge/1.0", accept: "application/json" },
    });
  } catch (error) {
    throw new Error(`Network request failed for ${url}: ${describeError(error)}`, { cause: error });
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
    if (arg === "--snapshot") options.snapshot = true;
    else if (arg === "--ask") {
      options.ask = rawArgs[i + 1];
      i += 1;
    } else if (arg === "--sender") {
      options.sender = rawArgs[i + 1];
      i += 1;
    }
  }
  return options;
}
