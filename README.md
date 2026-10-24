# Papertrade Profitable Traders Monitor

Read-only Telegram scanner for Papertrade AI. It replaces the previous liquidation monitor; liquidation detection and liquidation alert logic have been removed.

## What it does

- Polls the public Papertrade leaderboard for the highest 7-day PnL traders.
- Checks closed trade history and calculates net PnL after fees, win rate, profit factor, and maximum drawdown.
- Qualifies traders only when they meet minimum sample and performance thresholds.
- Sends a Telegram alert when a wallet first qualifies and when a currently qualified wallet opens a new trade.
- Deduplicates recent events and persists state in `/data/profitable-traders-state.json`.
- Uses public read-only API tools only. It does not open, close, or modify trades.

## Qualification defaults

- Leaderboard window: 7 days.
- Inspect the top 10 leaderboard candidates plus previously qualified wallets.
- At least 50 closed trades.
- Net PnL after fees greater than zero.
- Win rate at least 55%.
- Profit factor at least 1.30.

These criteria screen for historical performance; they do not guarantee future profitability. The scanner evaluates only the history returned by the API, up to the configured page limit.

## Required environment variables

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

## Optional environment variables

- `PAPERTRADE_API_BASE_URL` (default `https://papertrade-ai.ninabrekkerese.workers.dev/api/v1/tools`)
- `POLL_MS` (default 60000; minimum 30000)
- `PROFITABLE_TRADERS_STATE_PATH` (default `/data/profitable-traders-state.json`)
- `LEADERBOARD_WINDOW` (default `7d`; supported: `24h`, `7d`, `30d`, `all`)
- `CANDIDATE_LIMIT` (default 10; range 5–25)
- `HISTORY_PAGES` (default 4; range 1–10; 75 trades per page)
- `MIN_CLOSED_TRADES` (default 50)
- `MIN_WIN_RATE` (default 0.55)
- `MIN_PROFIT_FACTOR` (default 1.3)

## Deployment

The Docker image runs only this scanner under the supervisor and exposes `/health`. Keep it as one Deplexo application. GitHub pushes trigger deployment only if auto-deploy is enabled for the connected repository; verify the deployed commit and runtime logs in Deplexo.
