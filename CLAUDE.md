# SnapBot — Sleeper → Snapchat Trade Bot

Node (ESM) bot that watches a Sleeper dynasty league and posts into a Snapchat group chat via
Puppeteer (Snapchat Web automation). See [TRADEBOT_README.md](TRADEBOT_README.md) for the full
user-facing guide and env reference.

## Running / testing

- Always run from this `SnapBot/` directory — `.env` lives here and `dotenv` loads from cwd.
  Use `npm --prefix SnapBot run <script>` if invoking from the parent folder.
- `npm run bot` — live bot loop (`index.js`).
- `npm run test-trade` — queue a fake trade for a *already-running* bot (writes a trigger file
  into `.state/`; the live session picks it up). Does not hit Sleeper.
- `npm run preview-weekly-report -- --previous --week 14` — print the weekly standings + recap
  with no Snapchat. Add `--send` to deliver to the test chat (`TEST_SNAPCHAT_GROUP_CHAT_ID`).
- Dry run of the live path: `$env:DRY_RUN='true'; $env:RUN_ONCE='true'; node index.js`.

## Key files

- `index.js` — live loop: poll Sleeper, grade trades, prime-time send queue, weekly report+recap.
- `weekly-report.js` — standings, Monte Carlo playoff odds, and the weekly recap builder.
- `snapbot.js` — Puppeteer Snapchat automation (login, find chat, type/send messages, attach img).
- `trade-card.js` / `preview-trade-card.js` — image trade cards (when `TRADE_NOTIFICATION_MODE=image`).
- `dynasty-values.js` — DynastyProcess value book; `getPlayerValue()` / `getPickValue()`.
- `roasts.json` / `roast-templates.js` — roast lines + loader.

## Snapchat send gotchas (learned the hard way)

- To send multiple messages in one session, call `bot.openMessagingHome()` **before each**
  `bot.sendMessage()` — the proven pattern used by trade+roast. Opening once and looping
  `sendMessage` drops the first message (chat/textbox not settled).
- Right after a fast cookie-restored login the target chat row may not be rendered yet, so a send
  can fail with "Could not find chat ...". `preview-weekly-report.js` retries once; the live bot
  self-heals via `ensureSnapchatSessionReady` / `restartSnapchatSession`.
- Multi-line messages are typed with Shift+Enter per newline, so leading blank lines in a message
  string render as real spacing.
- Both queued-trade release (`flushQueuedTradeNotifications`) and milestone release
  (`flushMilestones`) send **at most one message per poll cycle** even if several are due at once
  (e.g. multiple trades hitting the same `TRADE_PRIME_TIME_SEND_HOUR_ET` slot) — sending several
  back-to-back risks Snapchat dropping a send mid-burst, on top of looking like spam.

## Division rivalry tracker (Wednesdays, quarterly)

Interdivision bragging-rights post, in `division-rivalry.js`. Not weekly — posted on Wednesday
after the regular-season report cycle, only once each quarter
(`RIVALRY_QUARTER_WEEKS = [4, 7, 11, 14]`), via `pollForDivisionRivalry` in `index.js` (same gate
shape as `pollForWeeklyReport`, using `isWeekdayAfterHourInEastern(now, "Wednesday", ...)`).
`buildDivisionRivalryReport` walks every completed week's matchups and tallies only games where
the two sides are in different `roster.settings.division` values (intra-division games don't
count): the season series record, total points per division, the quarter's biggest
blowout/closest game (via the shared `formatMatchupLine`/`truncateLabel` helpers also used by the
weekly recap), and a per-team interdivision win/loss tally used to call out each division's best
("🔥 MVP") and worst ("🧊 Bust") performer. Division names come from `league.metadata.division_1`/
`division_2` rather than being hardcoded (`getDivisionNames`). The header divider is sized
dynamically (`"—".repeat(headerLine.length - 15)`, floored at `STANDINGS_DIVIDER.length`) — a
divider matching the full header wrapped to a second line on mobile, so it's intentionally
trimmed back from the header's exact width.

`buildAllTimeDivisionSeries` (async, takes `fetchJson`) separately walks the `previous_league_id`
chain like the milestone record book does, re-tallying the same interdivision series across every
prior season — but only seasons whose `division_1`/`division_2` names match the current season's
exactly are counted, since roster IDs and division numbers aren't stable across seasons (a season
with different/no division names is silently skipped rather than mismapped). Called fresh each of
the 4 times per season `pollForDivisionRivalry` actually does work — not cached/state-backed,
since that's cheap enough at this frequency.

Returns `null` (and the poll skips sending) if zero interdivision games have happened
yet — confirmed via replay that this can genuinely occur for a whole quarter if the schedule
clusters intra-division games early. State: `.state/division-rivalry-state.json`, same
season+week dedup shape as weekly-report state. Toggle: `DIVISION_RIVALRY_ENABLED`.
Preview/test: `npm run preview-division-rivalry -- --previous` replays a season through each
quarter boundary; `--send` pushes the most recent one to the test chat.

## Power rankings (Thursdays)

Posted Thursdays at `POWER_RANKING_SEND_HOUR_ET` (default 19), **Weeks 2–14**, once per week,
tracked in `.state/power-rankings-state.json` (also stores `lastRanking.order` for movement
arrows). Each post is titled for the upcoming week (`displayWeek = latestCompletedWeek + 1`) and
ranks through the last completed week; Week 1 is skipped (no games played yet). Power-rankings only — no recap. Built by `buildPowerRankings` / `formatPowerRankingsMessage`
in `weekly-report.js`; scheduled via `pollForPowerRankings` in `index.js` (mirrors
`pollForWeeklyReport`, best-effort send). Composite power score (0–100, mapped to a 40–99 band):
`40% PPG + 25% all-play win% + 20% actual win% + 15% recent form (last 3 wks)` — weights are tunable
consts (`POWER_RANKING_WEIGHTS`) at the top of `weekly-report.js`. No dynasty-value dependency.
Preview/test with `npm run preview-power-rankings` (derives arrows by diffing week W vs W-1).

## Big matchups preview (Thursdays, near Thursday Night Football)

Second, independent Thursday post, in `big-matchups.js`. Not alongside power rankings — gated on
its own `BIG_MATCHUPS_SEND_HOUR_ET`/`BIG_MATCHUPS_SEND_MINUTE_ET` (default 7:45 PM ET, ~30 min
before a typical TNF kickoff) via the new minute-granular `isWeekdayAtOrAfterTimeInEastern`
(`weekly-report.js`) — the existing hour-only gates aren't precise enough for a 30-minute target.
Own state (`.state/big-matchups-state.json`) and dedup, fully independent of
`pollForPowerRankings` so one failing doesn't affect the other. Gated to
`latestCompletedWeek >= BIG_MATCHUPS_MIN_WEEK` (7; one week before milestones' clinch/elim
gate) since playoff odds aren't meaningful earlier.

`buildBigMatchupsReport` takes the same `report.standings` (`playoffOdds`/`rank`) already computed
by `buildWeeklyReport`, plus the upcoming week's matchup pairings, and buckets each real matchup
into **at most one** of (checked in this priority order, tunable thresholds at the top of the
file): 🎯 Elimination Watch, 🔒 Clinch Watch (capped just under the milestone clinch threshold so
the two never overlap), ⚔️ Playoff Showdown (both teams in a contested odds band), 🏗️ Draft
Position Bowl (both teams clearly out). Returns `null` (skip send) if nothing qualifies that week.
Elimination/Clinch lines name the specific team(s) at risk/close (`formatMatchupLine` in
`big-matchups.js`, e.g. "X is in danger of elimination vs. Y", or "X and Y could both clinch a
playoff spot" when both qualify) since those buckets are about individual stakes; Showdown/Draft
Position Bowl stay a plain "X vs. Y" since both teams are equally the point there by definition.

The thresholds were tuned against a real season replay, not guessed — an "either team qualifies"
check for Elimination/Clinch initially classified nearly every matchup nearly every week (defeats
the "marquee" framing), while a "both ≥50%" Showdown check never fired once across 13 weeks (this
league's fixed schedule rarely pairs two similarly-positioned teams together). Tightened bands now
give 2-6 of 6 matchups classified per week instead of a blanket 6/6.
Preview/test: `npm run preview-big-matchups -- --previous` replays Weeks 8-14; `--week N --send`
pushes one specific week to the test chat.

## Rookie draft preview (one-time, lead-time countdown)

Not a recurring weekly post — fires once per season, in `draft-preview.js`, on a countdown before
the rookie draft's own `start_time` (`league.draft_id` → `GET /v1/draft/{id}`) rather than a fixed
weekday/hour gate, so it naturally recurs correctly every year regardless of which day the league
schedules its draft. Gate: `isWithinDraftPreviewWindow(now, draft.start_time,
DRAFT_PREVIEW_LEAD_HOURS)` (default 48h lead). State: `.state/draft-preview-state.json`, keyed by
`draft_id` (one-shot per draft, not season+week — a new draft gets a new `draft_id` next year, so
no extra season-rollover logic is needed). Toggle: `DRAFT_PREVIEW_ENABLED`.

**Round 1 order isn't just `slot_to_roster_id`.** That field only reflects each slot's *originally
assigned* roster — with pick trading on, a slot's real current owner has to be cross-checked
against `GET /v1/league/{id}/traded_picks` (matched on `round`+`season`+`roster_id`, using the
entry's `owner_id` when present). Confirmed against this league's live data: one Round 1 pick is
already traded, and `resolveRoundOneOrder` correctly resolves it to the new owner. Only Round 1 is
shown (plus a "`N` rounds, `M` picks total" summary line) — all 4 rounds would be a wall of text.

**Rookie filtering has a real gotcha:** `years_exp === 0` alone also matches long-retired players
whose historical records never got the field populated (e.g. Kurt Warner shows `years_exp: 0`).
Adding `&& active === true` is what actually narrows the cached player index
(`.state/players-nfl.json`) down to the real current draft class. `selectTopAvailableRookies` then
excludes anyone already on a roster/taxi squad and ranks the rest by
`dynasty-values.js`'s `getPlayerValue()`, showing the top 12 (no raw value numbers shown — same
"keep it casual" precedent as Big Matchups omitting raw odds%).

Preview/test: `npm run preview-draft-preview` (no live state writes); `--send` pushes to the test
chat. No `--previous` mode — unlike the other previews, there's no "replay a past week" concept
here (a past draft's "available rookies" aren't rookies/available anymore).

## Milestone alerts (playoff clinch/elimination + all-time record book)

Event-driven, in `milestones.js`. Detected once when a week's results are final (called from
`refreshMilestones` inside `pollForWeeklyReport`, reusing the already-fetched matchups +
`report.standings`), then each event is queued with a daytime ET release slot (`computeReleaseSlots`)
so they **drip out one at a time** between Tue and the next games instead of dogpiling the recap.
`flushMilestones` (in the main loop) sends **at most one due event per poll cycle** — any backlog
(e.g. after downtime) trickles out one per cycle instead of bursting, which also avoids Snapchat
dropping a message typed during a rapid-fire send.

- **Playoff clinch/bye/elimination** from `report.standings` playoff odds (100%/0% Monte Carlo
  proxy), gated to Week ≥ 8 (`PLAYOFF_ALERT_MIN_WEEK`). Multiple teams crossing the same threshold
  in the same week are grouped into one message (e.g. "Team A, Team B, and Team C have clinched a
  playoff spot!"). `PLAYOFF_ALERTS_ENABLED`.
- **Record book** (highest/lowest week score, biggest blowout, longest win streak ≥ 4): one
  candidate per record per week — never needs grouping, since only one team can hold a given
  record in a given week; seeded all-time from the `previous_league_id` chain
  (`buildRecordBookFromHistory`, regular-season weeks). `RECORD_BOOK_ENABLED`.
- **First run is silent**: `baselineMilestoneState` records current clinches + seeds the book and
  sets `detectedThroughWeek`, so nothing already-passed is announced. Reset per season.
- State: `.state/milestone-state.json` (season, detectedThroughWeek, clinched/byeClinched/eliminated,
  queue) + `.state/record-book.json`. File-backed, loaded/saved per-call. Depends on
  `WEEKLY_REPORTS_ENABLED` (that's where playoff odds are computed).
- Preview/test: `npm run preview-milestones -- --previous` replays a season week-by-week. `--send`
  pushes one sample to the test chat; `--send-all` sends every matching event, `--send-distinct`
  sends one per event subtype, `--type=<clinch|byeClinch|eliminated|record>` and `--week=<N>` filter
  which events are sent.

## Weekly report + recap (Tuesdays)

Sent once per week on Tuesdays after `WEEKLY_REPORT_SEND_HOUR_ET`, weeks 1–14, tracked in
`.state/weekly-report-state.json`. Two messages, in order:

1. **Standings** — `🏈 <League> Week N Standings`, a long em-dash divider, then one block per team:
   medal (🥇🥈🥉) for the top 3 / number otherwise, record, and an indented
   `PF · PO · Bye` line (Bye shown only when > 0). Built by `buildWeeklyReport` /
   `formatWeeklyReportMessage`.
2. **Matchups recap** — `📊 Week N Matchups Recap` (leads with blank lines as a buffer), then
   emoji-labeled blocks: 🔥 Top Score, 🧊 Low Score, 💥 Biggest Blowout, 😬 Closest Game. Built by
   `buildWeeklyRecap` / `formatWeeklyRecapMessage`. Sent best-effort: a recap failure must not
   block `markWeeklyReportSent`, or the standings would resend next cycle.

Formatting constants/helpers live at the top of `weekly-report.js`
(`STANDINGS_DIVIDER`, `formatRankPrefix`, `formatPointsForDisplay`).

## Other notes

- Player index cache TTL is 24h (`PLAYERS_CACHE_TTL_MS` in `index.js`) so freshly-traded players
  don't show as `Player <id>`. Stale-cache warning logs once per outage.
- Secrets (`.env`, `*-cookies.json`) and `.state/` are gitignored — never commit them.
