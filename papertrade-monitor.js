import fs from 'node:fs';
import path from 'node:path';

const API_BASE = (process.env.PAPERTRADE_API_BASE_URL || 'https://papertrade-ai.ninabrekkerese.workers.dev/api/v1/tools').replace(/\/$/, '');
const RPC_KEY = process.env.NODEFLARE_API_KEY || '';
const RPC_URL = RPC_KEY ? `https://rpc.nodeflare.app/hl/v1/${RPC_KEY}` : '';
const POLL_MS = Math.max(5000, Number(process.env.POLL_MS || 5000));
const STATE_PATH = process.env.STATE_PATH || './data/state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const SEEN_LIMIT = 10000;
const PENDING_LIMIT = 5000;
const WINDOW_MS = 5 * 60 * 1000;
const CONTRACT = '0x6cd5661646289fb6e65ea5c032310fded797d0a2';
const LIQUIDATED_TOPIC = '0x87902ed2451849f465fc4d36a01d7f5c67b53af12f63ee85d2814a2d582f89bf';
const INITIAL_LOOKBACK_BLOCKS = 400;
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
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message || JSON.stringify(body.error)}`);
  return body.result;
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
  return candidates.find(e => String(e.kind || '').toLowerCase() === 'close') || candidates[0];
}

function countLiquidation(chainEvent, apiEvent) {
  const ts = chainEvent.ts;
  if (!Number.isFinite(ts) || ts <= 0) return false;
  const instrument = String(apiEvent?.instrument || '').trim().toUpperCase();
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

async function getBlockTimestamp(blockNumber, cache) {
  if (!cache.has(blockNumber)) {
    const block = await rpc('eth_getBlockByNumber', [`0x${blockNumber.toString(16)}`, false]);
    if (!block?.timestamp) throw new Error(`Missing timestamp for block ${blockNumber}`);
    cache.set(blockNumber, Number(BigInt(block.timestamp)) * 1000);
  }
  return cache.get(blockNumber);
}

async function poll() {
  const [latestBlock, apiEvents] = await Promise.all([getBlockNumber(), getRecentTrades()]);
  const apiByPosition = new Map();
  for (const event of apiEvents) {
    if (event?.positionId == null) continue;
    const id = String(event.positionId);
    if (!apiByPosition.has(id)) apiByPosition.set(id, []);
    apiByPosition.get(id).push(event);
  }

  let fromBlock;
  const firstScan = state.lastScannedBlock == null;
  if (firstScan) {
    fromBlock = Math.max(0, latestBlock - INITIAL_LOOKBACK_BLOCKS);
    console.log(JSON.stringify({
      level: 'info',
      event: 'chain_baseline_start',
      latestBlock,
      fromBlock,
      initialLookbackBlocks: latestBlock - fromBlock,
    }));
  } else {
    fromBlock = state.lastScannedBlock + 1;
  }

  const logs = fromBlock <= latestBlock ? await getLiquidationLogs(fromBlock, latestBlock) : [];
  const blockTimestamps = new Map();
  const now = Date.now();
  const currentStart = periodStart(now);
  const newPending = [];
  let enriched = 0;
  let unmatched = 0;
  let skippedOldBaseline = 0;

  for (const log of logs) {
    const key = eventKey(log);
    if (seen.has(key) || pending.some(p => p.key === key)) continue;
    const blockNumber = Number(BigInt(log.blockNumber));
    const ts = await getBlockTimestamp(blockNumber, blockTimestamps);
    const chainEvent = {
      key,
      blockNumber,
      transactionHash: log.transactionHash,
      logIndex: Number(BigInt(log.logIndex)),
      positionId: log.topics?.[1] ? BigInt(log.topics[1]).toString() : null,
      user: log.topics?.[2] ? `0x${log.topics[2].slice(-40)}` : null,
      ts,
    };

    // On first boot, avoid replaying old completed periods; only seed the active 5-minute period.
    if (firstScan && periodStart(ts) !== currentStart) {
      skippedOldBaseline++;
      seen.add(key);
      continue;
    }

    const match = matchApiEvent(chainEvent, apiByPosition);
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
    if (now - Number(chainEvent.createdAt || now) > PENDING_MAX_AGE_MS) {
      console.warn(JSON.stringify({ level: 'warn', event: 'liquidation_unmatched_expired', positionId: chainEvent.positionId, blockNumber: chainEvent.blockNumber }));
      seen.add(chainEvent.key);
      continue;
    }
    const match = matchApiEvent(chainEvent, apiByPosition);
    if (match && countLiquidation(chainEvent, match)) {
      enriched++;
    } else {
      stillPending.push(chainEvent);
    }
  }
  pending = [...stillPending, ...newPending].slice(-PENDING_LIMIT);

  state.lastScannedBlock = latestBlock;
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

  console.log(JSON.stringify({
    level: 'info',
    event: 'onchain_poll_completed',
    latestBlock,
    scannedFromBlock: fromBlock,
    scannedToBlock: latestBlock,
    onchainLiquidationsFound: logs.length,
    apiEventsReturned: apiEvents.length,
    enrichedThisPoll: enriched,
    pendingUnmatched: pending.length,
    unmatchedNewThisPoll: unmatched,
    skippedOldBaseline,
    alertsSent: alerts,
  }));
}

console.log(JSON.stringify({
  level: 'info',
  event: 'monitor_started',
  mode: 'onchain_liquidations_enriched_by_papertrade_api',
  pollMs: POLL_MS,
  periodMs: WINDOW_MS,
  contract: CONTRACT,
  chainId: '0x3e7',
  endpoint: 'eth_getLogs + get_recent_trades',
}));

let lastPollError = null;
while (true) {
  try {
    await poll();
    lastPollError = null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message !== lastPollError) {
      console.error(JSON.stringify({ level: 'error', event: 'poll_failed', message }));
      lastPollError = message;
    }
  }
  await sleep(POLL_MS);
}
