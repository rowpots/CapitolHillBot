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
  // Real payload from GET /v1/state/nfl on Tue 2026-11-03, right after Week 8's MNF.
  const tuesdayAfterWeek8 = {
    week: 9,
    display_week: 8,
    season: "2026",
    season_type: "regular",
  };

  it("treats the week before Sleeper's week as the last completed one", () => {
    assert.equal(resolveCompletedWeekCeilingFromSleeperState(tuesdayAfterWeek8, "2026"), 8);
  });

  it("blocks an in-progress Thanksgiving week from counting as complete", () => {
    const thanksgiving = { ...tuesdayAfterWeek8, week: 13, display_week: 13 };
    assert.equal(resolveCompletedWeekCeilingFromSleeperState(thanksgiving, "2026"), 12);
  });

  it("handles the Wednesday Week 1 opener and preseason", () => {
    assert.equal(resolveCompletedWeekCeilingFromSleeperState({ ...tuesdayAfterWeek8, week: 1 }, "2026"), 0);
    assert.equal(resolveCompletedWeekCeilingFromSleeperState({ season: "2026", season_type: "pre", week: 0 }, "2026"), 0);
  });

  it("has no opinion in the postseason/offseason or with a bad payload", () => {
    assert.equal(resolveCompletedWeekCeilingFromSleeperState({ season: "2026", season_type: "post", week: 2 }), null);
    assert.equal(resolveCompletedWeekCeilingFromSleeperState({ season: "2026", season_type: "off" }), null);
    assert.equal(resolveCompletedWeekCeilingFromSleeperState(null), null);
  });

  it("treats a past league season as fully played and a future one as unplayed", () => {
    assert.equal(resolveCompletedWeekCeilingFromSleeperState(tuesdayAfterWeek8, "2025"), null);
    assert.equal(resolveCompletedWeekCeilingFromSleeperState(tuesdayAfterWeek8, "2027"), 0);
  });
});
