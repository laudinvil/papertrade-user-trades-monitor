# Papertrade User Trades Monitor

Independent, read-only Papertrade monitor for BTC/ETH events. This project uses the unique entrypoint `papertrade-monitor.js`; it is a separate directory/container and must not be copied into or deployed with the existing monitor. It does not place trades or modify the existing Polymarket monitor.

- Handles `open`, `close`, and `liquidation` events.
- Sends Telegram alerts and deduplicates by `seq`.
- Polls every 5 seconds by default, matching the public wrapper's documented cache interval.
- Persists state in `STATE_PATH`; configure persistent storage on the host.
- Logs summaries and errors rather than every event.

## Configuration
Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `PAPERTRADE_BTC_URL`, and `PAPERTRADE_ETH_URL`. The official source confirms the app base URL (`https://exchange.papertrade.xyz`) but does not document market-specific frontend routes. The previously suggested `/trade/btc` and `/trade/eth` paths are not verified, so the example file intentionally leaves both URL values blank. Do not deploy until the real BTC/ETH links are confirmed and entered.

## Run
Requires Node.js 20+ and no external npm dependencies:

```sh
cp .env.example .env
# Fill in the required values in your hosting provider’s environment settings.
# Do not commit real Telegram credentials.
npm start
```

## Reliability limitation
The exposed `get_recent_trades` wrapper returns a recent batch and does not expose a `seq` cursor. The monitor deduplicates by `seq` and warns if consecutive snapshots have no overlap, but cannot guarantee zero missed events if the batch rolls over between polls. The discovered SSE endpoint (`/state/user/live?wallet=...`) is per-wallet and does not provide a platform-wide trades stream, so it is not a replacement for global trade events.

## Hosting
Keep this service separate from the existing monitor. Do not add it to the existing process tree or deployment. If the Deplexo free plan allows only one project, use a separate host or paid plan. Persistent storage is recommended for `data/state.json`.
