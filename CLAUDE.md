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
