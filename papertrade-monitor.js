import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const RPC_KEY = process.env.NODEFLARE_API_KEY || '';
const RPC_URL = RPC_KEY ? `https://rpc.nodeflare.app/hl/v1/${RPC_KEY}` : '';
const WS_URL = RPC_KEY ? `wss://rpc.nodeflare.app/hl/ws/v1/${RPC_KEY}` : '';
const POLL_MS = Math.max(2000, Number(process.env.POLL_MS || 2000));
const STATE_PATH = process.env.STATE_PATH || '/data/state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const SEEN_LIMIT = 10000;
const WINDOW_MS = 5 * 60 * 1000;
const CONTRACT = '0x6cd5661646289fb6e65ea5c032310fded797d0a2';
const LIQUIDATED_TOPIC = '0x87902ed2451849f465fc4d36a01d7f5c67b53af12f63ee85d2814a2d582f89bf';
const ENABLE_ALERTS = process.env.ENABLE_LIQUIDATION_ALERTS !== 'false';
const INITIAL_LOOKBACK_BLOCKS = 400;
const BLOCK_CHUNK = 100;

if (!RPC_KEY) throw new Error('Set NODEFLARE_API_KEY.');
if (!BOT_TOKEN || !CHAT_ID) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const esc = v => String(v ?? '—').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return {
      initialized: s.initialized === true,
      seenKeys: Array.isArray(s.seenKeys) ? s.seenKeys.map(String).slice(-SEEN_LIMIT) : [],
      windows: s.windows && typeof s.windows === 'object' ? s.windows : {},
      lastScannedBlock: Number.isSafeInteger(s.lastScannedBlock) ? s.lastScannedBlock : null,
      pending: [],
    };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { initialized: false, seenKeys: [], windows: {}, lastScannedBlock: null, pending: [] };
    }
    // Never silently reset deduplication or unsent alerts when persisted state is unreadable.
    throw new Error(`Cannot load persisted monitor state at ${STATE_PATH}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let state = loadState();
const seen = new Set(state.seenKeys);
const windows = {}; // Kept empty for compatibility with previously persisted state; alerts are event-driven.
let pending = [];
let liveLogs = [];
let liveSocketConnected = false;
let liveSocketStatus = 'starting';
let highestObservedBlock = null;
const blockTimestampCache = new Map();
const WS_CURSOR_SAFETY_BLOCKS = 10;
const SUMMARY_INTERVAL_MS = 60_000;
let lastSummaryAt = 0;
let lastWsError = null;

function saveState() {
  const next = {
    initialized: true,
    seenKeys: [...seen].slice(-SEEN_LIMIT),
    windows,
    lastScannedBlock: state.lastScannedBlock,
    pending,
  };
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next));
  fs.renameSync(tmp, STATE_PATH);
  state = next;
  if (seen.size > SEEN_LIMIT) {
    seen.clear();
    for (const key of state.seenKeys) seen.add(key);
  }
}

async function rpc(method, params = []) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(10000),
      });
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 2000)
          : Math.min(250 * (2 ** attempt), 2000);
        lastError = new Error(`${method}: HTTP ${response.status}`);
        if (attempt < 4) {
          await sleep(delay);
          continue;
        }
        throw lastError;
      }
      if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
      const body = await response.json();
      if (body.error) throw new Error(`${method}: ${body.error.message || JSON.stringify(body.error)}`);
      return body.result;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      const retryable = /HTTP 429|HTTP 5\d\d|fetch failed|timeout|aborted/i.test(message);
      if (!retryable || attempt >= 4) throw err;
      const delay = Math.min(250 * (2 ** attempt), 2000);
      await sleep(delay);
    }
  }
  throw lastError || new Error(`${method}: RPC failed after retries`);
}

function legacyEventKey(log) {
  return `${String(log.transactionHash).toLowerCase()}:${Number(log.logIndex)}`;
}

function walletFromLog(log) {
  return log.topics?.[2] ? '0x' + log.topics[2].slice(-40).toLowerCase() : null;
}

function eventKey(log) {
  const wallet = walletFromLog(log);
  if (!wallet) return legacyEventKey(log);
  return `${Number(BigInt(log.blockNumber))}:${wallet}`;
}

function periodStart(ts) {
  return Math.floor(ts / WINDOW_MS) * WINDOW_MS;
}

function getWindow(start, instrument) {
  const key = `${start}:${instrument}`;
  if (!windows[key]) {
    windows[key] = { start, instrument, total: 0, long: 0, short: 0, eventKeys: [], positionIds: [], alerted: false };
  }
  return windows[key];
}

function alertText(event) {
  return [
    '<b>LIQUIDATION</b>',
    `WALLET: ${esc(event.user || 'UNKNOWN')}`,
    `BLOCK: ${Number(event.blockNumber)}`,
    `https://polymarket.com/event/btc-updown-5m-${Number(event.marketStart)}`,
  ].join('\n');
}

async function send(message) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(12000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) {
    throw new Error(`Telegram HTTP ${response.status}: ${body.description || 'send failed'}`);
  }
}

async function getBlockNumber() {
  return Number(BigInt(await rpc('eth_blockNumber')));
}

async function getLiquidationLogs(fromBlock, toBlock) {
  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += BLOCK_CHUNK) {
    const end = Math.min(toBlock, start + BLOCK_CHUNK - 1);
    const part = await rpc('eth_getLogs', [{
      address: CONTRACT,
      fromBlock: `0x${start.toString(16)}`,
      toBlock: `0x${end.toString(16)}`,
      topics: [LIQUIDATED_TOPIC],
    }]);
    logs.push(...part);
  }
  return logs;
}

async function runWebSocketLoop() {
  while (true) {
    let socket;
    try {
      socket = new WebSocket(WS_URL);
      await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      liveSocketConnected = true;
      liveSocketStatus = 'connected';
      lastWsError = null;
      console.log(JSON.stringify({ level: 'info', event: 'nodeflare_ws_connected' }));

      let requestId = 1;
      const readySubscriptions = new Set();
      const onMessage = raw => {
        let message;
        try { message = JSON.parse(String(raw)); } catch { return; }
        if ((message.id === requestId || message.id === requestId + 1) && message.result) {
          readySubscriptions.add(message.id);
          if (readySubscriptions.size === 2) {
            liveSocketStatus = 'subscribed';
            console.log(JSON.stringify({ level: 'info', event: 'nodeflare_ws_subscribed', subscriptions: 2 }));
          }
          return;
        }
        const result = message?.params?.result;
        if (message.method === 'eth_subscription' && result?.number) {
          const block = Number(BigInt(result.number));
          if (Number.isSafeInteger(block)) {
            highestObservedBlock = Math.max(highestObservedBlock ?? 0, block);
            if (result.timestamp) {
              blockTimestampCache.set(block, Number(BigInt(result.timestamp)) * 1000);
              if (blockTimestampCache.size > 1000) blockTimestampCache.delete(blockTimestampCache.keys().next().value);
            }
          }
        }
        if (message.method === 'eth_subscription' && result?.transactionHash && result?.blockNumber) {
          const topic0 = String(result.topics?.[0] || '').toLowerCase();
          if (topic0 === LIQUIDATED_TOPIC) liveLogs.push(result);
          else console.warn(JSON.stringify({ level: 'warn', event: 'non_liquidation_log_ignored', topic0 }));
        }
        if (message.error) {
          console.error(JSON.stringify({ level: 'error', event: 'nodeflare_ws_error', message: message.error.message || 'subscription error' }));
        }
      };
      socket.on('message', onMessage);
      socket.send(JSON.stringify({
        jsonrpc: '2.0', id: requestId, method: 'eth_subscribe',
        params: ['logs', { address: CONTRACT, topics: [LIQUIDATED_TOPIC] }],
      }));
      socket.send(JSON.stringify({
        jsonrpc: '2.0', id: requestId + 1, method: 'eth_subscribe', params: ['newHeads'],
      }));

      // Recover only the gap since the last confirmed cursor after reconnect.
      // On first boot, the normal baseline scan initializes the cursor.
      await new Promise((resolve, reject) => {
        const check = setInterval(() => {
          if (readySubscriptions.size === 2) { clearInterval(check); resolve(); }
          else if (socket.readyState !== WebSocket.OPEN) { clearInterval(check); reject(new Error('WebSocket closed before subscription confirmation')); }
        }, 100);
        setTimeout(() => { clearInterval(check); reject(new Error('WebSocket subscription timeout')); }, 10000);
      });
      if (state.lastScannedBlock != null) {
        const latest = await getBlockNumber();
        const from = Math.max(0, state.lastScannedBlock - WS_CURSOR_SAFETY_BLOCKS + 1);
        if (from <= latest) {
          const recovered = await getLiquidationLogs(from, latest);
          liveLogs.push(...recovered);
          console.log(JSON.stringify({ level: 'info', event: 'nodeflare_ws_gap_recovered', fromBlock: from, toBlock: latest, logs: recovered.length }));
        }
      }

      await new Promise(resolve => socket.once('close', resolve));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== lastWsError) {
        console.error(JSON.stringify({ level: 'warn', event: 'nodeflare_ws_disconnected', message }));
        lastWsError = message;
      }
    } finally {
      liveSocketConnected = false;
      liveSocketStatus = 'disconnected';
      if (socket) {
        try { socket.terminate(); } catch {}
      }
    }
    await sleep(2000);
  }
}


async function getBlockTimestamp(blockNumber, cache) {
  if (!cache.has(blockNumber) && blockTimestampCache.has(blockNumber)) {
    cache.set(blockNumber, blockTimestampCache.get(blockNumber));
  }
  if (!cache.has(blockNumber)) {
    const block = await rpc('eth_getBlockByNumber', [`0x${blockNumber.toString(16)}`, false]);
    if (!block?.timestamp) throw new Error(`Missing timestamp for block ${blockNumber}`);
    const timestamp = Number(BigInt(block.timestamp)) * 1000;
    cache.set(blockNumber, timestamp);
    blockTimestampCache.set(blockNumber, timestamp);
    if (blockTimestampCache.size > 1000) blockTimestampCache.delete(blockTimestampCache.keys().next().value);
  }
  return cache.get(blockNumber);
}

async function poll() {
  const firstScan = state.lastScannedBlock == null;
  let latestBlock = null;
  let logs;

  if (firstScan) {
    latestBlock = await getBlockNumber();
    state.lastScannedBlock = latestBlock;
    saveState();
    logs = [];
    console.log(JSON.stringify({
      level: 'info', event: 'chain_baseline_initialized',
      latestBlock, historicalScan: false,
      note: 'Only new live Liquidated logs are alerted; no 5-minute aggregation.',
    }));
  } else {
    logs = liveLogs.slice();
  }

  let sent = 0;
  let failed = 0;
  let duplicate = 0;
  let latestProcessedBlock = state.lastScannedBlock ?? latestBlock ?? 0;
  const timestampCache = new Map();

  // Migrate previously sent transaction:logIndex keys into block:wallet groups before
  // processing, so reconnect recovery cannot resend a group already alerted by the old version.
  for (const log of logs) {
    if (seen.has(legacyEventKey(log))) seen.add(eventKey(log));
  }

  // One alert per block + wallet, regardless of how many position logs that wallet has in the block.
  for (const log of logs) {
    const key = eventKey(log);
    const blockNumber = Number(BigInt(log.blockNumber));
    latestProcessedBlock = Math.max(latestProcessedBlock, blockNumber);
    if (seen.has(key)) {
      duplicate++;
      continue;
    }

    const event = {
      key,
      blockNumber,
      transactionHash: String(log.transactionHash || ''),
      logIndex: Number(BigInt(log.logIndex)),
      positionId: log.topics?.[1] ? BigInt(log.topics[1]).toString() : null,
      user: log.topics?.[2] ? '0x' + log.topics[2].slice(-40) : null,
      dataLength: String(log.data || '').length,
    };

    try {
      const blockTimestamp = await getBlockTimestamp(blockNumber, timestampCache);
      // Link the next 5-minute BTC Up/Down market, not the market period that is already underway.
      event.marketStart = Math.floor(blockTimestamp / WINDOW_MS) * (WINDOW_MS / 1000) + (WINDOW_MS / 1000);
      if (!ENABLE_ALERTS) {
        seen.add(key);
        console.log(JSON.stringify({ level: 'warn', event: 'liquidation_alert_suppressed_until_enabled', positionId: event.positionId, blockNumber }));
        saveState();
        continue;
      }
      await send(alertText(event));
      seen.add(key);
      sent++;
      // Persist each successful delivery immediately so a restart does not resend already-sent events.
      state.lastScannedBlock = Math.max(state.lastScannedBlock ?? 0, blockNumber);
      saveState();
      console.log(JSON.stringify({
        level: 'info', event: 'liquidation_alert_sent_realtime',
        positionId: event.positionId,
        blockNumber,
        transactionHash: event.transactionHash,
        logIndex: event.logIndex,
        dataLength: event.dataLength,
      }));
    } catch (err) {
      failed++;
      console.error(JSON.stringify({
        level: 'error', event: 'liquidation_alert_send_failed',
        positionId: event.positionId,
        blockNumber,
        transactionHash: event.transactionHash,
        message: err instanceof Error ? err.message : String(err),
      }));
      // Leave the log unmarked and in liveLogs; retry on the next poll.
      break;
    }
  }

  if (highestObservedBlock != null && failed === 0) {
    state.lastScannedBlock = Math.max(
      state.lastScannedBlock ?? 0,
      highestObservedBlock - WS_CURSOR_SAFETY_BLOCKS,
    );
  }
  const processedLogKeys = new Set(logs.filter(log => seen.has(eventKey(log))).map(eventKey));
  liveLogs = liveLogs.filter(log => !processedLogKeys.has(eventKey(log)));
  saveState();

  const summaryNow = Date.now();
  if (summaryNow - lastSummaryAt >= SUMMARY_INTERVAL_MS) {
    console.log(JSON.stringify({
      level: 'info', event: 'monitor_summary',
      intervalMs: SUMMARY_INTERVAL_MS,
      latestBlock: highestObservedBlock ?? latestBlock,
      source: firstScan ? 'initial_rpc_baseline' : 'websocket_logs',
      onchainLiquidationsFound: logs.length,
      alertsSentRealtime: sent,
      duplicateLogs: duplicate,
      alertSendFailures: failed,
      websocket: liveSocketStatus,
    }));
    lastSummaryAt = summaryNow;
  }
}
console.log(JSON.stringify({
  level: 'info',
  event: 'monitor_started',
  mode: 'onchain_liquidations_block_wallet_dedup',
  pollMs: POLL_MS,
  alertMode: ENABLE_ALERTS ? 'one_alert_per_block_wallet' : 'disabled_by_environment',
  contract: CONTRACT,
  chainId: '0x3e7',
  alertsEnabled: ENABLE_ALERTS,
  endpoint: 'NodeFlare WebSocket logs filtered by Liquidated topic; deduplication key is blockNumber + wallet; alerts enabled by default; set ENABLE_LIQUIDATION_ALERTS=false to disable',
  statePath: STATE_PATH,
}));

runWebSocketLoop().catch(err => console.error(JSON.stringify({ level: 'error', event: 'nodeflare_ws_loop_failed', message: String(err) })));

let lastPollError = null;
while (true) {
  let delay = POLL_MS;
  try {
    await poll();
    lastPollError = null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Keep recovery responsive; individual RPC calls already retry transient errors.
    delay = /HTTP 429|HTTP 5\d\d|timeout|fetch failed/i.test(message) ? 2000 : POLL_MS;
    if (message !== lastPollError) {
      console.error(JSON.stringify({
        level: 'error', event: 'poll_failed', message, retryInMs: delay,
      }));
      lastPollError = message;
    }
  }
  await sleep(delay);
}
