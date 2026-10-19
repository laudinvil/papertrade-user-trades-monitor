import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const RPC_KEY = process.env.NODEFLARE_API_KEY || '';
const RPC_URL = RPC_KEY ? `https://rpc.nodeflare.app/hl/v1/${RPC_KEY}` : '';
const WS_URL = RPC_KEY ? `wss://rpc.nodeflare.app/hl/ws/v1/${RPC_KEY}` : '';
const POLL_MS = Math.max(1000, Number(process.env.POLL_MS || 1000));
const STATE_PATH = process.env.STATE_PATH || '/data/state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const SEEN_LIMIT = 10000;
const WINDOW_MS = 5 * 60 * 1000;
const CASCADE_GAP_MS = 1000;
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
const RPC_MIN_INTERVAL_MS = 250;
let lastRpcRequestAt = 0;

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
      const waitMs = Math.max(0, RPC_MIN_INTERVAL_MS - (Date.now() - lastRpcRequestAt));
      if (waitMs > 0) await sleep(waitMs);
      lastRpcRequestAt = Date.now();
      const response = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(10000),
      });
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 60000)
          : Math.min(5000 * (2 ** attempt), 60000);
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
    windows[key] = { start, instrument, total: 0, long: 0, short: 0, eventKeys: [], positionIds: [], positionKeys: [], liquidationSeconds: [], firstLiquidationAt: null, lastLiquidationAt: null, alerted: false };
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

  // Current protocol price ranges: BTC is >= 500,000; ETH is below this boundary.
  const instrument = markPrice >= 500000n ? 'BTC' : 'ETH';
  // The event's markPrice is the observed mark and bustPrice is the liquidation threshold.
  // A LONG is liquidated when markPrice falls below bustPrice; a SHORT when it rises above.
  const side = markPrice < bustPrice ? 'LONG' : markPrice > bustPrice ? 'SHORT' : null;
  return { instrument, side, markPrice: markPrice.toString(), bustPrice: bustPrice.toString() };
}

function liqSpanSeconds(bucket) {
  return bucket.firstLiquidationAt != null && bucket.lastLiquidationAt != null
    ? Math.max(0, Math.round((Number(bucket.lastLiquidationAt) - Number(bucket.firstLiquidationAt)) / 1000))
    : 0;
}

function cascadeStats(bucket) {
  const timestamps = (Array.isArray(bucket.liquidationTimestamps) ? bucket.liquidationTimestamps : [])
    .map(Number)
    .filter(ts => Number.isFinite(ts) && ts > 0)
    .sort((a, b) => a - b);
  let run = 0;
  let cascadeCount = 0;
  let cascadeEvents = 0;
  let maxCascade = 0;
  for (let i = 0; i < timestamps.length; i++) {
    if (i === 0 || timestamps[i] - timestamps[i - 1] <= CASCADE_GAP_MS) {
      run++;
    } else {
      if (run >= 2) {
        cascadeCount++;
        cascadeEvents += run;
        maxCascade = Math.max(maxCascade, run);
      }
      run = 1;
    }
  }
  if (run >= 2) {
    cascadeCount++;
    cascadeEvents += run;
    maxCascade = Math.max(maxCascade, run);
  }
  return { cascadeCount, cascadeEvents, maxCascade };
}

function eventTimestamp(event) {
  const ts = Number(event?.ts);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

function alertText(bucket) {
  const instrument = String(bucket.instrument || '').toUpperCase();
  if (instrument !== 'BTC' && instrument !== 'ETH') {
    throw new Error(`Unsupported liquidation instrument: ${instrument}`);
  }
  const nextPeriodStartSeconds = Math.floor(Number(bucket.start) / 1000) + (WINDOW_MS / 1000);
  const polymarketUrl = `https://polymarket.com/event/${instrument.toLowerCase()}-updown-5m-${nextPeriodStartSeconds}`;
  const totalLiqs = Number(bucket.total || 0);
  const longLiqs = Number(bucket.long || 0);
  const shortLiqs = Number(bucket.short || 0);
  return [
    `<b>${esc(instrument)} 5m</b>`,
    `LIQS: ${totalLiqs}`,
    `LONG: ${Number(bucket.long || 0)}`,
    `SHORT: ${Number(bucket.short || 0)}`,
    `SECONDS: ${Array.isArray(bucket.liquidationSeconds) ? new Set(bucket.liquidationSeconds).size : 0}`,
    `LIQ SPAN: ${liqSpanSeconds(bucket)}s`,
    `CASCADE: ${cascadeStats(bucket).maxCascade}`,
    `SERIES: ${cascadeStats(bucket).cascadeCount}`,
    polymarketUrl,
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
    if (!Array.isArray(bucket.liquidationSeconds)) bucket.liquidationSeconds = [];
    if (!Array.isArray(bucket.liquidationTimestamps)) bucket.liquidationTimestamps = [];
    bucket.liquidationTimestamps.push(chainEvent.ts);
    const eventSecond = Math.floor(chainEvent.ts / 1000);
    if (!bucket.liquidationSeconds.includes(eventSecond)) bucket.liquidationSeconds.push(eventSecond);
    bucket.firstLiquidationAt = bucket.firstLiquidationAt == null
      ? chainEvent.ts : Math.min(Number(bucket.firstLiquidationAt), chainEvent.ts);
    bucket.lastLiquidationAt = bucket.lastLiquidationAt == null
      ? chainEvent.ts : Math.max(Number(bucket.lastLiquidationAt), chainEvent.ts);
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

  // Keep empty buckets for both instruments so completed periods with zero
  // liquidations can be evaluated without changing the alert gate.
  getWindow(currentStart, 'BTC');
  getWindow(currentStart, 'ETH');

  const processedLogKeys = new Set(logs.map(eventKey));
  liveLogs = liveLogs.filter(log => !processedLogKeys.has(eventKey(log)));
  saveState();

  let alerts = 0;
  const completedWindows = Object.values(windows)
    .filter(bucket => Number(bucket.start) + WINDOW_MS <= now && bucket.alerted !== true)
    .sort((a, b) => Number(a.start) - Number(b.start) || String(a.instrument).localeCompare(String(b.instrument)));

  for (const bucket of completedWindows) {
    const instrument = String(bucket.instrument || '').toUpperCase();
    if (instrument !== 'BTC' && instrument !== 'ETH') {
      bucket.alerted = true;
      saveState();
      continue;
    }

    const totalLiqs = Number(bucket.total || 0);
    const longLiqs = Number(bucket.long || 0);
    const shortLiqs = Number(bucket.short || 0);
    const unknownLiqs = Number(bucket.unknownSide || 0);
    const liqSeconds = Array.isArray(bucket.liquidationSeconds) ? new Set(bucket.liquidationSeconds).size : 0;
    const currentSpanSeconds = liqSpanSeconds(bucket);
    const cascades = cascadeStats(bucket);

    // Alert thresholds are instrument-specific: BTC requires cascade >= 13,
    // while ETH keeps the existing threshold of cascade >= 9.
    const minimumCascade = instrument === 'BTC' ? 13 : 9;
    if (cascades.maxCascade < minimumCascade) {
      bucket.alerted = true;
      console.log(JSON.stringify({
        level: 'info', event: 'liquidation_5m_alert_suppressed_cascade_below_minimum',
        instrument,
        periodStart: new Date(bucket.start).toISOString(),
        liqs: totalLiqs,
        long: longLiqs,
        short: shortLiqs,
        cascadeCount: cascades.cascadeCount,
        maxCascade: cascades.maxCascade,
        minimumCascade,
        maxGapMs: CASCADE_GAP_MS,
      }));
      saveState();
      continue;
    }

    await send(alertText(bucket));
    alerts++;
    console.log(JSON.stringify({
      level: 'info', event: 'liquidation_5m_alert_sent',
      instrument,
      periodStart: new Date(bucket.start).toISOString(),
      liqs: totalLiqs,
      long: longLiqs,
      short: shortLiqs,
      unknown: unknownLiqs,
      liqSeconds,
      liqSpanSeconds: currentSpanSeconds,
      cascadeCount: cascades.cascadeCount,
      cascadeEvents: cascades.cascadeEvents,
      maxCascade: cascades.maxCascade,
      maxGapMs: CASCADE_GAP_MS,
      uniquePositions: Array.isArray(bucket.positionKeys) ? bucket.positionKeys.length : null,
      eventKeys: Array.isArray(bucket.eventKeys) ? bucket.eventKeys.length : null,
    }));
    bucket.alerted = true;
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
    delay = /HTTP 429/i.test(message) ? 15000
      : (message.includes('HTTP 5') || message.includes('timeout') || message.includes('fetch failed')) ? 10000 : POLL_MS;
    if (message !== lastPollError) {
      console.error(JSON.stringify({
        level: 'error', event: 'poll_failed', message, retryInMs: delay,
      }));
      lastPollError = message;
    }
  }
  await sleep(delay);
}
