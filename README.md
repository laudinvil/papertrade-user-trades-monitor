# Papertrade 5m Liquidation Monitor

Independent, read-only Telegram monitor for Papertrade liquidation events. It is intended to run separately from the existing Polymarket monitor and never places or closes trades.

## Behavior

- Polls the public `get_recent_trades` API every 5 seconds by default.
- Counts only events with `kind: liquidation`.
- Aggregates liquidation events into fixed 5-minute windows by instrument.
- Sends one alert for a completed window when total liquidations are at least 18.
- Splits the alert counts into `LONG` and `SHORT`; events without a recognized side still contribute to the total.
- Uses newline-separated Telegram alert lines and HTML parse mode.
- Deduplicates events and alerts; state is stored at `STATE_PATH` (default `./data/state.json`).
- The first poll establishes a baseline and avoids alerts for historical completed windows.
- Uses public Papertrade event data and Telegram only. No trading actions are performed.

## Configuration

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Optional settings:

- `PAPERTRADE_API_BASE_URL` (default: `https://papertrade-ai.ninabrekkerese.workers.dev/api/v1/tools`)
- `POLL_MS` (minimum 5000)
- `STATE_PATH` (default: `./data/state.json`)

Never commit real Telegram credentials. Persistent storage for `data/state.json` is recommended.

## Run

Requires Node.js 20+ and no external npm dependencies:

```sh
npm start
```

## Hosting

This monitor is intended to run as a standalone Deplexo worker from this repository's `main` branch. A commit triggers a deployment only if the existing Deplexo app is already configured to use this repository and automatic deployments are enabled. Verify the resulting deployment and runtime logs in Deplexo.
