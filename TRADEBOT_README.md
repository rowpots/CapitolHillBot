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
Week 7 Standings
Capitol Hill

1. Team Rowan 6-1 | PF 812.3 | PO 94% | Bye 38%
2. Capitol Crushers 5-2 | PF 790.1 | PO 86% | Bye 27%
...
```

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
