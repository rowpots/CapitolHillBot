# SnapBot Feature Status & Pre-Season Test Checklist

Inventory of every feature and where it stands on testing, so we can do one focused QA pass before
the season ships. Three tiers:

- **Tier 1 — Fully tested.** Proven correct *and* observed running live. Nothing to do.
- **Tier 2 — Logic validated, needs a live smoke test.** Built, committed/pushed, and verified via
  `--previous` replay and/or test-chat sends. The *logic* is solid; what's unconfirmed is the live
  schedule gate actually firing on its own at the real trigger. Quick to check.
- **Tier 3 — Needs real live testing.** Only ever validated against historical/simulated data.
  Behavior on **live, in-progress game data** (or a real season-event trigger) is unproven. Highest
  risk — do these first.

"Validated" here means a preview script reproduced correct output against real past-season data.
"Live-tested" means a message was actually pushed to the test chat
(`TEST_SNAPCHAT_GROUP_CHAT_ID = 712a89c2-d7a6-4686-9aad-af62571be8ec`). Sending to the **live**
league chat is outward-facing — confirm before doing it.

---

## Tier 1 — Fully tested (no action needed)

- [x] **Trade notifications + grading** — the original core. Live prime-time send queue, dynasty
  values, history lines, roast hook. Battle-tested in production.
- [x] **Weekly standings + recap (Tue, wks 1-14)** — runs weekly in production; Monte Carlo playoff
  odds, superlatives recap (best-effort second message).
- [x] **Power rankings (Thu, wks 2-14)** — *promoted from Tier 2 on 2026-06-26.* Content validated
  against real 2025 data (`preview-power-rankings --previous`, wks 8 + 14: scores in the 40-99 band,
  medals, movement arrows all correct). Scheduling reuses the **identical** proven machinery as the
  Tuesday report — `isThursdayAfterHourInEastern` (same date-gate family) + the same
  `hasSentWeeklyReport`/`markWeeklyReportSent` dedup, with the 2-14 window gate
  (`latestCompletedWeek < 1` skip / `> REGULAR_SEASON_END_WEEK` stop). Same code path that already
  fires live every Tuesday, so no separate live shakedown needed.
- [x] **Division rivalry (Wed after wks 4/7/11/14)** — *promoted from Tier 2 on 2026-06-26.* Content
  validated against real 2025 data across all four quarter boundaries
  (`preview-division-rivalry --previous`): wk4 correctly skipped (no interdivision games yet — the
  null-skip path), wks 7/11/14 full posts (series record, all-time tally, blowout/closest,
  MVP/Bust). Confirmed the live league has divisions configured (Republicans/Democrats), so it will
  actually fire. Scheduling reuses the **identical** proven machinery as the Tuesday report —
  `isWeekdayAfterHourInEastern(…, "Wednesday", …)` + the same `hasSentWeeklyReport`/
  `markWeeklyReportSent` dedup, gated to `RIVALRY_QUARTER_WEEKS`; all-time walk wrapped in try/catch.
  No separate live shakedown needed.
- [x] **Big matchups preview (Thu ~19:45, wks ≥7)** — *promoted from Tier 2 on 2026-06-26.* Content
  validated against real 2025 data (`preview-big-matchups --previous`, wks 8-14): varied bucket
  classification (🎯 Elim / 🔒 Clinch / ⚔️ Showdown / 🏗️ Draft Bowl), **not** a degenerate 6/6 every
  week (wk8=1 bucket, wk11=all four), at-risk teams named correctly incl. "could both clinch"
  grouping. The one piece not shared with the proven machinery — the minute-granular gate
  `isWeekdayAtOrAfterTimeInEastern` — was **directly boundary-tested 7/7** (fires at Thu 19:45 not
  19:44, stays true later that evening, rejects Fri + Wed, DST-aware). Week range (≥7 →14) + dedup
  reuse the same `hasSentWeeklyReport`/`markWeeklyReportSent`; null-skip + dry-run honored. No
  separate live shakedown needed.
- [x] **Milestone alerts (clinch/elim + record book)** — *promoted from Tier 2 on 2026-06-26.*
  Detection validated against real 2025 data (`preview-milestones --previous`, 24 events): record-book
  lineage (highest/lowest/blowout/win-streak with correct "Previous:" refs), single + grouped
  clinches, first-round-bye grouping, single + grouped eliminations. Drip scheduler
  `computeReleaseSlots` boundary-tested (daytime ET slots only, spreads across consecutive days on a
  backlog, never overnight, exact count, sorted). `flushMilestones` sends one event/cycle and stays
  queued on send failure (inspected). Silent first-run baseline verified by inspection (same seeded
  pattern the preview exercises). Depends on `WEEKLY_REPORTS_ENABLED` (where playoff odds compute).

---

## Tier 2 — Logic validated, needs a live smoke test

These are committed/pushed and replay/test-chat verified. The pre-season task for each is just:
**confirm it fires on its own at the right ET time on the live loop** (run the bot with the feature
enabled and `DRY_RUN=true` around the trigger, or do a one-off test-chat send to re-eyeball format).

- [ ] **Two-way chat commands (`!help/standings/record/power/matchup/trade/hof`)** —
  `npm run preview-chat-commands`. Verify live: priming on startup (no backlog reply), dedup ring,
  read-retry resilience, offseason→in-season standings source switch.
- [ ] **Rookie draft preview (once, 48h pre-draft)** — `npm run preview-draft-preview`. **Event-gated:**
  can only fully fire on the real draft countdown. Verify: Round 1 traded-pick resolution + rookie
  filter (`years_exp===0 && active===true`) against the actual 2026 class; countdown window gate.
- [ ] **Draft results snapshot (once, on draft complete, silent)** — no preview (silent capture).
  Verify on draft day: snapshot writes on `draft.status === "complete"`; feeds Awards Steal/Bust.
- [ ] **Playoffs — bracket reveal / weekly report / championship+season recap (wks 15-17)** —
  `npm run preview-playoff-bracket -- --previous` and `npm run preview-playoff-weekly-report --
  --previous`. **Event-gated:** replay-tested on a finished season only. Verify in-season: the
  `isBracketTrustworthy` gate (don't trust bracket before regular season ends) and silent baselining
  on a mid-playoff restart.
- [ ] **Season awards + Hall of Fame (season end)** — `npm run preview-awards -- --previous` and
  `npm run preview-hall-of-fame`. Content live-tested. **Event-gated:** the actual season-end
  auto-fire (after wk17 final, in `pollForPlayoffRecap`) and the HoF merge-before-send idempotency
  haven't run on a live season-close yet.
- [ ] **KTC value source (`VALUE_SOURCE=ktc`)** — DynastyProcess stays the default (Tier 1,
  unchanged). KTC path validated via scratch scripts: live fetch from
  `keeptradecut.com/dynasty-rankings` (no Puppeteer needed, data's a plain embedded JS array),
  `getPlayerValue`/`getPickValue` correct against real values, Early>Mid>Late tier ordering
  confirmed, stale-cache fallback confirmed on simulated network failure, and the `!trade` command
  end-to-end in both modes. Not yet run inside the live bot's poll loop — verify one real trade
  grades correctly with `VALUE_SOURCE=ktc` set before trusting it for a league.

---

## Tier 3 — Needs real live testing (do first)

Only validated against historical / simulated data. The live game-day behavior is genuinely
unproven. **Plan: run the bot with `LIVE_SCORING_ENABLED=true` and `DRY_RUN=true` during a real
NFL game window early in the season and watch the logs before letting it post for real.**

- [ ] **Feature-module registry live path** — `runFeatureModules()` has never run a module that
  actually does work on the live loop (`live-scoring` is the only module and defaults off). Confirm
  the per-module try/catch isolation and `buildFeatureContext` wiring behave live.
- [ ] **Live score snapshots** — checkpoints (`SNAPSHOT_CHECKPOINTS`) must fire at the right ET
  times during real Sunday/Thu/Mon windows. Never run live. Verify: window gating, one-per-cycle
  drip, dedup across real cycles.
- [ ] **Big-performance alerts** — only validated on completed-week `players_points`. Verify it
  triggers on **live-updating** scores and that `loadPlayersById` is fetched only when a starter is
  actually over threshold.
- [ ] **Nailbiter alerts** — validated on final scores only. Known gap: not yet game-status-aware,
  so it can flag a game that's actually *final* as a nailbiter (**Tier B fix open**). Verify the
  `isLateGameWindow` + `LIVE_MIN_COMBINED_FOR_ALERT` gates live.
- [ ] **Upset alerts** — validated on final scores only. Verify the underdog-leading logic against
  live in-progress scores.
- [ ] **Last-game alert ("Team X needs Y with N to play")** — validated via `simulateGoingIntoLastGame`
  against past weeks. The ESPN **in-progress (`in`) game state** can only be confirmed on a real
  game day; only `pre`/`post` parsing is proven (vs. real 2025 wk14 — LAC/PHI MNF). Verify
  end-to-end on a real MNF.
- [ ] **ESPN scoreboard integration (`nfl-schedule.js`)** — `parseScoreboard` unit-validated on real
  data, but ESPN is an **unofficial** feed. Confirm live `in` states, and that abbrev normalization
  + `isOnlyLastGameRemaining` hold across a full live week.

---

## How to run the pre-season pass

1. **Tier 3 first**, during real games. Two safe ways to watch it against live data without spamming
   the league chat:
   - **Test-chat override (recommended):** on your normal live bot, set `LIVE_SCORING_ENABLED=true`
     and `LIVE_SCORING_CHAT_ID` = your `TEST_SNAPCHAT_GROUP_CHAT_ID` value. The bot keeps posting
     trades/weekly/etc. to the league chat as usual, but live-scoring messages go **only to the test
     chat**, so you can eyeball real sends on your phone through a Sunday + a Monday-night (all five
     post types). When you're ready to roll out, blank `LIVE_SCORING_CHAT_ID` (or point it at the
     main chat).
   - **Shadow dry-run (zero send):** a second copy of the folder with its own `.state/`,
     `LIVE_SCORING_ENABLED=true` + `DRY_RUN=true`. It never logs into Snapchat and never sends — just
     prints every alert + gate decision to its console while the games play, fully isolated from your
     live bot.
2. **Tier 2 event-gated** (draft preview, draft snapshot, playoffs, awards/HoF): these can only
   fully fire at their real moments — schedule a reminder to watch the logs on draft day, the wk15
   Tuesday, and the post-championship Tuesday. Re-run their `--previous` previews now to confirm
   nothing regressed on 2026 data.
3. **Tier 2 weekly** (power rankings, milestones, rivalry, big matchups, chat commands): one live
   `DRY_RUN=true` week early in the season confirms all the schedule gates at once.
