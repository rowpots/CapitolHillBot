import path from "path";
import { fileURLToPath } from "url";

import { renderTradeCardImage } from "./trade-card.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_DIR = path.join(__dirname, ".state");

main().catch((error) => {
  console.error("Unable to render the trade card preview.");
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const outputPath = await renderTradeCardImage({
    analysis: buildPreviewAnalysis(),
    stateDir: STATE_DIR,
  });

  console.log(`Trade card preview written to ${outputPath}`);
}

function buildPreviewAnalysis() {
  return {
    tradeId: "compact-b-preview",
    headlineLabel: "TRADE ALERT",
    leagueName: "Capitol Hill Dynasty",
    acceptedAtLabel: "Accepted Jun 20, 2026 · 10:35 AM ET",
    valueMetaLabel: "DynastyProcess values · Updated Jun 17",
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
