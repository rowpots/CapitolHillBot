import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findLatestCompletedWeek } from "../weekly-report.js";

const scored = (points) => ({ roster_id: 1, matchup_id: 1, points });

describe("findLatestCompletedWeek", () => {
  it("returns the latest week with any scored matchup", () => {
    const byWeek = { 1: [scored(110)], 2: [scored(95)], 3: [scored(0)] };
    assert.equal(findLatestCompletedWeek(byWeek, 14), 2);
  });

  it("is 0 before any points are posted", () => {
    assert.equal(findLatestCompletedWeek({ 1: [scored(0)] }, 14), 0);
    assert.equal(findLatestCompletedWeek({}, 14), 0);
  });

  it("ignores entries without a matchup (byes) and prefers custom_points", () => {
    assert.equal(findLatestCompletedWeek({ 1: [{ roster_id: 1, matchup_id: null, points: 120 }] }, 14), 0);
    assert.equal(
      findLatestCompletedWeek({ 1: [{ roster_id: 1, matchup_id: 2, points: 0, custom_points: 101 }] }, 14),
      1
    );
  });

  // The blind spot the ESPN/Sleeper ceiling exists for: one Thursday game puts
  // points on the board, and this alone calls the week complete.
  it("calls a week complete off a single game (why the ceiling clamp exists)", () => {
    const byWeek = { 12: [scored(130)], 13: [scored(14.2)] };
    assert.equal(findLatestCompletedWeek(byWeek, 14), 13);
  });

  it("never looks past the regular-season end", () => {
    assert.equal(findLatestCompletedWeek({ 14: [scored(90)], 15: [scored(80)] }, 14), 14);
  });
});
