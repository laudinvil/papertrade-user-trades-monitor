# Papertrade Full-Loss Trade Monitor

Independent, read-only Telegram monitor for Papertrade trades that close at approximately -100% of the position margin. It remains separate from the Polymarket monitor and never places or closes trades.

## Behavior

- Polls the public `get_recent_trades` API every 5 seconds by default.
- Watches `close` and `liquidation` events only.
- Estimates margin as `notionalUsd / leverage` and loss percentage as `pnlUsd / marginUsd * 100`.
- Sends an alert when the realized loss is at or below -99.5% of margin (small tolerance for API rounding).
- Includes trader wallet, market, side, leverage, notional, entry/exit, PnL, loss percentage, position ID and close timestamp when available.
- Deduplicates by event `seq` (with a fallback composite key) and stores processed event keys in `STATE_PATH`.
- On first startup, records the current recent-events batch as a baseline without sending historical alerts.
- Retries an event on the next poll if Telegram delivery fails; no event key is persisted until a matching alert succeeds.
- Uses only public Papertrade event data and Telegram. No trading actions are performed.

## Configuration

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Optional settings:

- `PAPERTRADE_API_BASE_URL` (default: `https://papertrade-ai.ninabrekkerese.workers.dev/api/v1/tools`)
- `POLL_MS` (minimum 5000)
- `STATE_PATH` (default: `./data/state.json`)

Never commit real Telegram credentials. Persistent storage for `data/state.json` is recommended.

## Run

Requires Node.js 20+ and no external npm dependencies:

```sh
cp .env.example .env
npm start
```

## Hosting

Keep this service separate from the existing Polymarket monitor. A repository commit does not deploy or restart Deplexo; confirm the runtime version and logs after deployment.
