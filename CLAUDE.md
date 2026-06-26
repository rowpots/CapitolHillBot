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

## Playoffs (bracket reveal, weekly report, championship + season recap)

Four messages covering weeks 15-17 (`playoff_week_start` + 3 rounds for this league's 6-team/
2-bye format), all in `playoffs.js`, all gated behind `isBracketTrustworthy` — Sleeper's
`GET /v1/league/{id}/winners_bracket` returns a fully-shaped but meaningless placeholder bracket
(confirmed: even a not-yet-started season already returns one, with arbitrary roster IDs) until
the regular season is actually complete, so nothing here trusts that endpoint until
`latestCompletedWeek >= REGULAR_SEASON_END_WEEK`.

- **Bracket Reveal** — one-time, Tuesday (reuses `weeklyReportSendHourEt`, dormant by then since
  the regular Tuesday weekly report stops at week 14). Full tree: all seeds, who's on a bye,
  concrete Round 1 matchups, and the *projected* Round 2/3 path. `pollForPlayoffBracketReveal`.
- **Weekly Playoff Report** — recurring, **Thursday** (own `PLAYOFF_WEEKLY_REPORT_SEND_HOUR_ET`/
  `_MINUTE_ET`, independent of `BIG_MATCHUPS_SEND_HOUR_ET` even though both default to 19:45).
  Week 15 = preview only (the two real games; byes have `matchup_id: null` that week, confirmed
  against real data). Week 16 = Week 15 results + Week 16 preview (the 2 semifinals + the 5th/6th
  placement game, fed by the two Round-1 *losers*). Week 17 = Week 16 results + an explicit
  "headed to the Championship" / "playing for 3rd" highlight + Week 17 preview (championship +
  3rd place). `pollForPlayoffWeeklyReport`.
- **Championship + Season Recap** — Tuesday after Week 17 is final, two sequential messages (same
  pattern as the Tuesday standings+recap: recap is best-effort, doesn't block the first message).
  Championship Recap crowns the champion + reports 3rd place; Season Recap is final standings
  1st–12th plus season-long superlatives (highest/lowest week score, biggest blowout, longest win
  streak — scanned across *all* of weeks 1-17, not just the regular season, reusing
  `realWeekScores`/`realWeekMatchups`/`longestWinStreakForSeason`, exported from `milestones.js`
  for this purpose rather than duplicated). `pollForPlayoffRecap`.

**The recursive bracket-slot resolver** (`resolveBracketSlot`) is the core piece: a `winners_bracket`
entry's `t1`/`t2` resolves directly if populated, or recurses through `t1_from`/`t2_from` (`{w:
matchupNumber}` or `{l: matchupNumber}`) into a `"Winner of (A vs B)"` placeholder when the source
game isn't decided yet. The same function produces the Bracket Reveal's all-placeholder projection
*and* the Weekly Report's real-name fill-in as rounds complete — no branching between the two
cases, since it just reads whatever the bracket JSON currently has. The Bracket Reveal additionally
uses a one-letter "Game A/Game B" legend for the Round 3 line (`Championship: Winner of Game A vs.
Winner of Game B`) instead of nesting the resolver two levels deep, since that nests into an
unreadable wall of parentheses on a phone.

**Baselining** (mirrors `baselineMilestoneState`): a bot started/restarted mid-playoffs shouldn't
post a stale Bracket Reveal after Round 1 already happened, or a stale Week 15 preview after
Week 16 already happened — both pollers silently mark the relevant week(s) sent without sending on
the first sighting of a new season. The recap pair needs no baselining (a late-but-correct
championship recap is fine).

State: `.state/playoff-bracket-state.json`, `playoff-weekly-state.json`, `playoff-recap-state.json`
— same `sentBySeason` shape as `bigMatchupsState`/`draftPreviewState`, reusing
`hasSentWeeklyReport`/`markWeeklyReportSent` as-is. Toggles: `PLAYOFF_BRACKET_REVEAL_ENABLED`,
`PLAYOFF_WEEKLY_REPORT_ENABLED`, `PLAYOFF_RECAP_ENABLED`.

Preview/test: `npm run preview-playoff-bracket -- --previous` (covers Bracket Reveal +
Championship/Season Recap together, `--type=reveal|recap|both`, `--send`) and
`npm run preview-playoff-weekly-report -- --previous` (Weeks 15-17, `--week N --send`) — both
replay against a completed season via `previous_league_id` (the live season's bracket isn't
trustworthy until week 14 anyway). The bracket-reveal preview strips `w`/`l`/decided `t1`/`t2`
values back to the genuinely-undecided shape before building, so replaying a *finished* season
still shows the real placeholder text a league would have actually seen, not a result-spoiled
version of it.

## Season awards ceremony + Hall of Fame (season-end, one-time)

Two more messages appended to the existing `pollForPlayoffRecap` flow (same Tuesday-after-Week-17
send, not a new cadence) — Awards Ceremony first, then Hall of Fame, both best-effort so a failure
in either doesn't block the championship/season recap that already sent.

**Awards Ceremony** (`awards.js`) — 8 manager-level season-arc awards, each line *omitted* (not
null) when its inputs are missing for that season:

- 🚀 Most Improved / 📉 Biggest Collapse — largest win% delta, first half (wks 1-7) vs. second half
  (wks 8-14) of the regular season, guarded by a `MIN_GAMES_FOR_AWARD = 4` minimum per half so a
  short split doesn't produce a nonsensical signal (mirrors milestones.js's `MIN_STREAK_RECORD`).
- 🍀 Luckiest / 💀 Unluckiest Manager — largest gap between actual win% and all-play win%
  (`computeAllPlayWinPct`, exported from `weekly-report.js` for this exact reuse).
- 🤝 Best / 🥴 Worst Trade of the Year — highest/lowest `gradeScore` among this season's
  *persisted* trade grades (see "Trade-grade persistence" below — this is the reason that fix
  exists).
- 🌟 Best Single-Game Performance — `findTopPerformances` (`player-points.js`) over the full
  season's raw `starters`/`players_points`, fields every other consumer of `matchupsByWeek` has
  always ignored.
- 💎 Draft Steal of the Year (+ optional 🪦 Draft Bust) — ranks this draft class by season-long
  points scored vs. by `pick_no`; the pick whose performance-rank beat its draft-rank by the
  widest margin is the steal, the reverse is the bust. Reads `pollForDraftResultsSnapshot`'s
  captured snapshot (see below) — gracefully omitted if no snapshot exists yet for the season.

**Trade-grade persistence**: `buildTradeAnalysis` used to run only inside the live-notification
loop and get discarded. `pollForTrades` now grades *every* trade in scope each cycle
(`buildTradeAnalysisByTransactionId`, with a per-trade try/catch so one ungradeable trade doesn't
break the cycle) and folds the result into `.state/trade-history.json` as a `grades` array
(`rosterId, label, netValue, grade, gradeFlavor, gradeScore, isWinner`) plus a `season` field —
both previously absent. A trade that fails to grade this cycle self-heals next poll, since the log
is rebuilt from scratch every cycle against the same full trade list.

**Post-draft snapshot** (`draft-results.js`, `pollForDraftResultsSnapshot`) — mirrors
`pollForDraftPreview`'s shape but captures *results* instead of previewing an upcoming draft:
gated on `draft.status === "complete"` rather than a countdown, one-shot per `draft_id` via
`.state/draft-results-state.json`. Never sends a chat message — pure data capture for Draft
Steal/Bust to read back at season's end. Unlike `draft-preview.js`'s Round 1 order, no
`traded_picks` cross-reference is needed here: `/v1/draft/{id}/picks` already reflects each pick's
real draft-time owner. Toggle: `DRAFT_RESULTS_SNAPSHOT_ENABLED`.

**Hall of Fame** (`hall-of-fame.js`) — all-time career stats (W-L-T, points-for, championships,
runner-ups, playoff appearances, seasons played) tracked per **franchise** (`roster_id`, the team
slot — verified stable across the `previous_league_id` rollover), and rendered under whichever
manager owns that slot in the *current* league. This is a dynasty league where the roster slot is
the entity that persists: when a manager leaves, a new manager inherits the same `roster_id`, so
keying by the franchise means an orphaned team's history follows the slot to its new owner instead
of being stranded under a departed manager. The current owner + display name is resolved fresh at
render time in `buildHallOfFameReport` (roster_id → current `owner_id` → user), so a takeover —
even a future one — re-attributes the whole history automatically with no re-seed. A franchise
whose slot no longer exists (league contraction) falls back to a `Team #<rosterId>` label.

- First run ever: `buildHallOfFameFromHistory` walks the `previous_league_id` chain (guard 25,
  same precedent as `buildRecordBookFromHistory`/`buildAllTimeDivisionSeries`), fetching
  `winners_bracket` per season (the one fetch those two precedents don't need) and folding each
  season in via `mergeSeasonIntoHallOfFame`. Deliberately includes the *current* season in the
  same walk — by the time `pollForPlayoffRecap` fires, the current season's regular season and
  bracket are already fully decided, so no separate "current season" special case is needed.
- Every later season-close: `mergeSeasonIntoHallOfFame` folds in just the one newly-finished
  season using data already in memory at the `pollForPlayoffRecap` call site (zero extra Sleeper
  calls) — unlike division-rivalry's "just re-walk, it's cheap" precedent, re-walking 10+ seasons
  every single year here would not be free.
- **Idempotency guard**: `mergeSeasonIntoHallOfFame` no-ops if `hallOfFame.lastMergedSeason ===
  season`. The merge is persisted to `.state/hall-of-fame.json` *before* the Hall of Fame message
  send is attempted — `pollForPlayoffRecap`'s only re-entry gate is `hasSentWeeklyReport` at the
  very top, so without persisting the merge first, a transient send failure right after merging
  would double-count that season's stats on the next successful poll.
- Regular-season-only for W-L-T/points-for (weeks 1-`REGULAR_SEASON_END_WEEK`), matching what this
  league's own standings have always meant; playoff success is tracked separately via
  championships/runner-ups/playoff appearances. A roster is counted as a playoff appearance if it
  shows up as a *direct* (non-placeholder) `t1`/`t2` value anywhere in `winners_bracket` — true
  whether it entered Round 1 or got a bye into Round 2.
- Toggle: `HALL_OF_FAME_ENABLED`.

Preview/test: `npm run preview-awards -- --previous` replays a completed season (`--send` to push
to the test chat). `npm run preview-hall-of-fame` does a fresh full chain walk by default (slow
but ground-truth); `--from-cache` instantly renders whatever is already in
`.state/hall-of-fame.json` instead.

## Two-way chat commands (interactive)

`chat-commands.js` + `pollForChatCommands` (index.js, last in the main loop). Members type
`!command` in the group chat; the bot reads the chat, parses commands, and replies by reusing the
same builders as its scheduled posts. Commands: `!help`, `!standings`, `!record <team>`, `!power`,
`!matchup [team]`, `!trade <a> for <b>`, `!hof` (registry in `chat-commands.js` COMMANDS — add an
entry there *and* a case in both `buildCommandReply` in index.js and preview-chat-commands.js).
`!power` reuses `buildPowerRankings` (same offseason fallback as standings); `!matchup` shows the
current NFL week's games (one fetch via `/state/nfl`), falling back to the most recent scored week
in this or the previous league; `!trade <players> for <players>` resolves names against the Sleeper
player map (`buildPlayerNameIndex`, picks the highest-dynasty-value namesake), sums DynastyProcess
values per side, and grades with the same thresholds as the live trade engine.

- `buildMatchupPairings` builds *all* of a week's pairings; `filterMatchupPairings` narrows to one
  team separately, so the resolver can tell "no schedule this week" (empty build → fall through to
  the previous-season fallback via `allowEmptyFallback`) apart from "that team isn't playing" (empty
  filter → "No matchup found for X"). The `currentWeek >= 1` branch must therefore drop through when
  it yields zero pairings (e.g. preseason rows with null `matchup_id`) instead of dead-ending.
- `!trade` name resolution guards the empty-normalized-name case (e.g. a bare "Jr"): both the index
  build and `resolvePlayer` skip an empty key, since the loose `startsWith` fallback would otherwise
  match every player and resolve to the single highest-value one.

- **Reading**: `snapbot.readChatMessages(chatId)` scrapes `#cv-<chatId>` (container class `MibAa`),
  one `li.T1yt2` per sender-block. Sender name comes from `header .nonIntl` and is **carried forward**
  across a block's header-less continuation messages (Snapchat only labels the first); message text is
  `span.ogn1z`. System rows ("...DELETED A CHAT", receipts) and date separators are dropped. Border
  colors are per-member and unreliable for identity — do not key on them. The reader scrolls the
  conversation to the bottom first so the newest messages load.
- **Dedupe**: Snapchat exposes no message ids and messages are *ephemeral* (auto-clear ~24h), so the
  signature is `sender::normalized-text` (`commandSignature`). On first run the poller **primes** —
  seeds all currently-visible commands as handled without replying (like pollForTrades seeding existing
  trades) — so it never answers a backlog on startup. Handled signatures are a 200-entry ring in
  `.state/chat-commands-state.json`. Trade-off: the exact same command from the same person is answered
  once until its signature ages out.
- **Robustness**: reads go through `readChatMessagesWithRetry` (reopen messaging home + retry on the
  intermittent "Could not find chat", mirroring `sendMessageWithRetry`). The bot's own posts come back
  as sender "Me" and are ignored. Unknown commands stay silent (no nagging on stray "!"). A read failure
  warns and is retried next cycle — it never breaks the main loop.
- **Standings source**: `buildStandingsFromRosters` reads each roster's Sleeper `settings`
  (wins/losses/ties/fpts) — one `/rosters` fetch, works year-round. Offseason fallback
  (`resolveStandings`): if the current season has zero games played, it shows the previous season's
  final standings labeled `(<year> final)`.
- Config: `CHAT_COMMANDS_ENABLED` (default true), `CHAT_COMMAND_PREFIX` (default `!`),
  `CHAT_COMMANDS_CHAT_ID` (defaults to the main group; point at the test chat while verifying).
- Preview/test: `npm run preview-chat-commands` reads the test chat and prints the replies it *would*
  send (no priming/dedupe — answers whatever commands are present); add `--send` to actually reply,
  `--main` / `--chat-id <id>` to target a different chat.

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
