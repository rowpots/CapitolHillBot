import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isGameSettled,
  normalizeTeamAbbrev,
  parseScoreboard,
  resolveCompletedWeekCeiling,
  resolveCompletedWeekCeilingFromSleeperState,
} from "../nfl-schedule.js";

function espnEvent(home, away, state, name = "STATUS_FINAL", date = "2026-11-01T18:00Z") {
  return {
    competitions: [
      {
        date,
        status: { type: { state, name } },
        competitors: [{ team: { abbreviation: home } }, { team: { abbreviation: away } }],
      },
    ],
  };
}

describe("parseScoreboard", () => {
  it("extracts season, week, and per-game state with normalized abbrevs", () => {
    const parsed = parseScoreboard({
      season: { year: 2026, type: 2 },
      week: { number: 9 },
      events: [espnEvent("WSH", "JAC", "post"), espnEvent("KC", "BUF", "pre", "STATUS_SCHEDULED")],
    });
    assert.equal(parsed.season, "2026");
    assert.equal(parsed.seasonType, 2);
    assert.equal(parsed.week, 9);
    assert.deepEqual(parsed.games[0].teams, ["WAS", "JAX"]);
    assert.equal(parsed.games[1].state, "pre");
    assert.equal(parsed.games[0].kickoffMs, Date.parse("2026-11-01T18:00Z"));
  });

  it("tolerates an empty or malformed payload", () => {
    assert.deepEqual(parseScoreboard(null).games, []);
  });
});

describe("normalizeTeamAbbrev", () => {
  it("maps ESPN codes to Sleeper's", () => {
    assert.equal(normalizeTeamAbbrev("wsh"), "WAS");
    assert.equal(normalizeTeamAbbrev("LA"), "LAR");
    assert.equal(normalizeTeamAbbrev("KC"), "KC");
  });
});

describe("isGameSettled", () => {
  it("counts finals and canceled/postponed games as settled", () => {
    assert.equal(isGameSettled({ state: "post" }), true);
    assert.equal(isGameSettled({ state: "pre", statusName: "STATUS_POSTPONED" }), true);
    assert.equal(isGameSettled({ state: "in", statusName: "STATUS_IN_PROGRESS" }), false);
  });
});

describe("resolveCompletedWeekCeiling (ESPN)", () => {
  it("is the current week once every game is settled", () => {
    const schedule = { week: 8, seasonType: 2, games: [{ state: "post" }, { state: "post" }] };
    assert.equal(resolveCompletedWeekCeiling(schedule), 8);
  });

  it("is the previous week while any game is pending (Thanksgiving Thursday)", () => {
    const schedule = { week: 13, seasonType: 2, games: [{ state: "post" }, { state: "pre" }] };
    assert.equal(resolveCompletedWeekCeiling(schedule), 12);
  });

  it("handles preseason, postseason, and unknown weeks", () => {
    assert.equal(resolveCompletedWeekCeiling({ week: 2, seasonType: 1, games: [] }), 0);
    assert.equal(resolveCompletedWeekCeiling({ week: 1, seasonType: 3, games: [] }), null);
    assert.equal(resolveCompletedWeekCeiling({ week: null }), null);
  });
});

describe("resolveCompletedWeekCeilingFromSleeperState (fallback)", () => {
  // Real payload from GET /v1/state/nfl at ~11 AM ET Tue 2026-11-03, right after
  // Week 8's MNF. The 2026 season opened Wednesday 2026-09-09.
  const state = (overrides = {}) => ({
    week: 9,
    display_week: 8,
    season: "2026",
    season_type: "regular",
    season_start_date: "2026-09-09",
    ...overrides,
  });
  const ceiling = (s, iso, season = "2026") =>
    resolveCompletedWeekCeilingFromSleeperState(s, season, new Date(iso));

  it("counts the just-finished week on Tuesday morning", () => {
    assert.equal(ceiling(state(), "2026-11-03T16:00:00Z"), 8); // 11 AM ET
  });

  it("is on time for the 10 AM Tuesday report even if Sleeper hasn't bumped its week", () => {
    assert.equal(ceiling(state({ week: 8 }), "2026-11-03T15:00:00Z"), 8); // 10 AM ET
  });

  it("doesn't count the week until MNF is over (before 4 AM Tuesday ET)", () => {
    assert.equal(ceiling(state({ week: 8 }), "2026-11-03T02:00:00Z"), 7); // Mon 9 PM ET
    assert.equal(ceiling(state({ week: 8 }), "2026-11-03T08:00:00Z"), 7); // Tue 3 AM ET
    assert.equal(ceiling(state({ week: 8 }), "2026-11-03T10:00:00Z"), 8); // Tue 5 AM ET
  });

  it("blocks Thanksgiving's in-progress Week 12 from counting as complete", () => {
    // Thu 2026-11-26, 7 PM ET: two Thanksgiving games already have points.
    assert.equal(ceiling(state({ week: 12, display_week: 12 }), "2026-11-27T00:00:00Z"), 11);
  });

  it("handles the Wednesday Week 1 opener and the first Tuesday after it", () => {
    assert.equal(ceiling(state({ week: 1, display_week: 1 }), "2026-09-10T23:00:00Z"), 0);
    assert.equal(ceiling(state({ week: 2, display_week: 1 }), "2026-09-15T14:00:00Z"), 1);
  });

  it("never runs ahead of Sleeper's own week", () => {
    // Calendar says 8 are done, but a lagging/odd Sleeper week of 5 wins.
    assert.equal(ceiling(state({ week: 5 }), "2026-11-03T16:00:00Z"), 5);
  });

  it("falls back to week - 1 without a usable season start date", () => {
    assert.equal(ceiling(state({ season_start_date: undefined }), "2026-11-03T16:00:00Z"), 8);
  });

  it("handles preseason, postseason, offseason, and bad payloads", () => {
    assert.equal(ceiling({ season: "2026", season_type: "pre", week: 0 }, "2026-08-20T12:00:00Z"), 0);
    assert.equal(ceiling({ season: "2026", season_type: "post", week: 2 }, "2027-01-20T12:00:00Z"), null);
    assert.equal(ceiling({ season: "2026", season_type: "off" }, "2027-03-01T12:00:00Z"), null);
    assert.equal(resolveCompletedWeekCeilingFromSleeperState(null), null);
  });

  it("treats a past league season as fully played and a future one as unplayed", () => {
    assert.equal(ceiling(state(), "2026-11-03T16:00:00Z", "2025"), null);
    assert.equal(ceiling(state(), "2026-11-03T16:00:00Z", "2027"), 0);
  });
});
