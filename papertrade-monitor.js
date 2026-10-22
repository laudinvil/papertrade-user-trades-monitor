import fs from 'node:fs';
import path from 'node:path';

const RPC_KEY = process.env.NODEFLARE_API_KEY || '';
const RPC_URL = RPC_KEY ? `https://rpc.nodeflare.app/hl/v1/${RPC_KEY}` : '';
const POLL_MS = Math.max(1000, Number(process.env.POLL_MS || 1000));
const STATE_PATH = process.env.STATE_PATH || '/data/state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const SEEN_LIMIT = 10000;
const WINDOW_MS = 5 * 60 * 1000;
const CASCADE_GAP_MS = 1000;
const CONTRACT = '0x6cd5661646289fb6e65ea5c032310fded797d0a2';
const LIQUIDATED_TOPIC = '0x87902ed2451849f465fc4d36a01d7f5c67b53af12f63ee85d2814a2d582f89bf';
const MONITOR_VERSION = 'http-rpc-liquidated-topic-2026-10-23-v23-min-peak-3';
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
      lastSentAlertPeriodStart: Number.isSafeInteger(s.lastSentAlertPeriodStart) ? s.lastSentAlertPeriodStart : null,
      pending: [],
    };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { initialized: false, seenKeys: [], windows: {}, lastScannedBlock: null, lastSentAlertPeriodStart: null, pending: [] };
    }
    // Never silently reset deduplication or unsent alerts when persisted state is unreadable.
    throw new Error(`Cannot load persisted monitor state at ${STATE_PATH}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let state = loadState();
const seen = new Set(state.seenKeys);
const windows = state.windows;
let pending = [];
const blockTimestampCache = new Map();
const SUMMARY_INTERVAL_MS = 60_000;
let lastSummaryAt = 0;
const RPC_MIN_INTERVAL_MS = 250;
let lastRpcRequestAt = 0;

function saveState() {
  const next = {
    initialized: true,
    eventFilterVersion: 3,
    seenKeys: [...seen].slice(-SEEN_LIMIT),
    windows,
    lastScannedBlock: state.lastScannedBlock,
    lastSentAlertPeriodStart: state.lastSentAlertPeriodStart ?? null,
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
  // uint64 price, uint64 bustPrice, bool flag, uint256 feeA, uint256 feeB).
  // The first two data words are price and bustPrice; do not use PositionClosed's topic.
  const data = String(log.data || '').replace(/^0x/, '');
  if (data.length < 5 * 64) return { error: 'data_too_short', dataLength: data.length + 2, dataWords: Math.floor(data.length / 64) };
  if (data.length % 64 !== 0) return { error: 'data_length_not_word_aligned', dataLength: data.length + 2, dataWords: Math.floor(data.length / 64) };
  let markPrice;
  let bustPrice;
  try {
    markPrice = BigInt('0x' + data.slice(0, 64));
    bustPrice = BigInt('0x' + data.slice(64, 128));
  } catch {
    return { error: 'price_word_parse_failed', dataLength: data.length + 2, dataWords: data.length / 64, firstWords: [data.slice(0, 64), data.slice(64, 128)] };
  }
  // A zero bustPrice is present in live Liquidated logs. Do not discard the
  // liquidation solely for that value: retain its count and leave direction unknown.
  // Only markPrice is used to distinguish the instrument; side is inferred only
  // when both prices are positive and comparable.
  if (markPrice <= 0n) {
    return {
      error: 'zero_or_negative_mark_price',
      dataLength: data.length + 2,
      dataWords: data.length / 64,
      markPrice: markPrice.toString(),
      bustPrice: bustPrice.toString(),
      firstWords: [data.slice(0, 64), data.slice(64, 128)],
    };
  }

  // Current protocol price ranges: BTC is >= 500,000; ETH is below this boundary.
  const instrument = markPrice >= 500000n ? 'BTC' : 'ETH';
  // Do not guess LONG/SHORT when bustPrice is zero or unavailable.
  const side = bustPrice > 0n
    ? (markPrice < bustPrice ? 'LONG' : markPrice > bustPrice ? 'SHORT' : null)
    : null;
  return { instrument, side, markPrice: markPrice.toString(), bustPrice: bustPrice.toString() };
}

function liqSpanSeconds(bucket) {
  return bucket.firstLiquidationAt != null && bucket.lastLiquidationAt != null
    ? Math.max(0, Math.round((Number(bucket.lastLiquidationAt) - Number(bucket.firstLiquidationAt)) / 1000))
    : 0;
}

function peakLiqsPerSecond(bucket) {
  const timestamps = (Array.isArray(bucket.liquidationTimestamps) ? bucket.liquidationTimestamps : [])
    .map(Number)
    .filter(ts => Number.isFinite(ts) && ts > 0);
  const countsBySecond = new Map();
  for (const ts of timestamps) {
    const second = Math.floor(ts / 1000);
    countsBySecond.set(second, (countsBySecond.get(second) || 0) + 1);
  }
  return countsBySecond.size ? Math.max(...countsBySecond.values()) : 0;
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
  // Link the immediately upcoming market and the market after one intervening 5-minute market.
  const windowStartSeconds = Math.floor(Number(bucket.start) / 1000);
  const nextMarketUrl = `https://polymarket.com/event/${instrument.toLowerCase()}-updown-5m-${windowStartSeconds + (WINDOW_MS / 1000)}`;
  const followingMarketUrl = `https://polymarket.com/event/${instrument.toLowerCase()}-updown-5m-${windowStartSeconds + (2 * WINDOW_MS / 1000)}`;
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
    `PEAK: ${peakLiqsPerSecond(bucket)} liqs/s`,
    `CASCADE: ${cascadeStats(bucket).maxCascade}`,
    `SERIES: ${cascadeStats(bucket).cascadeCount}`,
    `<a href="${nextMarketUrl}">Начинающийся маркет</a>`,
    `<a href="${followingMarketUrl}">Следующий маркет</a>`,
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
  const latestBlock = await getBlockNumber();
  let logs;
  if (firstScan) {
    state.lastScannedBlock = latestBlock;
    saveState();
    logs = [];
    console.log(JSON.stringify({
      level: 'info', event: 'chain_baseline_initialized',
      latestBlock, historicalScan: false,
      note: 'Counting starts with new on-chain Liquidated logs after the baseline block.',
    }));
  } else {
    // HTTP RPC eth_getLogs is the only event source.
    const fromBlock = Number(state.lastScannedBlock) + 1;
    logs = fromBlock <= latestBlock
      ? await getLiquidationLogs(fromBlock, latestBlock)
      : [];
    // Advance the cursor only after every eth_getLogs chunk has succeeded.
    state.lastScannedBlock = latestBlock;
  }

  const blockTimestamps = new Map();
  const now = Date.now();
  const currentStart = periodStart(now);
  let decoded = 0;
  const decodedByInstrument = { BTC: 0, ETH: 0 };
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
    if (!classified || classified.error) {
      invalidLogs++;
      seen.add(key);
      console.warn(JSON.stringify({
        level: 'warn', event: 'onchain_liquidation_decode_failed',
        positionId: chainEvent.positionId, blockNumber,
        reason: classified?.error || 'unknown_decode_failure',
        dataLength: classified?.dataLength ?? String(log.data || '').length,
        dataWords: classified?.dataWords ?? null,
        markPrice: classified?.markPrice ?? null,
        bustPrice: classified?.bustPrice ?? null,
        firstWords: classified?.firstWords ?? null,
      }));
      continue;
    }

    decodedByInstrument[classified.instrument] = (decodedByInstrument[classified.instrument] || 0) + 1;
    const bucket = getWindow(periodStart(chainEvent.ts), classified.instrument);
    if (!Array.isArray(bucket.eventKeys)) bucket.eventKeys = [];
    if (!Array.isArray(bucket.positionIds)) bucket.positionIds = [];
    if (!Array.isArray(bucket.positionKeys)) bucket.positionKeys = [];
    const positionId = chainEvent.positionId == null ? null : String(chainEvent.positionId);
    const positionKey = positionId && chainEvent.user
      ? `${String(chainEvent.user).toLowerCase()}:${positionId}`
      : positionId;
    // Count each distinct on-chain Liquidated log as an event. Multiple
    // liquidation logs for the same position are still separate events; the
    // position key is retained only for a unique-position diagnostic.
    if (bucket.eventKeys.includes(key)) {
      seen.add(key);
      continue;
    }
    bucket.eventKeys.push(key);
    if (positionKey && !bucket.positionKeys.includes(positionKey)) bucket.positionKeys.push(positionKey);
    if (positionId && !bucket.positionIds.includes(positionId)) bucket.positionIds.push(positionId);
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
  // Keep empty buckets for both instruments so completed periods with zero
  // liquidations can be evaluated without changing the alert gate.
  getWindow(currentStart, 'BTC');
  getWindow(currentStart, 'ETH');

  saveState();

  let alerts = 0;
  const completedWindows = Object.values(windows)
    .filter(bucket => Number(bucket.start) + WINDOW_MS <= now && bucket.alerted !== true)
    .sort((a, b) => Number(a.start) - Number(b.start) || String(a.instrument).localeCompare(String(b.instrument)));

  // Never replay a backlog of old 5-minute alerts after downtime/restarts.
  // Only send a window that just closed; older unalerted windows are permanently skipped.
  const MAX_ALERT_DELAY_MS = 60_000;
  for (const bucket of completedWindows) {
    const closedAt = Number(bucket.start) + WINDOW_MS;
    if (now - closedAt > MAX_ALERT_DELAY_MS) {
      bucket.alerted = true;
      console.log(JSON.stringify({
        level: 'info', event: 'liquidation_5m_alert_suppressed_stale',
        instrument: bucket.instrument,
        periodStart: new Date(bucket.start).toISOString(),
        ageMs: now - closedAt,
        maxAlertDelayMs: MAX_ALERT_DELAY_MS,
      }));
      saveState();
    }
  }

  const freshCompletedWindows = completedWindows.filter(bucket => !bucket.alerted);
  // LIQ SPAN >= 0 is the configured alert condition; no API side correction is used.
  for (const bucket of freshCompletedWindows) {
    const instrument = String(bucket.instrument || '').toUpperCase();
    if (instrument !== 'BTC' && instrument !== 'ETH') {
      bucket.alerted = true;
      saveState();
      continue;
    }

    const totalLiqs = Number(bucket.total || 0);
    const shortLiqs = Number(bucket.short || 0);
    const unknownLiqs = Number(bucket.unknownSide || 0);
    const liqSeconds = Array.isArray(bucket.liquidationSeconds) ? new Set(bucket.liquidationSeconds).size : 0;
    const currentSpanSeconds = liqSpanSeconds(bucket);
    const cascades = cascadeStats(bucket);
    const peakLiqs = peakLiqsPerSecond(bucket);

    if (peakLiqs < 3) {
      bucket.alerted = true;
      console.log(JSON.stringify({
        level: 'info', event: 'liquidation_5m_alert_suppressed_peak_below_minimum',
        instrument,
        periodStart: new Date(bucket.start).toISOString(),
        peakLiqsPerSecond: peakLiqs,
        minimumPeakLiqsPerSecond: 3,
        liqs: totalLiqs,
        liqSpanSeconds: currentSpanSeconds,
      }));
      saveState();
      continue;
    }

    if (currentSpanSeconds < 0) {
      bucket.alerted = true;
      console.log(JSON.stringify({
        level: 'info', event: 'liquidation_5m_alert_suppressed_liq_span_below_minimum',
        instrument,
        periodStart: new Date(bucket.start).toISOString(),
        liqSpanSeconds: currentSpanSeconds,
        minimumLiqSpanSeconds: 0,
        liqs: totalLiqs,
      }));
      saveState();
      continue;
    }

    // Persist the per-window send claim BEFORE calling Telegram. This makes
    // delivery at-most-once across restarts, preventing duplicate messages if
    // Telegram accepts the message but the process exits before saving state.
    bucket.alerted = true;
    bucket.alertClaimedAt = Date.now();
    saveState();
    try {
      await send(alertText(bucket));
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error', event: 'liquidation_5m_alert_send_failed',
        instrument,
        periodStart: new Date(bucket.start).toISOString(),
        error: String(error?.message || error),
        note: 'Window remains claimed to prevent duplicate Telegram alerts.',
      }));
      throw error;
    }
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
      monitorVersion: MONITOR_VERSION,
      liquidationEventTopic: LIQUIDATED_TOPIC,
      intervalMs: SUMMARY_INTERVAL_MS,
      latestBlock,
      source: firstScan ? 'initial_rpc_baseline' : 'http_rpc_eth_getLogs',
      onchainLiquidationsFound: logs.length,
      decodedOnchainLiquidations: decoded,
      decodedByInstrument,
      currentFiveMinuteWindowByInstrument: {
        BTC: Number(getWindow(currentStart, 'BTC').total || 0),
        ETH: Number(getWindow(currentStart, 'ETH').total || 0),
      },
      retainedWindowsEventTotalsByInstrument: {
        BTC: Object.values(windows).filter(bucket => bucket.instrument === 'BTC').reduce((sum, bucket) => sum + Number(bucket.total || 0), 0),
        ETH: Object.values(windows).filter(bucket => bucket.instrument === 'ETH').reduce((sum, bucket) => sum + Number(bucket.total || 0), 0),
      },
      invalidOnchainLogs: invalidLogs,
      skippedOldBaseline,
      alertsSent: alerts,
      sourceMode: 'http_rpc_only',
    }));
    lastSummaryAt = summaryNow;
  }
}

console.log(JSON.stringify({
  level: 'info',
  event: 'monitor_started',
  monitorVersion: MONITOR_VERSION,
  mode: 'onchain_liquidations_only',
  alertPolicy: 'completed_btc_eth_5m_windows_peak_liqs_per_second_gte_3',
  marketLinkOffsetsPeriods: [1, 3],
  minimumLiqSpanSeconds: 298,
  pollMs: POLL_MS,
  periodMs: WINDOW_MS,
  contract: CONTRACT,
  liquidationEventTopic: LIQUIDATED_TOPIC,
  chainId: '0x3e7',
  endpoint: 'NodeFlare HTTP RPC eth_getLogs only; side source: on-chain event only',
  statePath: STATE_PATH,
}));

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
