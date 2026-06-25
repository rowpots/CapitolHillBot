# Sleeper Trade Bot Guide

This project watches a Sleeper dynasty league for completed trades and posts them into a Snapchat group chat.

It is built on top of SnapBot, but this guide is for the custom trade bot behavior in this folder.

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
