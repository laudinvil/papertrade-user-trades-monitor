# Papertrade 5m Liquidation Monitor

Independent, read-only Telegram monitor for liquidation events emitted by the configured Papertrade contract on HyperEVM. It runs separately from the existing Polymarket monitor and never places or closes trades.

## Actual data source

- NodeFlare HyperEVM JSON-RPC and WebSocket endpoints, authenticated with `NODEFLARE_API_KEY`.
- Contract address: `0x6cd5661646289fb6e65ea5c032310fded797d0a2`.
- Event signature topic: `0x0c859bc5db091ba3b9dc10c00f8dfc78b1f0b7e2566d107253ae67c069ae5de8` (`Liquidated`).
- The monitor subscribes to contract logs over WebSocket and recovers missed blocks through `eth_getLogs` after reconnects.
- This implementation does **not** use the `get_recent_trades` API described by older documentation and does not subscribe to Hyperliquid exchange liquidation trades.

## Alert behavior

- Aggregates events into fixed 5-minute windows, separated by instrument.
- Sends one alert for a completed 5-minute window only when it has at least 18 distinct seconds containing counted liquidations; there is no LIQS count threshold and no special `UNKNOWN` alert rule.
- Alert lines are `LIQS`, `LONG`, `SHORT`, `LIQ SECONDS`, and `LIQ SPAN`.
- `LIQ SECONDS` is the number of distinct block-timestamp seconds containing counted liquidations. `LIQ SPAN` is the elapsed time in seconds between the first and last counted liquidation in that window; it does not imply uninterrupted activity.
- Events that cannot be classified as LONG or SHORT still count toward `LIQS`, but are not shown as a separate `UNKNOWN` line.
- Deduplicates by transaction hash and log index, with additional per-window position deduplication.
- On first startup, establishes a block baseline instead of replaying historical events from earlier periods.
- Persists monitor state at `STATE_PATH` (default: `/data/state.json`).

## Configuration

Required environment variables:

- `NODEFLARE_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Optional:

- `POLL_MS` (default 2000 ms; minimum 2000)
- `STATE_PATH` (default `/data/state.json`)

Never commit API keys or Telegram credentials. Persistent storage for the state file is recommended.

## Run

Requires Node.js 20+ and the `ws` dependency:

```sh
npm install
npm start
```

## Hosting

Intended to run as a standalone Deplexo worker from this repository's `main` branch. A commit triggers deployment only if the Deplexo app is configured to use this repository and automatic deployments are enabled. Verify the deployed commit and runtime logs in Deplexo.
