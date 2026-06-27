# Sleeper Trade Bot Guide

This project watches a Sleeper dynasty league for completed trades and posts them into a Snapchat group chat.

It is built on top of SnapBot, but this guide is for the custom trade bot behavior in this folder.

> **Feature testing status:** see [FEATURE_STATUS.md](FEATURE_STATUS.md) for the full feature
> inventory split into what's fully tested vs. what still needs a live shakedown before the season.

## What It Does

- Polls one Sleeper league for completed trades
- Sends each new completed trade into one Snapchat group chat
- Uses `team_name` first and `display_name` as fallback for team labels
- Formats trades as one multiline Snapchat message
- Adds a grade for each side of the trade
- Adds history lines:
  - `This is the Xth trade of the season.`
  - `This is the Yth time Team A and Team B have traded.`
- Sends a weekly Tuesday standings report for Weeks 1-14 with playoff odds
- Optionally sends a separate roast message after a lopsided trade
- Lets you queue a fake trade message for testing without making a real Sleeper trade

## Main Files

- [index.js](c:/Users/rowan/OneDrive/Desktop/tradebot/SnapBot/index.js): live bot loop
- [test-trade.js](c:/Users/rowan/OneDrive/Desktop/tradebot/SnapBot/test-trade.js): queues a fake trade for testing
- [roasts.json](c:/Users/rowan/OneDrive/Desktop/tradebot/SnapBot/roasts.json): your custom roast lines
- [roast-templates.js](c:/Users/rowan/OneDrive/Desktop/tradebot/SnapBot/roast-templates.js): roast loader
- [.env.example](c:/Users/rowan/OneDrive/Desktop/tradebot/SnapBot/.env.example): env template
- [.state/runtime-state.json](c:/Users/rowan/OneDrive/Desktop/tradebot/SnapBot/.state/runtime-state.json): tracks already-sent trade ids
- `.state/trade-history.json`: local history snapshot written from real league trades

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy env values into `.env`.

3. Fill in:

```env
USER_NAME=your_snapchat_bot_username
USER_PASSWORD=your_snapchat_bot_password
SLEEPER_LEAGUE_ID=your_sleeper_league_id
SNAPCHAT_GROUP_CHAT_ID=your_snapchat_group_chat_id
SNAPCHAT_STARTUP_TIMEOUT_MS=120000
SNAPCHAT_LOGIN_TIMEOUT_MS=600000
```

## Env Variables

These are the important ones:

- `USER_NAME`: Snapchat bot account username
- `USER_PASSWORD`: Snapchat bot account password
- `SLEEPER_LEAGUE_ID`: league to watch
- `SNAPCHAT_GROUP_CHAT_ID`: chat to post in
- `TEST_SNAPCHAT_GROUP_CHAT_ID`: optional separate chat id for `npm run test-trade` and preview sends
- `POLL_INTERVAL_MS`: how often to check Sleeper, default `60000`
- `SNAPCHAT_STARTUP_TIMEOUT_MS`: how long to wait for Snapchat Web to show either login or chats on startup, default `120000`
- `SNAPCHAT_LOGIN_TIMEOUT_MS`: how long to keep the browser open while login, 2FA, or verification finishes, default `600000`
- `TRANSACTION_START_ROUND`: first Sleeper transaction round to scan
- `TRANSACTION_END_ROUND`: last Sleeper transaction round to scan
- `TRADE_PRIME_TIME_SEND_HOUR_ET`: trades accepted before this Eastern hour are queued until this time, default `16`
- `DYNASTY_VALUE_MODE`: `auto`, `1qb`, or `2qb`
- `TRADE_NOTIFICATION_MODE`: `text` or `image`, default `text`
- `ROAST_MODE`: `true` or `false`
- `ROAST_THRESHOLD`: higher number means fewer roasts
- `WEEKLY_REPORTS_ENABLED`: `true` or `false`, default `true`
- `WEEKLY_REPORT_SEND_HOUR_ET`: Tuesday send hour in Eastern time, default `10`
- `WEEKLY_REPORT_SIMULATION_COUNT`: Monte Carlo runs for playoff odds, default `10000`
- `POWER_RANKINGS_ENABLED`: `true` or `false`, default `true`
- `POWER_RANKING_SEND_HOUR_ET`: Thursday send hour in Eastern time, default `19` (7 PM)
- `PLAYOFF_ALERTS_ENABLED`: playoff clinch/elimination alerts, `true` or `false`, default `true`
- `RECORD_BOOK_ENABLED`: all-time record-book alerts, `true` or `false`, default `true`
- `DIVISION_RIVALRY_ENABLED`: quarterly interdivision rivalry post, `true` or `false`, default `true`
- `BIG_MATCHUPS_ENABLED`: Thursday marquee-matchups preview, `true` or `false`, default `true`
- `BIG_MATCHUPS_SEND_HOUR_ET` / `BIG_MATCHUPS_SEND_MINUTE_ET`: Thursday send time in Eastern time, default `19:45`
- `DRAFT_PREVIEW_ENABLED`: one-time rookie draft preview, `true` or `false`, default `true`
- `DRAFT_PREVIEW_LEAD_HOURS`: hours before the draft's start time to send the preview, default `48`
- `PLAYOFF_BRACKET_REVEAL_ENABLED`: one-time playoff bracket reveal, `true` or `false`, default `true`
- `PLAYOFF_WEEKLY_REPORT_ENABLED`: weekly playoff results+preview (weeks 15-17), `true` or `false`, default `true`
- `PLAYOFF_WEEKLY_REPORT_SEND_HOUR_ET` / `PLAYOFF_WEEKLY_REPORT_SEND_MINUTE_ET`: Thursday send time in Eastern time, default `19:45`
- `PLAYOFF_RECAP_ENABLED`: championship + season recap, `true` or `false`, default `true`
- `DRAFT_RESULTS_SNAPSHOT_ENABLED`: one-time post-draft pick snapshot (feeds Draft Steal/Bust), `true` or `false`, default `true`
- `AWARDS_CEREMONY_ENABLED`: season awards ceremony, `true` or `false`, default `true`
- `HALL_OF_FAME_ENABLED`: all-time career leaderboard, `true` or `false`, default `true`
- `CHAT_COMMANDS_ENABLED`: two-way `!commands` members can type in the chat, `true` or `false`, default `true`
- `CHAT_COMMAND_PREFIX`: the character that starts a command, default `!`
- `CHAT_COMMANDS_CHAT_ID`: which chat to listen + reply in; blank = the main group chat
- `LIVE_SCORING_ENABLED`: master switch for live in-game posts (score snapshots + alerts), `true` or `false`, default `false` (these post during games and are noisier than the scheduled features, so they're opt-in)
- `LIVE_SCORING_CHAT_ID`: optional separate chat for **live-scoring posts only** — blank = the main group chat. Set it to your `TEST_SNAPCHAT_GROUP_CHAT_ID` value to verify live scoring in the test chat during real games while the rest of the bot keeps posting to the league chat as normal. Leave blank (or point it at the main chat) to roll it out to the league.
- `LIVE_SCORE_SNAPSHOTS_ENABLED`: scheduled in-game score snapshots, default `true` (only when `LIVE_SCORING_ENABLED`)
- `LIVE_BIG_PERFORMANCE_ENABLED`: real-time shoutout when a starter goes off, default `true`
- `LIVE_BIG_PERFORMANCE_THRESHOLD`: points a starter must hit to trigger the shoutout, default `35`
- `LIVE_NAILBITER_ENABLED`: late-window close-game alerts, default `true`
- `LIVE_NAILBITER_MARGIN`: max point margin to count as a nailbiter, default `5`
- `LIVE_UPSET_ENABLED`: alert when the team with the worse record is leading, default `true`
- `LIVE_MIN_COMBINED_FOR_ALERT`: combined two-team score below which nailbiter/upset alerts are held (avoids early-game false alarms), default `120`
- `LIVE_LAST_GAME_ALERT_ENABLED`: "going into the last game (MNF/SNF), Team X needs Y with N to play" alert, default `true`
- `LIVE_LAST_GAME_MAX_DEFICIT`: largest deficit that still triggers the last-game alert (bigger = effectively decided, so skip), default `30`
- `HEADLESS`: `false` is easier for debugging
- `DRY_RUN`: `true` logs instead of sending to Snapchat
- `RUN_ONCE`: `true` checks once and exits
- `SEND_TEST_ROAST`: whether `npm run test-trade` also queues a roast
- `TEST_TRADE_MESSAGE`: optional custom fake trade message, supports `\n`
- `TEST_TRADE_ROAST`: optional custom fake roast, supports `\n`

## Commands

Start the live bot:

```bash
npm run bot
```

Live trades now use a daily prime-time send window:

- trades accepted before `TRADE_PRIME_TIME_SEND_HOUR_ET` queue until that hour in Eastern time
- trades accepted at or after that hour send immediately
- after midnight Eastern, the queue window starts over for the new day

Queue a fake trade for the running bot:

```bash
npm run test-trade
```

`npm run test-trade` follows `TRADE_NOTIFICATION_MODE`:

- `text`: sends the sample text trade message
- `image`: sends the sample trade card image

When `TEST_SNAPCHAT_GROUP_CHAT_ID` is set, `npm run test-trade` sends the trade test and optional roast to that test chat instead of the live group chat.

Queue a fake trade without a roast:

```bash
npm run test-trade -- --no-roast
```

Preview a weekly standings message without posting to Snapchat:

```bash
npm run preview-weekly-report -- --previous --week 14
```

Render the current trade card mockup locally:

```bash
npm run preview-trade-card
```

The preview PNG is written to `.state/cards/trade-compact-b-preview.png`.

Preview live in-game scoring (snapshot + alerts) against a real week without posting:

```bash
npm run preview-live-scoring -- --previous --week 14
```

Send a weekly standings test to a separate Snapchat group chat:

```bash
npm run preview-weekly-report -- --previous --week 14 --send --chat-id 'id="title-712a89c2-d7a6-4686-9aad-af62571be8ec"'
```

You can pass either:

- the raw chat id like `712a89c2-d7a6-4686-9aad-af62571be8ec`
- the full DOM id form like `id="title-712a89c2-d7a6-4686-9aad-af62571be8ec"`

Run one dry check without posting to Snapchat:

```bash
$env:DRY_RUN='true'; $env:RUN_ONCE='true'; node index.js
```

Switch trade alerts to image mode:

```bash
TRADE_NOTIFICATION_MODE=image
```

## How The Live Bot Works

On startup, the bot:

1. Opens Snapchat Web
2. Reuses saved cookies when possible
3. Seeds old trades so it does not resend them
4. Polls Sleeper every `POLL_INTERVAL_MS`
5. Sends only trades it has not already seen

The sent trade ids are stored in `.state/runtime-state.json`.

## Weekly Standings Report

The bot also checks for a weekly standings message every polling cycle.

- It only sends on Tuesdays
- It waits until `WEEKLY_REPORT_SEND_HOUR_ET` in Eastern time
- It only considers regular-season Weeks `1` through `14`
- It sends each week once and tracks sent weeks in `.state/weekly-report-state.json`
- It includes current standings plus playoff odds for every team

The message looks like this:

```text
🏈 Capitol Hill Week 7 Standings
—————————————————————————
🥇 Team Rowan   6-1
   PF 812  ·  PO 94%  ·  Bye 38%

🥈 Capitol Crushers   5-2
   PF 790  ·  PO 86%  ·  Bye 27%
...
```

Top three teams get medal emojis; the rest are numbered. Bye odds only appear when non-zero.

Immediately after the standings post, the bot sends a second recap message with the week's
superlatives: top scorer, lowest scorer, biggest blowout, and closest game.

```text
📊 Week 7 Matchups Recap

🔥 Top Score
Team Rowan — 142.6

🧊 Low Score
Capitol Crushers — 78.2

💥 Biggest Blowout
Team Rowan def. Capitol Crushers by 64.4

😬 Closest Game
Team A def. Team B by 1.2
```

The recap is best-effort: if it fails to send, the standings post is still recorded so it does not
resend on the next cycle. Both messages render in the `npm run preview-weekly-report` preview.

## Thursday Power Rankings

Separately from the Tuesday standings, the bot posts **power rankings on Thursdays** at
`POWER_RANKING_SEND_HOUR_ET` (default 7 PM Eastern, about an hour before Thursday Night Football),
for regular-season **Weeks 2-14**. Each post is titled for the upcoming week (e.g. the Thursday
that kicks off Week 2 posts "Week 2 Power Rankings", ranked from Week 1 results). Week 1 has no
games played yet, so the first post is Week 2. It sends each week once and tracks sent weeks in
`.state/power-rankings-state.json`.

Power rankings differ from standings by rewarding scoring and removing schedule luck. Each team
gets a 0-100 power score from a weighted blend:

- 40% scoring (points per game)
- 25% all-play win % (your record if you played everyone every week)
- 20% actual win %
- 15% recent form (last 3 weeks)

Teams are sorted by power score with movement arrows versus the previous week's ranking.

```text
📈 Capitol Hill Week 14 Power Rankings
———————————————————————————
Score /100  ·  ↑↓ vs last week

🥇 JoshPT   99.0  —

🥈 The Bad Man   94.0  ↑1

🥉 Alexandria Ocasio-Cortez   88.0  ↑3

4. DrtyBubble   86.8  ↓1
...
```

The score is a 0-100 rating scaled so the best team is ~99 and the worst ~40.

Preview it without posting (movement is derived by diffing the week against the one before):

```bash
npm run preview-power-rankings -- --previous --week 14
```

Add `--send` (and optionally `--chat-id`) to deliver it to the test chat. Weights live as tunable
constants at the top of [weekly-report.js](c:/Users/rowan/OneDrive/Desktop/tradebot/SnapBot/weekly-report.js).

## Big Matchups Preview

A second, separate Thursday post — not bundled with power rankings — sent close to Thursday Night
Football (`BIG_MATCHUPS_SEND_HOUR_ET` / `BIG_MATCHUPS_SEND_MINUTE_ET`, default 7:45 PM Eastern,
about 30 minutes before a typical kickoff), once playoff odds are meaningful enough to be worth
previewing (from Week 8 on). Toggle with `BIG_MATCHUPS_ENABLED`.

Each real upcoming matchup gets sorted into at most one category. Elimination Watch and Clinch
Watch name the specific team(s) at stake (and call out both, if both qualify) since those are
about individual stakes; Showdown and Draft Position Bowl stay as a plain "vs." since both teams
are equally the point there:

- **🎯 Elimination Watch** — one (or both) team is in real danger of being eliminated
- **🔒 Clinch Watch** — one (or both) team is close to locking up a playoff spot
- **⚔️ Playoff Showdown** — both teams are genuinely in the playoff hunt, head to head
- **🏗️ Draft Position Bowl** — both teams are already out of contention

If nothing qualifies that week, nothing gets sent — it's not trying to recap every game, just the
ones with real stakes.

```text
📅 Capitol Hill Week 11 Matchups to Watch
—————————————————————————————————

🎯 Elimination Watch
oJacob is in danger of elimination vs. Alexandria Ocasio-Cortez
Hayden9999999 is in danger of elimination vs. goodforyousister

🔒 Clinch Watch
The Bad Man and JoshPT could both clinch a playoff spot
Emmauel Macron could clinch a playoff spot vs. Team Ayahuasca 🗿

⚔️ Playoff Showdown
DrtyBubble vs. Hoags02

🏗️ Draft Position Bowl
Thejigler vs. Jme33708
```

Preview a season's worth of weeks (no Snapchat):

```bash
npm run preview-big-matchups -- --previous
```

Add `--week N --send` to push one specific week's report to the test chat.

## Live In-Game Scoring

Real-time posts during the games themselves — **off by default** (set `LIVE_SCORING_ENABLED=true`),
since these fire while games are live and are noisier than the once-a-week scheduled posts. The bot
only checks during NFL game windows (Thursday night, Sunday afternoon/evening, Monday night, Eastern
time) so it isn't hammering Sleeper off-hours, and it sends **at most one live message per cycle**
(same anti-spam rule as trade and milestone sends — any backlog trickles out one at a time).

Four kinds of posts, each independently toggleable:

- **🏟️ Score snapshots** — a leaderboard of every matchup's current score, posted at set checkpoints
  (after the early Sunday games, after the afternoon games, a Sunday-night wrap, plus Thursday and
  Monday night), with the top score and closest game called out. `LIVE_SCORE_SNAPSHOTS_ENABLED`.
- **🔥 Big-performance alerts** — when any starter crosses `LIVE_BIG_PERFORMANCE_THRESHOLD` points
  (default 35), a shoutout fires. `LIVE_BIG_PERFORMANCE_ENABLED`.
- **😬 Nailbiter alerts** — late in a game window, a matchup within `LIVE_NAILBITER_MARGIN` points
  (default 5) gets flagged as too close to call. `LIVE_NAILBITER_ENABLED`.
- **🚨 Upset alerts** — late in a window, if the team with the worse season record is leading, the
  bot calls out the upset in progress. `LIVE_UPSET_ENABLED`.
- **🌙 Last-game alert** — when the only NFL game left for the week is the final slot (Monday Night,
  or Sunday Night on a rare MNF-less week), the bot calls out any trailing team that's still alive:
  *"Team X needs 6.0 with 1 player left to play (Saquon Barkley) to catch Team Y (down 5.9)."*
  `LIVE_LAST_GAME_ALERT_ENABLED`.

Nailbiter/upset alerts hold off until the two teams' combined score clears
`LIVE_MIN_COMBINED_FOR_ALERT` (default 120) so early-game scores don't trip false alarms.

The last-game alert needs to know which players haven't kicked off yet, which Sleeper doesn't
expose — so it pulls the free **ESPN public scoreboard** (no API key) to get each NFL team's game
status (`nfl-schedule.js`). It only fires once the rest of the week's games are final and a trailing
team still has player(s) going, and skips deficits bigger than `LIVE_LAST_GAME_MAX_DEFICIT`
(default 30) as effectively decided.

Preview the snapshot and every alert type against a real (past) week without posting:

```bash
npm run preview-live-scoring -- --previous --week 14
```

Add `--week N` (repeatable) to target specific weeks, `--types snapshot,bigperf,nailbiter,upset,lastgame`
to pick which to show, or `--send` (with `TEST_SNAPCHAT_GROUP_CHAT_ID`) to push the messages to the
test chat. The `lastgame` preview simulates "going into the last game" against the week's final
totals, since a completed week's real schedule is all final.

## Milestone Alerts

The bot also watches for two kinds of "significant moment" and announces them — but **spread out**,
not all at once. When a week's results are final (the Tuesday computation), it detects events and
queues each with a release time in a daytime Eastern-time slot, so they drip out one at a time
across the days before the next games instead of dogpiling the recap.

- **Playoff clinch / elimination** — when a team clinches a playoff spot, clinches a first-round
  bye, or is eliminated. Only evaluated from Week 8 on (earlier reads aren't reliable). Toggle with
  `PLAYOFF_ALERTS_ENABLED`.
- **All-time record book** — fires only when a league record breaks: highest single-week score,
  lowest single-week score, biggest blowout, or longest win streak. Records are seeded across every
  prior season via Sleeper's `previous_league_id` chain (regular-season weeks). Toggle with
  `RECORD_BOOK_ENABLED`.

```text
🎉 Team Rowan has clinched a playoff spot!

🏆 NEW LEAGUE RECORD
Highest score ever — Team Rowan: 189.4
Previous: 184.2 (Capitol Crushers, 2024 Wk 6)
```

On first run the bot **silently baselines** (records current clinches and seeds the record book) so
it never announces things that already happened before it started watching. State lives in
`.state/milestone-state.json` and `.state/record-book.json`.

Preview what a whole season would have fired (no Snapchat) — it seeds from prior seasons and replays
week by week:

```bash
npm run preview-milestones -- --previous
```

Add `--send` to push one sample event to the test chat.

## Division Rivalry Tracker

A quarterly bragging-rights post for the league's two divisions, tallying the interdivision
head-to-head record (games where a team from one division played a team from the other — games
between two teams in the same division don't count). Posted on **Wednesdays**, not every week —
only once per quarter of the 14-week regular season, after Weeks **4, 7, 11, and 14** complete.
Toggle with `DIVISION_RIVALRY_ENABLED`. Division names come from the league's own division
settings, not hardcoded.

Each post includes:

- This season's series record and an **all-time series record** (seeded across every prior
  season via Sleeper's `previous_league_id` chain — a season only contributes if its two
  division names match this season's, so a league that renamed or reorganized divisions doesn't
  produce a misleading number)
- Total points scored by each division in interdivision play
- The quarter's biggest interdivision blowout and closest interdivision game
- Each division's best ("🔥 MVP") and worst ("🧊 Bust") interdivision performer by record

```text
🏛️ Capitol Hill Division Rivalry — Through Week 7
———————————————————————————————————

Republicans vs. Democrats
This season: tied 6-6 · 12 games played
All-time: Republicans lead 45-38-2 (3 seasons)

📊 Total Points: Republicans 1,484.9 - 1,424.1 Democrats

💥 Biggest Blowout (Wk 7)
goodforyousister def. Alexandria Ocasio-Cortez by 73.6

😬 Closest Game (Wk 6)
JoshPT def. Team Ayahuasca 🗿 by 6.6

🔥 Republicans MVP: goodforyousister (2-0)
🧊 Republicans Bust: Thejigler (0-2)

🔥 Democrats MVP: Hayden9999999 (2-0)
🧊 Democrats Bust: Jme33708 (0-2)
```

If zero interdivision games have happened yet by a quarter boundary (the schedule can cluster
intra-division games early in some seasons), the post is silently skipped rather than sending an
empty/misleading message.

Preview a season's quarterly checkpoints (no Snapchat):

```bash
npm run preview-division-rivalry -- --previous
```

Add `--send` to push the most recent checkpoint to the test chat.

## Rookie Draft Preview

A one-time-per-season post counting down to the league's rookie draft — not a recurring weekly
send. Fires `DRAFT_PREVIEW_LEAD_HOURS` (default 48) before the draft's own scheduled start time, so
it always lands at the right moment regardless of which day the league schedules its draft each
year. Toggle with `DRAFT_PREVIEW_ENABLED`.

Each post includes:

- The draft's formatted start time (Eastern) plus a "`N` rounds, `M` picks total" summary
- **Round 1 order**, resolved through any traded picks — if a Round 1 pick has changed hands, the
  post shows the team that actually owns it now, not the team it was originally assigned to
- **Top 12 available rookies**, ranked by dynasty trade value, name + position + NFL team only (no
  raw value numbers, to keep it readable)

```text
🎓 Capitol Hill Rookie Draft Preview
———————————————————————————

Draft kicks off Jun 28, 2026, 7:30 PM ET — 4 rounds, 48 picks total

Round 1 Order
1. NewGM
2. Thejigler
3. oJacob
...
12. oJacob

🔥 Top Available Rookies
1. Jeremiyah Love (RB, ARI)
2. Carnell Tate (WR, TEN)
...
12. Antonio Williams (WR, WAS)
```

Preview the real upcoming draft (no Snapchat):

```bash
npm run preview-draft-preview
```

Add `--send` to push it to the test chat. There's no `--previous` replay mode here — a past
draft's "available rookies" aren't rookies/available anymore, so replaying an old season wouldn't
mean anything useful.

## Playoffs

Four messages covering the 3-round, 6-team playoff bracket (weeks 15-17). All of them wait until
the regular season is fully complete before trusting Sleeper's bracket data — the bracket
endpoint returns a meaningless placeholder until then.

**Playoff Bracket Reveal** — one-time, sent the Tuesday right after the regular season ends.
The full bracket: every seed, who has a bye, Round 1's matchups, and the projected path through
Round 2 and the Championship.

```text
🏆 Capitol Hill Playoff Bracket
———————————————————————————

6 teams, 3 rounds. Round 1 kicks off Week 15.

Seed 1: The Bad Man (11-3) — BYE
Seed 2: JoshPT (10-4) — BYE
Seed 3: Alexandria Ocasio-Cortez (9-5)
Seed 4: DrtyBubble (9-5)
Seed 5: Emmauel Macron (9-5)
Seed 6: Team Ayahuasca 🗿 (7-7)

Round 1 (Week 15)
Seed 4 DrtyBubble vs. Seed 5 Emmauel Macron
Seed 6 Team Ayahuasca 🗿 vs. Seed 3 Alexandria Ocasio-Cortez

Round 2 (Week 16, projected)
Game A: Seed 1 The Bad Man vs. Winner of (Seed 4 DrtyBubble vs Seed 5 Emmauel Macron)
Game B: Seed 2 JoshPT vs. Winner of (Seed 6 Team Ayahuasca 🗿 vs Seed 3 Alexandria Ocasio-Cortez)
5th/6th Place: Loser of (Seed 4 DrtyBubble vs Seed 5 Emmauel Macron) vs. Loser of (Seed 6 Team Ayahuasca 🗿 vs Seed 3 Alexandria Ocasio-Cortez)

Round 3 (Week 17, projected)
Championship: Winner of Game A vs. Winner of Game B
3rd Place: Loser of Game A vs. Loser of Game B
```

**Weekly Playoff Report** — Thursday evenings, weeks 15-17. Week 15 is a preview only; weeks 16
and 17 lead with the previous week's results before previewing what's next.

```text
🏈 Capitol Hill Week 17 Playoffs
———————————————————————————

Round 2 Results
The Bad Man def. Emmauel Macron by 34.7
Alexandria Ocasio-Cortez def. JoshPT by 64.5
Team Ayahuasca 🗿 def. DrtyBubble by 9.3 (5th Place)

🏆 The Bad Man and Alexandria Ocasio-Cortez are headed to the Championship!
🥉 Emmauel Macron and JoshPT will play for 3rd Place.

Championship (this week)
The Bad Man vs. Alexandria Ocasio-Cortez

3rd Place Game (this week)
Emmauel Macron vs. JoshPT
```

**Championship + Season Recap** — sent back-to-back the Tuesday after the championship week
finishes. The Championship Recap crowns the champion and reports 3rd place; the Season Recap is
the full final standings (1st-12th) plus season-long superlatives.

```text
🏆 Capitol Hill Champion
———————————————————————————

🥇 The Bad Man is your champion! (129.6 - 125.1 over Alexandria Ocasio-Cortez)

🥉 3rd Place: JoshPT def. Emmauel Macron by 76.1
```

```text
📋 Capitol Hill Final Standings — Season Recap

1. The Bad Man (Champion)
2. Alexandria Ocasio-Cortez (Runner-up)
...
12. Jme33708 (0-14)

Season Superlatives
🔥 Highest Score: The Bad Man — 186.3 (Wk 9)
🧊 Lowest Score: Jme33708 — 27.0 (Wk 12)
💥 Biggest Blowout: JoshPT def. Jme33708 by 137.3 (Wk 12)
🏃 Longest Win Streak: Alexandria Ocasio-Cortez — 7 games
```

Toggle each independently with `PLAYOFF_BRACKET_REVEAL_ENABLED`, `PLAYOFF_WEEKLY_REPORT_ENABLED`,
and `PLAYOFF_RECAP_ENABLED`.

Preview the Bracket Reveal and Championship/Season Recap (no Snapchat, replays a finished season):

```bash
npm run preview-playoff-bracket -- --previous
```

Add `--type=reveal` or `--type=recap` to preview just one, and `--send` to push it to the test
chat. Preview the weekly report:

```bash
npm run preview-playoff-weekly-report -- --previous
```

Add `--week 15|16|17 --send` to push one specific week to the test chat.

## Season Awards Ceremony + Hall of Fame

Two more one-time-per-season messages, sent right after the Championship + Season Recap (same
Tuesday, same `pollForPlayoffRecap` flow) — not new cadences.

**Awards Ceremony** — 8 manager-level season-arc awards, each line omitted (not shown as
empty/null) if its data isn't available that season:

```text
🏆 Capitol Hill Season Awards
———————————————————————————

🚀 Most Improved
JoshPT — +38% win rate (2nd half vs. 1st)

📉 Biggest Collapse
Jme33708 — -29% win rate (2nd half vs. 1st)

🍀 Luckiest Manager
DrtyBubble — 64% record vs. 51% all-play

💀 Unluckiest Manager
Team Ayahuasca 🗿 — 43% record vs. 58% all-play

🤝 Best Trade of the Year
Capitol Crushers (Grade: A+)

🥴 Worst Trade of the Year
Team Rowan (Grade: D-)

🌟 Best Single-Game Performance
Player Name (RB) — 54.2 pts (Week 9, The Bad Man)

💎 Draft Steal of the Year
Player Name (WR) — Pick 47, 198.3 pts (JoshPT)

🪦 Draft Bust
Player Name (QB) — Pick 3, 41.0 pts (Alexandria Ocasio-Cortez)
```

Most Improved/Biggest Collapse compare win% across the first half (weeks 1-7) vs. second half
(weeks 8-14) of the regular season; Luckiest/Unluckiest compare actual win% against all-play win%.
Best/Worst Trade reuse this season's already-graded trade history. Best Single-Game Performance
and Draft Steal/Bust read per-player points straight out of Sleeper's raw matchup data
(`players_points`/`starters`, extracted by `player-points.js`) and this season's post-draft pick
snapshot (`draft-results.js`, captured once `draft.status === "complete"`). Toggle each
independently with `AWARDS_CEREMONY_ENABLED` / `DRAFT_RESULTS_SNAPSHOT_ENABLED`.

**Hall of Fame** — all-time per-manager career stats, aggregated across the league's full history
by walking the `previous_league_id` chain once, then cheaply folded forward one season at a time
from then on:

```text
📜 Capitol Hill Hall of Fame
———————————————————————————

1. The Bad Man 🏆x2 🥈x1
   58-42-0 · 5821.4 PF · 4 playoff trips · 7 seasons

2. Alexandria Ocasio-Cortez 🏆x1
   54-46-0 · 5690.2 PF · 5 playoff trips · 7 seasons
...
```

Career stats are tracked per **team franchise** (the roster slot, which persists across seasons)
and rendered under whoever owns that slot in the current league — so when a manager leaves and a
new one takes over their team, the team's full history follows the slot to its new owner instead of
being orphaned under the departed manager. Toggle with `HALL_OF_FAME_ENABLED`.

Preview the Awards Ceremony (no Snapchat, replays a finished season):

```bash
npm run preview-awards -- --previous
```

Add `--send` to push it to the test chat. Preview the Hall of Fame (fresh chain walk by default,
slow but ground-truth):

```bash
npm run preview-hall-of-fame
```

Add `--from-cache` to instantly render whatever is already in `.state/hall-of-fame.json` instead
of re-walking history, and `--send` to push it to the test chat.

## Two-Way Chat Commands

League members can type commands right in the group chat and the bot replies. Commands start with
`!` (configurable via `CHAT_COMMAND_PREFIX`):

- `!help` — list the available commands
- `!standings` — current league standings (in the offseason, shows last season's final standings)
- `!record <team>` — a team's record, points, and rank (e.g. `!record JoshPT`)
- `!power` — power rankings
- `!matchup [team]` — this week's matchups (optionally just one team's)
- `!trade <players> for <players>` — grades a hypothetical trade by DynastyProcess value
  (e.g. `!trade Lamar Jackson for Jayden Daniels`)
- `!hof` — the all-time Hall of Fame

The bot listens in the main group chat by default; set `CHAT_COMMANDS_CHAT_ID` to listen elsewhere.
On startup it ignores any commands already sitting in the chat (so it won't reply to old messages),
then answers new ones each poll. Snapchat messages are ephemeral, so a command needs to still be
visible when the bot next checks — it isn't a guaranteed-delivery inbox. Disable the whole feature
with `CHAT_COMMANDS_ENABLED=false`.

Test it against the test chat (type a few commands there first):

```bash
npm run preview-chat-commands
```

That prints the replies it *would* send; add `--send` to actually reply in the chat, or
`--chat-id <id>` / `--main` to target a different chat.

## Trade Message Format

Real trades are sent like this:

```text
A trade has been completed

This is the 12th trade of the season.

This is the 3rd time Team Rowan and Capitol Crushers have traded.

Team Rowan has sent:
Player 1 (POS - TEAM)
2027 1st

Grade: A-

Capitol Crushers has sent:
Player 2 (POS - TEAM)
2028 2nd

Grade: C+
```

If roast mode fires, the roast is sent as a completely separate message.

## Roast Customization

Edit [roasts.json](c:/Users/rowan/OneDrive/Desktop/tradebot/SnapBot/roasts.json).

It has three groups:

- `mild`
- `medium`
- `severe`

You can use these placeholders:

- `{winner}`
- `{loser}`

Example:

```json
"{winner} just robbed {loser} in broad daylight."
```

After editing `roasts.json`, restart the bot so the new lines are picked up cleanly.

## Manual Testing

`npm run test-trade` does not hit Sleeper.

Instead it writes a small trigger file into `.state/`, and the already-running bot picks it up and sends the fake trade through the same Snapchat session it uses for real trades.

That makes testing much safer than opening a second Snapchat automation session.

## Switching From Test To Live

When you are ready to move from the test league/chat to the real league/chat:

1. Stop the bot
2. Change `SLEEPER_LEAGUE_ID`
3. Change `SNAPCHAT_GROUP_CHAT_ID`
4. Reset `.state/runtime-state.json` to:

```json
{
  "initialized": false,
  "initializedAt": null,
  "sentTransactionIds": []
}
```

5. Start the bot again

That reset matters because the state file is what prevents old trades from being resent.

## Troubleshooting

If Snapchat opens but does not behave correctly:

- Set `HEADLESS=false`
- Watch the browser
- Restart the bot after fixing popups or login issues

If you want to test message formatting:

- use `npm run test-trade`

If the bot should not send anything yet:

- use `DRY_RUN=true`

If you want one quick check and then stop:

- use `RUN_ONCE=true`

If you edit roast lines or env settings:

- restart the bot
