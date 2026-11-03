import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkAiMentionAllowance,
  createEmptyAiMentionState,
  easternDayKey,
  estimateCostUsd,
  normalizeMemberName,
  parseMemberTeams,
  recordAiMentionNotice,
  recordAiMentionUsage,
  rollAiMentionState,
  stripLeadingName,
} from "../ai-mention.js";

const config = { monthlyBudgetUsd: 4, dailyLimit: 2, cooldownSeconds: 60 };
const t0 = new Date("2026-11-02T20:00:00Z"); // 3 PM ET Monday

describe("spend guard", () => {
  it("allows a first question", () => {
    assert.equal(checkAiMentionAllowance(createEmptyAiMentionState(), config, "Jake", t0).allowed, true);
  });

  it("enforces a per-sender cooldown without blocking others", () => {
    const state = createEmptyAiMentionState();
    recordAiMentionUsage(state, "Jake", 0.0005, t0);
    const soon = new Date(t0.getTime() + 30_000);
    assert.equal(checkAiMentionAllowance(state, config, "Jake", soon).reason, "cooldown");
    assert.equal(checkAiMentionAllowance(state, config, "jake ", soon).reason, "cooldown");
    assert.equal(checkAiMentionAllowance(state, config, "Sam", soon).allowed, true);
    assert.equal(checkAiMentionAllowance(state, config, "Jake", new Date(t0.getTime() + 61_000)).allowed, true);
  });

  it("caps the day, notices once, and resets the next Eastern day", () => {
    const state = createEmptyAiMentionState();
    recordAiMentionUsage(state, "Jake", 0.0005, t0);
    recordAiMentionUsage(state, "Sam", 0.0005, t0);

    const first = checkAiMentionAllowance(state, config, "Pat", t0);
    assert.equal(first.reason, "daily limit");
    assert.match(first.notice, /tomorrow/);
    recordAiMentionNotice(state, first.reason);
    assert.equal(checkAiMentionAllowance(state, config, "Pat", t0).notice, null);

    assert.equal(checkAiMentionAllowance(state, config, "Pat", new Date("2026-11-03T20:00:00Z")).allowed, true);
  });

  it("caps the month and resets on the 1st", () => {
    const state = createEmptyAiMentionState();
    rollAiMentionState(state, t0);
    state.monthSpendUsd = 4.01;
    const blocked = checkAiMentionAllowance(state, config, "Pat", t0);
    assert.equal(blocked.reason, "monthly budget");
    assert.ok(blocked.notice);
    assert.equal(checkAiMentionAllowance(state, config, "Pat", new Date("2026-12-01T15:00:00Z")).allowed, true);
  });

  it("accumulates spend and counts", () => {
    const state = createEmptyAiMentionState();
    recordAiMentionUsage(state, "Jake", 0.0008, t0);
    recordAiMentionUsage(state, "Sam", 0.0008, new Date(t0.getTime() + 1000));
    assert.equal(state.monthSpendUsd, 0.0016);
    assert.equal(state.dayCount, 2);
    assert.equal(state.monthQuestions, 2);
  });
});

describe("easternDayKey", () => {
  it("uses the Eastern calendar day, not UTC", () => {
    // 03:00 UTC on Nov 3 is still Nov 2 in New York.
    assert.equal(easternDayKey(new Date("2026-11-03T03:00:00Z")), "2026-11-02");
  });
});

describe("estimateCostUsd", () => {
  it("prices input and output at Haiku 5.5 rates", () => {
    assert.equal(estimateCostUsd({ input_tokens: 6000, output_tokens: 300 }), 0.00075);
    assert.equal(estimateCostUsd(null), 0);
  });
});

describe("stripLeadingName", () => {
  it("drops a vocative name and recapitalizes", () => {
    assert.equal(stripLeadingName("Rowan, you're 5-3.", "Rowan"), "You're 5-3.");
    assert.equal(stripLeadingName("rowan: nah.", "Rowan"), "Nah.");
  });

  it("leaves possessives and sentences about the asker alone", () => {
    assert.equal(stripLeadingName("Rowan's team is solid.", "Rowan"), "Rowan's team is solid.");
    assert.equal(stripLeadingName("Rowan is cooked.", "Rowan"), "Rowan is cooked.");
    assert.equal(stripLeadingName("JoshPT is 7-1.", "Rowan"), "JoshPT is 7-1.");
  });

  it("handles names with regex characters and emoji", () => {
    assert.equal(stripLeadingName("Nick Bowers 🥍, chill.", "Nick Bowers 🥍"), "Chill.");
  });
});

describe("member names", () => {
  it("normalizes case, spacing, and emoji", () => {
    assert.equal(normalizeMemberName("Nick Bowers 🥍"), "nick bowers");
    assert.equal(normalizeMemberName("  CONNOR "), "connor");
    assert.equal(normalizeMemberName("Nick Bowers 🥍"), normalizeMemberName("NICK  BOWERS"));
  });

  it("parses the AI_MENTION_MEMBER_TEAMS list, skipping malformed entries", () => {
    assert.deepEqual(parseMemberTeams("Rowan=pottsey, Matt Hugo=matthugo726, junk, =x, y="), [
      { snapName: "Rowan", teamRef: "pottsey" },
      { snapName: "Matt Hugo", teamRef: "matthugo726" },
    ]);
    assert.deepEqual(parseMemberTeams(undefined), []);
  });
});
