import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import dotenv from "dotenv";
import { getRoastForSeverity } from "./roast-templates.js";

dotenv.config();

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

  const payload = {
    queuedAt: new Date().toISOString(),
    tradeMessage,
    roastMessage,
    sendRoast: shouldSendRoast,
  };

  await fs.writeFile(
    MANUAL_TEST_TRIGGER_FILE,
    JSON.stringify(payload, null, 2),
    "utf8"
  );

  console.log("Queued a manual test trade for the live bot.");
  console.log(
    "If the bot is already running, it should send within about 5 seconds."
  );
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

function parseMultilineEnv(value) {
  if (!value) {
    return "";
  }

  return String(value).replace(/\\n/g, "\n").trim();
}
