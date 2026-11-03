import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildTradeAnalysis, getTradeRosterIds } from "../trade-analysis.js";

// Roster 1 sends a 6,000 player + a 3,000 pick for roster 2's 8,000 player, and
// roster 2 throws in $10 FAAB (unvalued). Shaped like a Sleeper transaction.
const trade = {
  transaction_id: "t1",
  type: "trade",
  status: "complete",
  status_updated: Date.parse("2026-11-01T17:00:00Z"),
  roster_ids: [1, 2],
  adds: { p1: 2, p2: 1 },
  drops: { p1: 1, p2: 2 },
  draft_picks: [{ season: "2027", round: 1, roster_id: 1, previous_owner_id: 1, owner_id: 2 }],
  waiver_budget: [{ sender: 2, receiver: 1, amount: 10 }],
};
const playersById = {
  p1: { full_name: "Depth Guy", position: "WR", team: "KC", value: 6000 },
  p2: { full_name: "Star Back", position: "RB", team: "DET", value: 8000 },
};
const rosterLookup = new Map([
  ["1", { roster_id: 1, owner_id: "u1" }],
  ["2", { roster_id: 2, owner_id: "u2" }],
]);
const userLookup = new Map([
  ["u1", { user_id: "u1", display_name: "pottsey", metadata: { team_name: "The Dominican Man" } }],
  ["u2", { user_id: "u2", display_name: "JoshPT" }],
]);
const valueBook = {
  source: "KeepTradeCut",
  sourceDate: "2026-11-02",
  getPlayerValue: (player) => player?.value ?? null,
  getPickValue: () => 3000,
};
const baseOptions = {
  allTrades: [trade],
  league: { name: "Capitol Hill" },
  playersById,
  rosterLookup,
  userLookup,
  valueBook,
  totalRosters: 12,
  roastMode: false,
  roastThreshold: 1000,
};

describe("buildTradeAnalysis", () => {
  const analysis = buildTradeAnalysis(trade, baseOptions);
  const [dominican, josh] = analysis.teams;

  it("builds each side's ledger from adds, drops, picks, and FAAB", () => {
    assert.equal(dominican.label, "The Dominican Man");
    assert.equal(josh.label, "JoshPT");
    assert.deepEqual(
      dominican.sentAssets.map((asset) => asset.title).sort(),
      ["2027 1st", "Depth Guy"]
    );
    assert.deepEqual(
      dominican.receivedAssets.map((asset) => asset.title).sort(),
      ["$10 FAAB", "Star Back"]
    );
    assert.equal(dominican.sentValue, 9000);
    assert.equal(dominican.receivedValue, 8000);
    assert.equal(dominican.unknownAssetCount, 1); // the FAAB
  });

  it("grades with the consolidation premium and stays zero-sum", () => {
    // 1 piece received vs 2 sent -> +27% on the 8,000 bundle = 2,160.
    assert.equal(dominican.receivedConsolidationBonus, 2160);
    assert.equal(dominican.netValue, 1160);
    assert.equal(josh.netValue, -1160);
    assert.equal(dominican.grade, "B");
    assert.equal(josh.grade, "D");
    assert.ok(Math.abs(dominican.gradeScore + josh.gradeScore) < 1e-9);
    assert.equal(dominican.isWinner, true);
    assert.equal(josh.isWinner, false);
  });

  it("renders the post and card metadata", () => {
    assert.equal(analysis.tradeId, "t1");
    assert.equal(analysis.leagueName, "Capitol Hill");
    assert.equal(analysis.valueSourceLabel, "KeepTradeCut");
    assert.match(analysis.acceptedAtLabel, /^Accepted Nov 1, 2026/);
    for (const text of ["The Dominican Man", "JoshPT", "Star Back", "Depth Guy", "2027 1st", "$10 FAAB"]) {
      assert.ok(analysis.textMessage.includes(text), `post is missing "${text}"`);
    }
  });

  it("only roasts when roast mode is on, every asset is valued, and the margin clears the threshold", () => {
    assert.equal(analysis.roastText, null);
    const roastOn = { ...baseOptions, roastMode: true, roastThreshold: 500 };
    // The unvalued FAAB alone blocks a roast -- the margin can't be trusted.
    assert.equal(buildTradeAnalysis(trade, roastOn).roastText, null);

    const noFaab = { ...trade, waiver_budget: [] };
    const options = { ...roastOn, allTrades: [noFaab] };
    assert.equal(typeof buildTradeAnalysis(noFaab, options).roastText, "string");
    assert.equal(buildTradeAnalysis(noFaab, { ...options, roastThreshold: 5000 }).roastText, null);
  });

  it("is unrated without a value book", () => {
    const unrated = buildTradeAnalysis(trade, { ...baseOptions, valueBook: null });
    assert.ok(unrated.teams.every((team) => team.grade === "N/A"));
  });
});

describe("getTradeRosterIds", () => {
  it("returns the trade's roster ids as strings", () => {
    assert.deepEqual(getTradeRosterIds(trade).sort(), ["1", "2"]);
  });
});
