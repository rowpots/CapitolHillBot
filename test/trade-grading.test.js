import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeConsolidationBonus, gradeSwap } from "../trade-grading.js";

describe("computeConsolidationBonus", () => {
  it("rewards the side with fewer pieces, 27% per surplus piece", () => {
    assert.equal(computeConsolidationBonus({ ownCount: 1, otherCount: 2, bundleValue: 1000 }), 270);
  });

  it("caps the premium at 60%", () => {
    assert.equal(computeConsolidationBonus({ ownCount: 1, otherCount: 5, bundleValue: 1000 }), 600);
  });

  it("gives nothing to the side with more or equal pieces", () => {
    assert.equal(computeConsolidationBonus({ ownCount: 2, otherCount: 1, bundleValue: 1000 }), 0);
    assert.equal(computeConsolidationBonus({ ownCount: 1, otherCount: 1, bundleValue: 1000 }), 0);
  });
});

describe("gradeSwap", () => {
  it("grades an even 1-for-1 as an even swap", () => {
    const result = gradeSwap({
      sentValue: 5000,
      receivedValue: 5000,
      sentCount: 1,
      receivedCount: 1,
      knownValueCount: 2,
    });
    assert.equal(result.grade, "C");
    assert.equal(result.gradeLabel, "Even swap");
    assert.equal(result.score, 0);
  });

  it("is zero-sum: the two sides' scores cancel", () => {
    const sides = { sentCount: 2, receivedCount: 1, knownValueCount: 3 };
    const a = gradeSwap({ ...sides, sentValue: 6000, receivedValue: 7000 });
    const b = gradeSwap({
      sentValue: 7000,
      receivedValue: 6000,
      sentCount: 1,
      receivedCount: 2,
      knownValueCount: 3,
    });
    assert.ok(Math.abs(a.score + b.score) < 1e-9);
  });

  it("applies the consolidation premium to the one-piece side", () => {
    // 2-for-1 at equal raw value: the single great player is worth more.
    const result = gradeSwap({
      sentValue: 6000,
      receivedValue: 6000,
      sentCount: 2,
      receivedCount: 1,
      knownValueCount: 3,
    });
    assert.equal(result.receivedConsolidationBonus, 1620);
    assert.equal(result.rawNetValue, 0);
    assert.equal(result.netValue, 1620);
    assert.equal(result.grade, "B");
  });

  it("labels a lopsided loss as robbed blind", () => {
    const result = gradeSwap({
      sentValue: 9000,
      receivedValue: 1000,
      sentCount: 1,
      receivedCount: 1,
      knownValueCount: 2,
    });
    assert.equal(result.grade, "F");
    assert.equal(result.gradeLabel, "Robbed blind");
  });

  it("is unrated when nothing has a known value", () => {
    const result = gradeSwap({ sentValue: 0, receivedValue: 0, sentCount: 0, receivedCount: 0, knownValueCount: 0 });
    assert.equal(result.grade, "N/A");
  });
});
