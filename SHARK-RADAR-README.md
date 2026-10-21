# Shark Radar top-leader monitor

This branch is for a **separate Deplexo app**. It does not change `main` or the Papertrade liquidation monitor.

## Behavior
- Polls the first wallet on https://sharkradar.app/polymarket-leaderboard (default every 60 seconds).
- Sends a Telegram alert when the monitor first starts and when the #1 wallet changes.
- Tracks BUY/SELL trade activity for the current #1 wallet using Polymarket's public Data API and alerts on newly observed activity.
- Stores the current leader and seen activity IDs in `/app/data/shark-radar-state.json`; mount/persist `/app/data` in Deplexo to keep state across restarts.
- On first startup or leader change, recent activity is treated as a baseline; old trades are not replayed as new alerts.

## Deplexo environment variables
- `TELEGRAM_BOT_TOKEN` — Telegram bot token.
- `TELEGRAM_CHAT_ID` — destination chat ID.
- `POLL_MS` — optional polling interval in milliseconds (minimum 30000; default 60000).
- `STATE_PATH` — optional state file path (default `/app/data/shark-radar-state.json`).

## Deploy separately
Create a **new Deplexo app** from this repository and select branch `shark-radar-standalone`. Keep the existing liquidation-monitor app on `main`. The Dockerfile on this branch starts only `shark-radar-monitor.js`; it does not start `papertrade-monitor.js`.

Logs to verify startup: `event=shark_radar_started`, then `event=shark_radar_poll_ok`.
