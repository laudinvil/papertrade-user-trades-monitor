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
const LIQUIDATED_TOPIC = '0x0c859bc5db091ba3b9dc10c00f8dfc78b1f0b7e2566d107253ae67c069ae5de8';
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
      seenKeys: s.eventFilterVersion === 3 && Array.isArray(s.seenKeys) ? s.seenKeys.map(String).slice(-SEEN_LIMIT) : [],
      windows: s.eventFilterVersion === 3 && s.windows && typeof s.windows === 'object' ? s.windows : {},
      lastScannedBlock: s.eventFilterVersion === 3 && Number.isSafeInteger(s.lastScannedBlock) ? s.lastScannedBlock : null,
      eventFilterVersion: 3,
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
const windows = state.windows;
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
    eventFilterVersion: 3,
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

function eventKey(log) {
  return `${String(log.transactionHash).toLowerCase()}:${Number(log.logIndex)}`;
}

function periodStart(ts) {
  return Math.floor(ts / WINDOW_MS) * WINDOW_MS;
}

function getWindow(start, instrument) {
  const key = `${start}:${instrument}`;
  if (!windows[key]) {
    windows[key] = { start, instrument, total: 0, long: 0, short: 0, eventKeys: [], positionIds: [], positionKeys: [], alerted: false };
  }
  return windows[key];
}

function decodeLiquidation(log) {
  // Liquidated(uint256 indexed positionId, address indexed user,
  // uint64 markPrice, uint64 bustPrice, bool fromQueuedBalance,
  // uint256 stakerFee, uint256 devFee). The two prices are the first ABI words.
  const data = String(log.data || '').replace(/^0x/, '');
  if (data.length < 5 * 64 || data.length % 64 !== 0) return null;
  let markPrice;
  let bustPrice;
  try {
    markPrice = BigInt('0x' + data.slice(0, 64));
    bustPrice = BigInt('0x' + data.slice(64, 128));
  } catch {
    return null;
  }
  if (markPrice <= 0n || bustPrice <= 0n) return null;

  // Current protocol scales: BTC=10, ETH=100. Their raw mark-price ranges are
  // currently separated around 500,000 (BTC ~830,000; ETH ~250,000).
  // Keep this threshold explicit so a future price-regime change is visible.
  const instrument = markPrice >= 500000n ? 'BTC' : 'ETH';
  // Longs bust below their liquidation price; shorts bust above it.
  // Long liquidation threshold is below markPrice; short threshold is above it.
  const side = markPrice > bustPrice ? 'LONG' : markPrice < bustPrice ? 'SHORT' : null;
  return { instrument, side, markPrice: markPrice.toString(), bustPrice: bustPrice.toString() };
}

function eventTimestamp(event) {
  const ts = Number(event?.ts);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

function alertText(periodStartMs, buckets) {
  const byInstrument = new Map(buckets.map(bucket => [String(bucket.instrument || '').toUpperCase(), bucket]));
  const btc = byInstrument.get('BTC') || { total: 0, long: 0, short: 0 };
  const eth = byInstrument.get('ETH') || { total: 0, long: 0, short: 0 };
  const total = Number(btc.total || 0) + Number(eth.total || 0);
  const long = Number(btc.long || 0) + Number(eth.long || 0);
  const short = Number(btc.short || 0) + Number(eth.short || 0);
  const nextPeriodStartSeconds = Math.floor(Number(periodStartMs) / 1000) + (WINDOW_MS / 1000);
  const symbols = ['btc', 'eth', 'sol', 'xrp', 'hype', 'doge', 'bnb'];
  const links = symbols.map(symbol =>
    `https://polymarket.com/event/${symbol}-updown-5m-${nextPeriodStartSeconds}`
  );
  return [
    '<b>BTC + ETH 5m LIQUIDATIONS</b>',
    `TOTAL LIQS: ${total}`,
    `BTC: ${Number(btc.total || 0)} | LONG: ${Number(btc.long || 0)} | SHORT: ${Number(btc.short || 0)}`,
    `ETH: ${Number(eth.total || 0)} | LONG: ${Number(eth.long || 0)} | SHORT: ${Number(eth.short || 0)}`,
    `COMBINED LONG: ${long} | SHORT: ${short}`,
    ...links,
  ].join(String.fromCharCode(10));
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
        if (message.method === 'eth_subscription' && result?.transactionHash && result?.blockNumber
          && String(result.topics?.[0] || '').toLowerCase() === LIQUIDATED_TOPIC) {
          liveLogs.push(result);
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
      note: 'Counting starts with live on-chain Liquidated logs.',
    }));
  } else {
    logs = liveLogs.slice();
  }

  const blockTimestamps = new Map();
  const now = Date.now();
  const currentStart = periodStart(now);
  let decoded = 0;
  let skippedOldBaseline = 0;
  let invalidLogs = 0;

  for (const log of logs) {
    const key = eventKey(log);
    if (seen.has(key)) continue;
    const blockNumber = Number(BigInt(log.blockNumber));
    const chainEvent = {
      key,
      blockNumber,
      transactionHash: log.transactionHash,
      logIndex: Number(BigInt(log.logIndex)),
      positionId: log.topics?.[1] ? BigInt(log.topics[1]).toString() : null,
      user: log.topics?.[2] ? '0x' + log.topics[2].slice(-40) : null,
      ts: null,
    };
    chainEvent.ts = await getBlockTimestamp(blockNumber, blockTimestamps);

    // Do not replay old completed windows on first startup.
    if (firstScan && periodStart(chainEvent.ts) !== currentStart) {
      skippedOldBaseline++;
      seen.add(key);
      continue;
    }

    const classified = decodeLiquidation(log);
    if (!classified) {
      invalidLogs++;
      seen.add(key);
      console.warn(JSON.stringify({
        level: 'warn', event: 'onchain_liquidation_decode_failed',
        positionId: chainEvent.positionId, blockNumber,
        dataLength: String(log.data || '').length,
      }));
      continue;
    }

    const bucket = getWindow(periodStart(chainEvent.ts), classified.instrument);
    if (!Array.isArray(bucket.eventKeys)) bucket.eventKeys = [];
    if (!Array.isArray(bucket.positionIds)) bucket.positionIds = [];
    if (!Array.isArray(bucket.positionKeys)) bucket.positionKeys = [];
    const positionId = chainEvent.positionId == null ? null : String(chainEvent.positionId);
    const positionKey = positionId && chainEvent.user
      ? `${String(chainEvent.user).toLowerCase()}:${positionId}`
      : positionId;
    if (bucket.eventKeys.includes(key) || (positionKey && bucket.positionKeys.includes(positionKey))) {
      seen.add(key);
      continue;
    }
    bucket.eventKeys.push(key);
    if (positionKey) bucket.positionKeys.push(positionKey);
    if (positionId) bucket.positionIds.push(positionId);
    bucket.total++;
    if (classified.side === 'LONG') bucket.long++;
    else if (classified.side === 'SHORT') bucket.short++;
    else bucket.unknownSide = Number(bucket.unknownSide || 0) + 1;
    seen.add(key);
    decoded++;
  }

  if (logs.length) {
    const highestLogBlock = Math.max(...logs.map(log => Number(BigInt(log.blockNumber))));
    state.lastScannedBlock = Math.max(state.lastScannedBlock ?? 0, highestLogBlock);
  }
  if (highestObservedBlock != null) {
    state.lastScannedBlock = Math.max(state.lastScannedBlock ?? 0, highestObservedBlock - WS_CURSOR_SAFETY_BLOCKS);
  }

  const processedLogKeys = new Set(logs.map(eventKey));
  liveLogs = liveLogs.filter(log => !processedLogKeys.has(eventKey(log)));
  saveState();

  let alerts = 0;
  const periods = new Map();
  for (const bucket of Object.values(windows)) {
    const start = Number(bucket.start);
    if (!periods.has(start)) periods.set(start, []);
    periods.get(start).push(bucket);
  }

  for (const [start, buckets] of periods) {
    if (start + WINDOW_MS > now || buckets.every(bucket => bucket.alerted)) continue;
    const eligible = buckets.filter(bucket => ['BTC', 'ETH'].includes(String(bucket.instrument || '').toUpperCase()));
    const total = eligible.reduce((sum, bucket) => sum + Number(bucket.total || 0), 0);
    if (total > 0) {
      await send(alertText(start, eligible));
      alerts++;
      console.log(JSON.stringify({
        level: 'info', event: 'liqs_5m_combined_alert_sent',
        periodStart: new Date(start).toISOString(),
        btcLiqs: eligible.filter(b => String(b.instrument).toUpperCase() === 'BTC').reduce((n, b) => n + Number(b.total || 0), 0),
        ethLiqs: eligible.filter(b => String(b.instrument).toUpperCase() === 'ETH').reduce((n, b) => n + Number(b.total || 0), 0),
        totalLiqs: total,
        long: eligible.reduce((n, b) => n + Number(b.long || 0), 0),
        short: eligible.reduce((n, b) => n + Number(b.short || 0), 0),
        uniquePositions: eligible.reduce((n, b) => n + (Array.isArray(b.positionKeys) ? b.positionKeys.length : 0), 0),
        eventKeys: eligible.reduce((n, b) => n + (Array.isArray(b.eventKeys) ? b.eventKeys.length : 0), 0),
      }));
    } else {
      console.log(JSON.stringify({
        level: 'info', event: 'liqs_5m_combined_alert_suppressed_empty',
        periodStart: new Date(start).toISOString(),
      }));
    }
    for (const bucket of buckets) bucket.alerted = true;
    saveState();
  }

  for (const [key, bucket] of Object.entries(windows)) {
    if (bucket.alerted && Number(bucket.start) + WINDOW_MS < now - 60 * 60 * 1000) delete windows[key];
  }
  saveState();

  const summaryNow = Date.now();
  if (summaryNow - lastSummaryAt >= SUMMARY_INTERVAL_MS) {
    console.log(JSON.stringify({
      level: 'info', event: 'monitor_summary',
      intervalMs: SUMMARY_INTERVAL_MS,
      latestBlock: highestObservedBlock ?? latestBlock,
      source: firstScan ? 'initial_rpc_baseline' : 'websocket_logs',
      onchainLiquidationsFound: logs.length,
      decodedOnchainLiquidations: decoded,
      invalidOnchainLogs: invalidLogs,
      skippedOldBaseline,
      alertsSent: alerts,
      websocket: liveSocketStatus,
    }));
    lastSummaryAt = summaryNow;
  }
}

console.log(JSON.stringify({
  level: 'info',
  event: 'monitor_started',
  mode: 'onchain_liquidations_only',
  pollMs: POLL_MS,
  periodMs: WINDOW_MS,
  contract: CONTRACT,
  liquidationEventTopic: LIQUIDATED_TOPIC,
  chainId: '0x3e7',
  endpoint: 'NodeFlare WebSocket Papertrade Exchange logs filtered to Liquidated event selector + reconnect gap recovery',
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
