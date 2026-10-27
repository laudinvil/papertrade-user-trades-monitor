# Papertrade Monitoring Services

Read-only Telegram monitors for Papertrade AI, running as separate services inside one Deplexo application.

## What it does

- Polls the public Papertrade leaderboard for the highest 7-day PnL traders.
- Checks closed trade history and calculates net PnL after fees, win rate, profit factor, and maximum drawdown.
- Qualifies traders only when they meet minimum sample and performance thresholds.
- Uses public read-only API tools only. It does not open, close, or modify trades.



These criteria screen for historical performance; they do not guarantee future profitability. The scanner evaluates only the history returned by the API, up to the configured page limit.

## Required environment variables

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

## Optional environment variables

- `PAPERTRADE_API_BASE_URL` (default `https://papertrade-ai.ninabrekkerese.workers.dev/api/v1/tools`)
- `POLL_MS` (default 60000; minimum 30000)
- `LEADERBOARD_WINDOW` (default `7d`; supported: `24h`, `7d`, `30d`, `all`)
- `CANDIDATE_LIMIT` (default 10; range 5–25)
- `HISTORY_PAGES` (default 4; range 1–10; 75 trades per page)
- `MIN_CLOSED_TRADES` (default 50)
- `MIN_WIN_RATE` (default 0.55)
- `MIN_PROFIT_FACTOR` (default 1.3)


The Docker image runs only this scanner under the supervisor and exposes `/health`. Keep it as one Deplexo application. GitHub pushes trigger deployment only if auto-deploy is enabled for the connected repository; verify the deployed commit and runtime logs in Deplexo.

## Trade activity monitor

A separate `trade-activity-monitor.js` service runs inside the same Deplexo application. It reads the public recent-trades feed and sends deduplicated Telegram alerts for:
- unusually high trade frequency in a completed 5-minute BTC or ETH window;
- repeated per-wallet OPEN → CLOSED / CLOSED → OPEN transitions in that window;
- a sharp increase in CLOSED notional versus the preceding six 5-minute windows.

- `TRADE_ACTIVITY_POLL_MS` (default 10000; minimum 3000)
- `TRADE_ACTIVITY_STATE_PATH`
- `TRADE_ACTIVITY_MIN_FREQUENCY_TRADES` (default 10)
- `TRADE_ACTIVITY_FREQUENCY_MULTIPLIER` (default 2.5)
- `TRADE_ACTIVITY_MIN_SEQUENCE_TRANSITIONS` (default 3)
- `TRADE_ACTIVITY_CLOSE_VOLUME_MULTIPLIER` (default 2.5)
- `TRADE_ACTIVITY_MIN_CLOSE_VOLUME_USD` (default 10000)

The monitor evaluates completed 5-minute windows and uses its own persistent deduplication state. Both services run in the same single Deplexo app.



## Five-minute liquidation summary monitor

A separate `liquidation-summary-monitor.js` service polls the public `get_recent_trades` public tool from [`nirholas/papertrade-ai`](https://github.com/nirholas/papertrade-ai), via `https://papertrade-ai.ninabrekkerese.workers.dev/api/v1/tools/get_recent_trades` feed and filters events whose `kind` identifies a liquidation. At the end of each completed UTC 5-minute window, it sends one Telegram summary if any BTC or ETH liquidations were observed.

The alert reports, per instrument:
- LONG liquidation count and summed `notionalUsd`;
- SHORT liquidation count and summed `notionalUsd`;
- separately labeled unknown-side events, rather than guessing their direction;
- total liquidation count and USD notional, with a Polymarket 5-minute market link.

It uses a separate persistent state file at `/data/liquidation-summary-state.json`, deduplicates by event sequence when available, and polls every 10 seconds by default. It does not change the other monitors' alert logic.

Optional environment variables:
- `LIQUIDATION_SUMMARY_POLL_MS` (default 10000; minimum 3000)
- `LIQUIDATION_SUMMARY_STATE_PATH` (default `/data/liquidation-summary-state.json`)

The source feed must actually include liquidation events for these summaries to be complete; check the `liquidation_summary_snapshot` logs to verify observed event kinds and counts.
