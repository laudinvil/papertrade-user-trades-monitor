# Papertrade uPnL Leader Monitor

Independent, read-only monitor for the two Papertrade accounts at the extremes of current unrealized PnL. It uses the separate entrypoint `papertrade-monitor.js` and must remain separate from the existing Polymarket monitor. It does not place trades or modify the existing Polymarket monitor.

- Tracks one account with the highest positive `currentUnrealizedPnl`.
- Tracks one account with the lowest (most negative) `currentUnrealizedPnl`.
- Sends a Telegram alert only when the leader's wallet address changes.
- Each leader-change alert includes that account's current open positions, side, leverage, margin, notional, entry/mark prices, estimated uPnL and bust price.
- Does not send repeated alerts for ordinary uPnL fluctuations while the leader address remains the same.
- Polls the public Papertrade API every 5 seconds by default.
- Stores the two current leader addresses in `STATE_PATH`; persistent storage is recommended.

## Configuration

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Optional settings:
- `PAPERTRADE_API_BASE_URL` (default: `https://papertrade-ai.ninabrekkerese.workers.dev/api/v1/tools`)
- `POLL_MS` (minimum 5000)
- `STATE_PATH` (default: `./data/state.json`)

Never commit real Telegram credentials.

## Behavior

On first startup, the monitor records both current leaders as a baseline without sending alerts. It then sends an alert when either leader address changes. A missing positive or negative uPnL leader is represented as no account in that category. Account position details are fetched only when a leader changes, to reduce API requests.

The leaderboard is sorted by current unrealized PnL over the 24-hour window, matching the supplied Papertrade leaderboard URLs. The sign of the returned uPnL is checked so the positive and negative categories are not confused.

## Run

Requires Node.js 20+ and no external npm dependencies:

```sh
cp .env.example .env
npm start
```

## Hosting

Keep this service separate from the existing monitor. Do not add it to the existing process tree or deployment. Configure persistent storage for `data/state.json` if the host supports it. A repository commit does not deploy or restart Deplexo.
