import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const API_BASE = (process.env.PAPERTRADE_API_BASE_URL || 'https://papertrade-ai.ninabrekkerese.workers.dev/api/v1/tools').replace(/\/$/, '');
const EXCHANGE_API_BASE = (process.env.PAPERTRADE_EXCHANGE_API_BASE_URL || 'https://exchange.papertrade.xyz').replace(/\/$/, '');
const RPC_KEY = process.env.NODEFLARE_API_KEY || '';
const RPC_URL = RPC_KEY ? `https://rpc.nodeflare.app/hl/v1/${RPC_KEY}` : '';
const WS_URL = RPC_KEY ? `wss://rpc.nodeflare.app/hl/ws/v1/${RPC_KEY}` : '';
const POLL_MS = Math.max(2000, Number(process.env.POLL_MS || 2000));
const STATE_PATH = process.env.STATE_PATH || './data/state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const SEEN_LIMIT = 10000;
const PENDING_LIMIT = 5000;
const WINDOW_MS = 5 * 60 * 1000;
const CONTRACT = '0x6cd5661646289fb6e65ea5c032310fded797d0a2';
const LIQUIDATED_TOPIC = '0x87902ed2451849f465fc4d36a01d7f5c67b53af12f63ee85d2814a2d582f89bf';
const INITIAL_LOOKBACK_BLOCKS = 400;
const API_ENRICHMENT_MIN_INTERVAL_MS = 5000;
const BLOCK_CHUNK = 100;
const PENDING_MAX_AGE_MS = 60 * 60 * 1000;

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
      pending: Array.isArray(s.pending) ? s.pending : [],
    };
  } catch {
    return { initialized: false, seenKeys: [], windows: {}, lastScannedBlock: null, pending: [] };
  }
}

let state = loadState();
const seen = new Set(state.seenKeys);
const windows = state.windows;
let pending = state.pending;
let liveLogs = [];
let liveSocketConnected = false;
let liveSocketStatus = 'starting';
let highestObservedBlock = null;
let lastApiFetchAt = 0;
let cachedApiEvents = [];
const accountTradeCache = new Map();
const ACCOUNT_CACHE_TTL_MS = 5000;
const ACCOUNT_MAX_PAGES = 4;
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
    pending: pending.slice(-PENDING_LIMIT),
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

async function getRecentTrades() {
  const response = await fetch(`${API_BASE}/get_recent_trades`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`get_recent_trades HTTP ${response.status}`);
  const body = await response.json();
  if (body?.ok !== true || !Array.isArray(body?.data?.events)) {
    throw new Error('get_recent_trades returned an unexpected response');
  }
  return body.data.events;
}

async function getAccountTradeByPosition(wallet, positionId) {
  if (!wallet || positionId == null) return null;
  const address = String(wallet).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return null;
  const now = Date.now();
  const cached = accountTradeCache.get(address);
  if (cached && now - cached.fetchedAt < ACCOUNT_CACHE_TTL_MS) {
    return cached.items.find(item => String(item.positionId) === String(positionId)) || null;
  }

  const items = [];
  let cursor = null;
  for (let page = 0; page < ACCOUNT_MAX_PAGES; page++) {
    const url = new URL(`${EXCHANGE_API_BASE}/query/accounts/${address}/trades`);
    url.searchParams.set('filter', 'all');
    url.searchParams.set('limit', '75');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`account trades HTTP ${response.status} for ${address}`);
    const body = await response.json();
    if (!Array.isArray(body?.items)) {
      throw new Error(`account trades returned an unexpected response for ${address}`);
    }
    items.push(...body.items);
    const match = items.find(item => String(item.positionId) === String(positionId));
    if (match) {
      accountTradeCache.set(address, { fetchedAt: now, items });
      return match;
    }
    if (!body.nextCursor) break;
    cursor = String(body.nextCursor);
  }
  accountTradeCache.set(address, { fetchedAt: now, items });
  if (accountTradeCache.size > 500) {
    const oldest = accountTradeCache.keys().next().value;
    if (oldest) accountTradeCache.delete(oldest);
  }
  return null;
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
    windows[key] = { start, instrument, total: 0, long: 0, short: 0, eventKeys: [], alerted: false };
  }
  return windows[key];
}

function sideName(event) {
  if (typeof event?.isLong === 'boolean') return event.isLong ? 'LONG' : 'SHORT';
  const side = String(event?.side || event?.positionSide || '').trim().toUpperCase();
  if (side === 'LONG' || side.includes('LONG')) return 'LONG';
  if (side === 'SHORT' || side.includes('SHORT')) return 'SHORT';
  return null;
}

function eventTimestamp(event) {
  const ts = Number(event?.ts);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

function matchApiEvent(chainEvent, apiByPosition) {
  const candidates = apiByPosition.get(String(chainEvent.positionId)) || [];
  if (!candidates.length) return null;
  // The on-chain Liquidated log is the proof of liquidation. The API event is used only to enrich it.
  return candidates.find(e => /liquidat/i.test(String(e.kind || '')))
    || candidates.find(e => /close|positionclosed/i.test(String(e.kind || '')))
    || candidates[0];
}

async function enrichChainEvent(chainEvent, apiByPosition) {
  const recentMatch = matchApiEvent(chainEvent, apiByPosition);
  if (recentMatch) return recentMatch;
  return getAccountTradeByPosition(chainEvent.user, chainEvent.positionId);
}

function countLiquidation(chainEvent, apiEvent) {
  const ts = chainEvent.ts;
  if (!Number.isFinite(ts) || ts <= 0) return false;
  const instrument = String(apiEvent?.instrument || apiEvent?.symbol || '').trim().toUpperCase();
  if (!['BTC', 'ETH'].includes(instrument)) return false;

  const key = chainEvent.key;
  if (seen.has(key)) return true;
  const start = periodStart(ts);
  const bucket = getWindow(start, instrument);
  if (bucket.eventKeys.includes(key)) {
    seen.add(key);
    return true;
  }
  bucket.eventKeys.push(key);
  bucket.total++;
  const side = sideName(apiEvent);
  if (side === 'LONG') bucket.long++;
  else if (side === 'SHORT') bucket.short++;
  seen.add(key);
  return true;
}

function alertText(bucket) {
  const instrument = String(bucket.instrument || 'UNKNOWN').trim().toLowerCase();
  const periodStartSeconds = Math.floor(Number(bucket.start) / 1000);
  const polymarketUrl = `https://polymarket.com/event/${instrument}-updown-5m-${periodStartSeconds}`;
  return [
    `<b>${esc(bucket.instrument)} 5m</b>`,
    `LIQS: ${Number(bucket.total ?? (bucket.long + bucket.short))}`,
    `LONG: ${Number(bucket.long || 0)} | SHORT: ${Number(bucket.short || 0)}`,
    polymarketUrl,
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
          liveLogs.push(result);
          if (liveLogs.length > PENDING_LIMIT) liveLogs = liveLogs.slice(-PENDING_LIMIT);
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
          if (liveLogs.length > PENDING_LIMIT) liveLogs = liveLogs.slice(-PENDING_LIMIT);
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
    // Start from the current chain head instead of scanning hundreds of historical blocks.
    // Historical backfill caused hundreds of per-block timestamp RPC calls and HTTP 429s.
    latestBlock = await getBlockNumber();
    state.lastScannedBlock = latestBlock;
    saveState();
    logs = [];
    console.log(JSON.stringify({
      level: 'info', event: 'chain_baseline_initialized',
      latestBlock, historicalScan: false,
      note: 'Counting begins with live WebSocket events; reconnect recovery uses a small overlap.',
    }));
  } else {
    logs = liveLogs.slice();
  }

  // Papertrade is enrichment only. Rate-limit enrichment calls to at most once every
  // five seconds even if new chain events arrive on every two-second monitor cycle.
  let apiEvents = [];
  const needsEnrichment = logs.length > 0 || pending.length > 0;
  if (needsEnrichment && (Date.now() - lastApiFetchAt >= API_ENRICHMENT_MIN_INTERVAL_MS)) {
    cachedApiEvents = await getRecentTrades();
    lastApiFetchAt = Date.now();
    apiEvents = cachedApiEvents;
  } else if (needsEnrichment) {
    apiEvents = cachedApiEvents;
  }
  const apiByPosition = new Map();
  for (const event of apiEvents) {
    if (event?.positionId == null) continue;
    const id = String(event.positionId);
    if (!apiByPosition.has(id)) apiByPosition.set(id, []);
    apiByPosition.get(id).push(event);
  }

  const fromBlock = null;
  const blockTimestamps = new Map();
  const now = Date.now();
  const currentStart = periodStart(now);
  const newPending = [];
  let enriched = 0;
  let unmatched = 0;
  let skippedOldBaseline = 0;
  let expiredUnmatched = 0;

  for (const log of logs) {
    const key = eventKey(log);
    if (seen.has(key) || pending.some(p => p.key === key)) continue;
    const blockNumber = Number(BigInt(log.blockNumber));
    const chainEvent = {
      key,
      blockNumber,
      transactionHash: log.transactionHash,
      logIndex: Number(BigInt(log.logIndex)),
      positionId: log.topics?.[1] ? BigInt(log.topics[1]).toString() : null,
      user: log.topics?.[2] ? `0x${log.topics[2].slice(-40)}` : null,
      ts: null,
    };
    const match = await enrichChainEvent(chainEvent, apiByPosition);
    // Prefer the API event timestamp when supplied; this avoids one RPC request per log block.
    // API timestamps may be seconds or milliseconds, so normalize to milliseconds.
    const apiTsRaw = Number(match?.ts);
    if (Number.isFinite(apiTsRaw) && apiTsRaw > 0) {
      chainEvent.ts = apiTsRaw < 1e12 ? apiTsRaw * 1000 : apiTsRaw;
    } else {
      chainEvent.ts = await getBlockTimestamp(blockNumber, blockTimestamps);
    }

    // On first boot, avoid replaying old completed periods; only seed the active 5-minute period.
    if (firstScan && periodStart(chainEvent.ts) !== currentStart) {
      skippedOldBaseline++;
      seen.add(key);
      continue;
    }

    if (match) {
      if (countLiquidation(chainEvent, match)) enriched++;
      else {
        newPending.push({ ...chainEvent, createdAt: now });
        unmatched++;
      }
    } else {
      newPending.push({ ...chainEvent, createdAt: now });
      unmatched++;
    }
  }

  // Retry API enrichment for recently observed on-chain liquidations that were not in the latest API page.
  const stillPending = [];
  for (const chainEvent of pending) {
    const eventPeriodEnd = Number.isFinite(Number(chainEvent.ts)) && Number(chainEvent.ts) > 0
      ? periodStart(Number(chainEvent.ts)) + WINDOW_MS
      : null;
    // Once the 5-minute period is closed, an unmatched event cannot safely change an
    // already-sent alert. Drop it instead of carrying an ever-growing historical queue.
    if ((eventPeriodEnd != null && eventPeriodEnd <= now) ||
        now - Number(chainEvent.createdAt || now) > PENDING_MAX_AGE_MS) {
      expiredUnmatched++;
      seen.add(chainEvent.key);
      continue;
    }
    const match = await enrichChainEvent(chainEvent, apiByPosition);
    if (match && countLiquidation(chainEvent, match)) {
      enriched++;
    } else {
      stillPending.push(chainEvent);
    }
  }
  pending = [...stillPending, ...newPending].slice(-PENDING_LIMIT);

  if (logs.length) {
    const highestLogBlock = Math.max(...logs.map(log => Number(BigInt(log.blockNumber))));
    state.lastScannedBlock = Math.max(state.lastScannedBlock ?? 0, highestLogBlock);
  }
  // Advance the recovery cursor behind the observed head, leaving a safety overlap
  // so log notifications that arrive slightly after newHeads are recovered on reconnect.
  if (highestObservedBlock != null) {
    state.lastScannedBlock = Math.max(state.lastScannedBlock ?? 0, highestObservedBlock - WS_CURSOR_SAFETY_BLOCKS);
  }
  // Remove queued notifications only after processing and persistence succeed; API/RPC failures
  // must not silently discard live liquidation events.
  const processedLogKeys = new Set(logs.map(eventKey));
  liveLogs = liveLogs.filter(log => !processedLogKeys.has(eventKey(log)));
  saveState();

  let alerts = 0;
  for (const bucket of Object.values(windows)) {
    if (bucket.alerted || Number(bucket.start) + WINDOW_MS > now) continue;
    if (Number(bucket.total) > 0) {
      await send(alertText(bucket));
      alerts++;
      console.log(JSON.stringify({
        level: 'info',
        event: 'liqs_5m_alert_sent',
        instrument: bucket.instrument,
        periodStart: new Date(bucket.start).toISOString(),
        liqs: bucket.total,
        long: bucket.long,
        short: bucket.short,
      }));
    }
    bucket.alerted = true;
    saveState();
  }

  for (const [key, bucket] of Object.entries(windows)) {
    if (Number(bucket.start) + WINDOW_MS < now - 60 * 60 * 1000) delete windows[key];
  }
  saveState();

  const summaryNow = Date.now();
  if (summaryNow - lastSummaryAt >= SUMMARY_INTERVAL_MS) {
    console.log(JSON.stringify({
      level: 'info',
      event: 'monitor_summary',
      intervalMs: SUMMARY_INTERVAL_MS,
      latestBlock: highestObservedBlock ?? latestBlock,
      source: firstScan ? 'initial_rpc_baseline' : 'websocket_logs',
      onchainLiquidationsFound: logs.length,
      apiEventsReturned: apiEvents.length,
      enrichedThisPoll: enriched,
      pendingUnmatched: pending.length,
      unmatchedNewThisPoll: unmatched,
      expiredUnmatched,
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
  mode: 'onchain_liquidations_enriched_by_papertrade_api',
  pollMs: POLL_MS,
  periodMs: WINDOW_MS,
  contract: CONTRACT,
  chainId: '0x3e7',
  endpoint: 'websocket eth_subscribe logs + reconnect-only eth_getLogs + throttled Papertrade enrichment',
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
