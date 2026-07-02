# SnapBot — Sleeper → Snapchat Trade Bot

Node (ESM) bot that watches a Sleeper dynasty league and posts into a Snapchat group chat via
Puppeteer. **[TRADEBOT_README.md](TRADEBOT_README.md)** is the full user guide + complete env
reference. **[FEATURE_STATUS.md](FEATURE_STATUS.md)** is the feature inventory + pre-season test
checklist (what's verified vs. what still needs a live shakedown). This file is the terse
engineering map — keep it lean.

## Running / testing

- Always run from this `SnapBot/` dir (`.env` + `dotenv` load from cwd; use `npm --prefix SnapBot
  run <script>` from the parent).
- `npm run bot` — live loop (`index.js`). `npm run test-trade` — queue a fake trade for an
  *already-running* bot (writes a `.state/` trigger; no Sleeper call).
- Dry run of the live path: `$env:DRY_RUN='true'; $env:RUN_ONCE='true'; node index.js`.
- Every scheduled feature has a `npm run preview-<feature>` script (mostly `--previous [--week N]
  [--send] [--chat-id <id>]`). `--send` targets `TEST_SNAPCHAT_GROUP_CHAT_ID`. See the table below.

## Key files

- `index.js` — live loop: poll Sleeper, grade trades, prime-time send queue, and call every
  `pollForX` + `runFeatureModules()`.
- `weekly-report.js` — standings, Monte Carlo playoff odds, weekly recap, power rankings, **and the
  shared label/pairing/ET-time helpers** (`formatRosterLabel`, `normalizeWeekEntries`,
  `groupWeekEntriesByMatchup`, `getEasternDateParts`, `isWeekdayAtOrAfterTimeInEastern`, …) reused
  everywhere.
- `snapbot.js` — Puppeteer Snapchat automation (login, find chat, type/send, attach image, read
  chat).
- `player-points.js` — per-player extraction from raw `starters`/`players_points`
  (`extractStarterPointsForRoster`, `findTopPerformances`).
- `dynasty-values.js` — DynastyProcess value book + `loadValueBook` source dispatcher
  (`getPlayerValue` / `getPickValue`).
- `ktc-values.js` — KeepTradeCut value book (same shape), selected via `VALUE_SOURCE=ktc`.
- `value-shared.js` — shared value-mode resolution + name/label normalization helpers used by
  both value-book sources.
- `roasts.json` / `roast-templates.js` — roast lines + loader.

## Snapchat send gotchas (learned the hard way — don't regress these)

- **Call `bot.openMessagingHome()` before *each* `bot.sendMessage()`** when sending multiple in one
  session. Opening once and looping drops the first message (chat/textbox not settled).
- **At most one message per poll cycle.** Queued-trade release, `flushMilestones`, and live-scoring
  all send one even when several are due — back-to-back sends get dropped mid-burst by Snapchat and
  look like spam. Backlog trickles out one per cycle.
- Right after a fast cookie-restored login the chat row may not be rendered → send fails with
  "Could not find chat …". Previews retry (`sendMessageWithRetry`, default 4 attempts); the live bot
  self-heals via `ensureSnapchatSessionReady` / `restartSnapchatSession`.
- Multi-line messages type Shift+Enter per `\n`, so leading blank lines render as real spacing
  (used intentionally as a buffer on some posts).
- Reads (`readChatMessages`): scrape `#cv-<chatId>`, one `li.T1yt2` per sender block; sender name
  from `header .nonIntl` is **carried forward** across header-less continuation messages; text is
  `span.ogn1z`. Border colors are per-member and unreliable — never key on them.

## Scheduled feature catalog

All gated by an `.env` toggle, dedup'd via per-`(season, week)` or `sentBySeason` JSON state under
`.state/`, and previewable. Cadence is Eastern-time.

| Feature | File | Cadence / trigger | Toggle | State file |
|---|---|---|---|---|
| Trade notify + grade | `index.js`, `trade-card.js` | live, prime-time queue | (core) | `runtime-state.json`, `trade-history.json` |
| Weekly report + recap | `weekly-report.js` | Tue, wks 1-14 | `WEEKLY_REPORTS_ENABLED` | `weekly-report-state.json` |
| Power rankings | `weekly-report.js` | Thu, wks 2-14 | `POWER_RANKINGS_ENABLED` | `power-rankings-state.json` |
| Milestone alerts | `milestones.js` | event, drip on week-final | `PLAYOFF_ALERTS_ENABLED`, `RECORD_BOOK_ENABLED` | `milestone-state.json`, `record-book.json` |
| Division rivalry | `division-rivalry.js` | Wed after wks 4/7/11/14 | `DIVISION_RIVALRY_ENABLED` | `division-rivalry-state.json` |
| Big matchups preview | `big-matchups.js` | Thu ~19:45, wks ≥7 | `BIG_MATCHUPS_ENABLED` | `big-matchups-state.json` |
| Rookie draft preview | `draft-preview.js` | once, 48h before draft | `DRAFT_PREVIEW_ENABLED` | `draft-preview-state.json` |
| Draft results snapshot | `draft-results.js` | once, on draft complete (silent) | `DRAFT_RESULTS_SNAPSHOT_ENABLED` | `draft-results-state.json` |
| Playoffs (3 posts) | `playoffs.js` | wks 15-17 (reveal/weekly/recap) | `PLAYOFF_*_ENABLED` | `playoff-{bracket,weekly,recap}-state.json` |
| Awards ceremony | `awards.js` | season end (after recap) | `AWARDS_CEREMONY_ENABLED` | (in recap flow) |
| Hall of Fame | `hall-of-fame.js` | season end (after awards) | `HALL_OF_FAME_ENABLED` | `hall-of-fame.json` |
| Chat commands (`!`) | `chat-commands.js` | live, reads group chat | `CHAT_COMMANDS_ENABLED` | `chat-commands-state.json` |
| Live in-game scoring | `live-scoring.js`, `nfl-schedule.js` | game windows (opt-in) | `LIVE_SCORING_ENABLED` (default **false**) | `live-scoring-state.json` |

## Non-obvious gotchas by feature (the landmines)

- **Weekly recap** is sent **best-effort after** the standings — a recap failure must not block
  `markWeeklyReportSent`, or standings resend next cycle.
- **Power rankings**: Week 1 skipped (no games); each post titled for the *upcoming* week
  (`latestCompletedWeek + 1`). Composite score weights are tunable consts (`POWER_RANKING_WEIGHTS`,
  top of `weekly-report.js`): 40% PPG / 25% all-play / 20% win% / 15% last-3 form.
- **Big matchups**: needs a minute-granular gate (`isWeekdayAtOrAfterTimeInEastern`) for the ~30-min
  pre-TNF target. Each matchup gets **at most one** bucket (Elim → Clinch → Showdown → Draft Bowl);
  returns `null` (skip) if nothing qualifies. Thresholds at top of file were tuned against a real
  replay — don't loosen blindly (an "either qualifies" check classified ~6/6 every week).
- **Division rivalry**: only interdivision games count. All-time series only sums prior seasons
  whose `division_1`/`division_2` names match the current ones (roster IDs/division numbers aren't
  stable across seasons). Returns `null` if zero interdivision games yet (can genuinely happen a
  whole quarter).
- **Draft preview**: Round 1 owner is **not** just `slot_to_roster_id` — cross-check
  `GET /league/{id}/traded_picks` (`round`+`season`+`roster_id`, prefer `owner_id`). Rookie filter
  needs `years_exp === 0 && active === true` (`years_exp 0` alone matches retired players like Kurt
  Warner). Keyed by `draft_id` (auto-rolls per year). Draft **results** snapshot needs no
  traded-picks cross-ref (`/draft/{id}/picks` already has real owners).
- **Playoffs**: Sleeper's `winners_bracket` returns a fully-shaped **placeholder until the regular
  season is complete** — nothing trusts it until `latestCompletedWeek >= REGULAR_SEASON_END_WEEK`
  (`isBracketTrustworthy`). `resolveBracketSlot` recurses `t1_from`/`t2_from` `{w}`/`{l}` into
  "Winner of (A vs B)" placeholders; same fn does the reveal projection and the weekly real-name
  fill-in. Pollers **baseline silently** on first sighting of a new season so a restart mid-playoffs
  doesn't post a stale reveal/preview.
- **Awards / HoF**: trade grades are now persisted every `pollForTrades` cycle into
  `trade-history.json` (`grades[]` + `season`) — that's what Best/Worst Trade reads. HoF is keyed by
  **franchise (`roster_id`, stable across `previous_league_id` rollover)**, rendered under the slot's
  *current* owner, so a team's history follows a takeover. `mergeSeasonIntoHallOfFame` no-ops if
  `lastMergedSeason === season` and persists **before** the send (transient send failure would else
  double-count). First run walks the chain (incl. current season); later years fold one season in.
- **Chat commands**: signature = `sender::normalized-text` (no message IDs; messages ephemeral
  ~24h). **Primes** on first run (seeds visible commands as handled, no backlog reply). 200-entry
  ring. `buildMatchupPairings` (all) vs `filterMatchupPairings` (one team) are separate so "no
  schedule this week" (fall through to prev season) ≠ "team not playing". `!trade` name resolver
  skips empty-normalized keys (a bare "Jr" would else match everyone).
- **Milestones**: detect once at week-final (inside `pollForWeeklyReport`), queue each with a
  daytime release slot, drip one per cycle. Playoff clinch/elim only from Week ≥8. First run
  `baselineMilestoneState` (silent). Record book seeded all-time from the chain.

## Feature-module registry + live in-game scoring

New scheduled features no longer get a bespoke `pollForX`. They export
`{ id, shouldRun(ctx), run(ctx) }` and register in `FEATURE_MODULES` (top of `index.js`);
`runFeatureModules()` runs them once per cycle with a per-module try/catch and a shared
`buildFeatureContext()` (`leagueId`, `dryRun`, `stateDir`, `now`, `logger`, `fetchJson`,
`loadPlayersById`, `sendMessage`). First concrete step of the deferred `index.js` slim-down; legacy
pollers migrate opportunistically.

`live-scoring.js` is the first module. Master `LIVE_SCORING_ENABLED` defaults **false** (noisier
than weekly posts); reads all its own env via `loadLiveScoringConfig()`. `LIVE_SCORING_CHAT_ID`
(read in `index.js`'s `buildFeatureContext`, not the module) routes feature-module sends to a
separate chat (e.g. the test chat) for in-season verification while the rest of the bot posts to the
league chat; blank → main chat. `shouldRun` gates cheaply
on `isWithinGameWindow` (Thu 20-23, Sun 13-23, Mon 20-23 ET) before any fetch. Pure exported
builders for preview/reuse. Five post types, one sent per cycle (priority order in
`collectDueMessages`):

1. **Last-game alert** (highest priority) — "going into MNF, Team X needs Y with N to play". Needs
   game status Sleeper lacks → `nfl-schedule.js` pulls the **free ESPN public scoreboard** (no key;
   `parseScoreboard` pure for tests; abbrevs normalized ESPN→Sleeper: WSH→WAS, JAC→JAX, OAK→LV,
   LA/STL→LAR, SD→LAC). Schedule fetched only Mon full window / any late window.
   `isOnlyLastGameRemaining` gates it (all earlier games `post`, final slot `pre`/`in`). Fires once
   per trailing roster/week, deficit ≤ `LIVE_LAST_GAME_MAX_DEFICIT` (30).
2. **Big-performance** — starter ≥ `LIVE_BIG_PERFORMANCE_THRESHOLD` (35); `players_points` scanned
   first so `loadPlayersById` is only fetched when needed.
3. **Nailbiter** / **upset** — `isLateGameWindow` only, and only once combined score ≥
   `LIVE_MIN_COMBINED_FOR_ALERT` (120; avoids "0.0 vs 0.0 nailbiter"). Upset uses roster
   `settings` W/L (no Monte Carlo).
4. **Snapshots** — once per `SNAPSHOT_CHECKPOINTS` time (at-or-after gate).

State per `(season, week)`: `sentSnapshots` + `firedSignatures` 200-ring, reset on week rollover.
**Tier B still open**: make the nailbiter itself game-status-aware (only fire when genuinely live)
+ a general "you need X" for any remaining-players spot — reuse `buildRemainingByRosterId` /
`getTeamState`.

## Other notes

- Player index cache TTL 24h (`PLAYERS_CACHE_TTL_MS`) so freshly-traded players don't render as
  `Player <id>`. Stale-cache warning logs once per outage.
- Secrets (`.env`, `*-cookies.json`) and `.state/` are gitignored — never commit them.
- Commit messages: no Claude/co-author attribution trailers.
