# Papertrade 5m Liquidation Monitor

Independent, read-only Telegram monitor for liquidation events emitted by the configured Papertrade contract on HyperEVM. It runs separately from the existing Polymarket monitor and never places or closes trades.

## Actual data source

- NodeFlare HyperEVM JSON-RPC and WebSocket endpoints, authenticated with `NODEFLARE_API_KEY`.
- Contract address: `0x6cd5661646289fb6e65ea5c032310fded797d0a2`.
- Event signature topic: `0x0c859bc5db091ba3b9dc10c00f8dfc78b1f0b7e2566d107253ae67c069ae5de8` (`Liquidated`).
- The monitor subscribes to contract logs over WebSocket and recovers missed blocks through `eth_getLogs` after reconnects.
- This implementation does **not** use the `get_recent_trades` API described by older documentation and does not subscribe to Hyperliquid exchange liquidation trades.

## Alert behavior

- Tracks BTC liquidation events only; ETH and other non-BTC events are ignored.
- Aggregates BTC events into fixed 5-minute windows and compares each completed window's total with the immediately preceding BTC window. Sends an alert with an up arrow when the total increases and a down arrow when it decreases. Equal totals produce no alert. If the previous window is unavailable (such as immediately after a fresh baseline), the comparison is skipped. There is no `LIQ SECONDS` threshold.
- Alert lines are `LIQS`, `LONG`, `SHORT`, `SECONDS`, and `LIQ SPAN`.
- `SECONDS` is the number of distinct block-timestamp seconds containing counted liquidations. `LIQ SPAN` is the elapsed time in seconds between the first and last counted liquidation in that window; it does not imply uninterrupted activity.
- Events that cannot be classified as LONG or SHORT still count toward `LIQS`. The comparison uses total liquidation count regardless of side; the alert still shows `LONG`, `SHORT`, `SECONDS`, and `LIQ SPAN`, without a separate `UNKNOWN` line.
- Deduplicates by transaction hash and log index, with additional per-window position deduplication.
- On first startup, establishes a block baseline instead of replaying historical events from earlier periods.
- Persists monitor state at `STATE_PATH` (default: `/data/state.json`).

## Configuration

Required environment variables:

- `NODEFLARE_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Optional:

- `POLL_MS` (default 1000 ms; minimum 1000). This controls the processing loop, not the WebSocket event stream; alert timing can still be delayed by RPC recovery or Telegram/network latency.
- JSON-RPC requests are spaced by at least 250 ms (maximum 4 requests/second per monitor process). HTTP 429 responses use exponential backoff, honoring numeric `Retry-After` values up to 60 seconds; the outer loop waits 15 seconds after a 429 failure.
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
