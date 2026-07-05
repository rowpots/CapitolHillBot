import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import dotenv from "dotenv";
import { installTimestampedConsole } from "./logging.js";
import { getRoastForSeverity } from "./roast-templates.js";

dotenv.config();
installTimestampedConsole();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_DIR = path.join(__dirname, ".state");
const MANUAL_TEST_TRIGGER_FILE = path.join(STATE_DIR, "manual-test-trade.json");
const args = new Set(process.argv.slice(2));

main().catch((error) => {
  console.error("Unable to queue the manual test trade.");
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  const tradeMessage =
    parseMultilineEnv(process.env.TEST_TRADE_MESSAGE) || buildDefaultTradeMessage();
  const roastMessage =
    parseMultilineEnv(process.env.TEST_TRADE_ROAST) || buildDefaultRoastMessage();
  const shouldSendRoast =
    !args.has("--no-roast") &&
    !["0", "false", "no", "off"].includes(
      String(process.env.SEND_TEST_ROAST ?? "true").toLowerCase()
    );

  // --queue exercises the full review pipeline (heads-up in the review chat,
  // !veto window, timed release to the test chat) instead of sending at once.
  const shouldQueue = args.has("--queue");

  const payload = {
    queuedAt: new Date().toISOString(),
    tradeMessage,
    tradeCardAnalysis: buildDefaultTradeCardAnalysis(),
    roastMessage,
    sendRoast: shouldSendRoast,
    queue: shouldQueue,
  };

  await fs.writeFile(
    MANUAL_TEST_TRIGGER_FILE,
    JSON.stringify(payload, null, 2),
    "utf8"
  );

  console.log("Queued a manual test trade for the live bot.");
  if (shouldQueue) {
    console.log(
      "Review mode: the bot will post a heads-up to the review chat, hold the trade for the veto window, then release it to the test chat."
    );
  } else {
    console.log(
      "If the bot is already running, it should send within about 5 seconds."
    );
  }
}

function buildDefaultTradeMessage() {
  const timestamp = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  }).format(new Date());

  return [
    "A trade has been completed",
    `(Manual test at ${timestamp})`,
    "This is the 12th trade of the season.",
    "This is the 3rd time Team Rowan and Capitol Crushers have traded.",
    "",
    "Team Rowan has sent:",
    "Brock Bowers (TE - LV)",
    "2027 1st",
    "",
    "Grade: A-",
    "",
    "Capitol Crushers has sent:",
    "Jaylen Waddle (WR - MIA)",
    "2028 2nd",
    "",
    "Grade: C+",
  ].join("\n");
}

function buildDefaultRoastMessage() {
  return getRoastForSeverity({
    severity: "medium",
    winner: "Team Rowan",
    loser: "Capitol Crushers",
    seed: "manual-test-trade",
    logger: console,
  });
}

function buildDefaultTradeCardAnalysis() {
  return {
    tradeId: "manual-test-trade",
    headlineLabel: "TRADE ALERT",
    leagueName: "Capitol Hill Dynasty",
    acceptedAtLabel: "Accepted manual test",
    valueMetaLabel: "DynastyProcess values preview",
    verdictSourceLabel: "Best Value",
    winnerLabel: "Team Rowan",
    winnerEdgeLabel: "+1,120",
    historyContext: {
      seasonTradeNumber: 12,
      rivalryTradeNumber: 3,
      rivalryLabel: "Team Rowan and Capitol Crushers",
    },
    teams: [
      {
        rosterId: "1",
        label: "Team Rowan",
        subtitle: "Sent 11,620 | Received 12,740 | Net +1,120",
        sentValue: 11620,
        receivedValue: 12740,
        netValue: 1120,
        grade: "A-",
        gradeFlavor: "elite",
        isWinner: true,
        sentAssets: [
          buildPlayerAsset({
            id: "11604",
            name: "Brock Bowers",
            position: "TE",
            team: "LV",
            value: 5410,
          }),
          buildPlayerAsset({
            id: "8137",
            name: "George Pickens",
            position: "WR",
            team: "DAL",
            value: 3890,
          }),
          buildPickAsset({
            title: "2027 1st",
            value: 2320,
          }),
        ],
      },
      {
        rosterId: "2",
        label: "Capitol Crushers",
        subtitle: "Sent 12,740 | Received 11,620 | Net -1,120",
        sentValue: 12740,
        receivedValue: 11620,
        netValue: -1120,
        grade: "B",
        gradeFlavor: "good",
        isWinner: false,
        sentAssets: [
          buildPlayerAsset({
            id: "7526",
            name: "Jaylen Waddle",
            position: "WR",
            team: "DEN",
            value: 5140,
          }),
          buildPlayerAsset({
            id: "8138",
            name: "James Cook",
            position: "RB",
            team: "BUF",
            value: 4760,
          }),
          buildPickAsset({
            title: "2028 2nd",
            value: 2840,
          }),
        ],
      },
    ],
  };
}

function buildPlayerAsset({ id, name, position, team, value }) {
  return {
    id: `player-${id}`,
    type: "player",
    playerId: id,
    position,
    title: name,
    meta: `${position} - ${team}`,
    textLine: `${name} (${position} - ${team})`,
    value,
  };
}

function buildPickAsset({ title, value }) {
  return {
    id: `pick-${title.toLowerCase().replace(/\s+/g, "-")}`,
    type: "pick",
    title,
    meta: "Draft pick",
    textLine: title,
    value,
  };
}

function parseMultilineEnv(value) {
  if (!value) {
    return "";
  }

  return String(value).replace(/\\n/g, "\n").trim();
}
