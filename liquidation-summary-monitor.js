import fs from 'node:fs';
import path from 'node:path';

const RECENT_TRADES_URL = 'https://papertrade-ai.ninabrekkerese.workers.dev/api/v1/tools/get_recent_trades';
const POLL_MS = Math.max(60_000, Number(process.env.LIQUIDATION_SUMMARY_POLL_MS || 60_000));
const RATE_LIMIT_BACKOFF_MS = 60_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 300_000;
const PERIOD_SECONDS = 300;
const STATE_PATH = process.env.LIQUIDATION_SUMMARY_STATE_PATH || '/data/liquidation-summary-state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const MAX_SEEN = 20_000;
const MAX_WINDOWS = 288;
const VERSION = 'papertrade-liquidation-summary-5m-v5-protocol-feed-only';

if (!BOT_TOKEN || !CHAT_ID) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const esc = value => String(value ?? '—').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const money = value => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0.00';
  return `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const periodStartFor = seconds => Math.floor(seconds / PERIOD_SECONDS) * PERIOD_SECONDS;
const unixSeconds = value => {
  if (value == null || value === '') return 0;
  if (typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n > 1e12 ? n / 1000 : n);
};
const instrumentOf = event => {
  const value = String(event?.instrument || event?.symbol || event?.market || '').toUpperCase();
  if (value.includes('BTC') || value.includes('BITCOIN')) return 'BTC';
  if (value.includes('ETH') || value.includes('ETHEREUM')) return 'ETH';
  return null;
};
const kindOf = event => String(event?.kind || event?.type || event?.action || '').trim().toLowerCase();
const isLiquidation = event => ['liquidation', 'liquidated', 'position_liquidated', 'liquidate', 'bust'].includes(kindOf(event));
const sideOf = event => {
  const side = String(event?.side || event?.positionSide || '').trim().toLowerCase();
  if (side === 'long' || side === 'buy') return 'long';
  if (side === 'short' || side === 'sell') return 'short';
  return 'unknown';
};

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (saved.version !== 1) throw new Error('unsupported state version');
    return {
      initialized: saved.initialized === true,
      seenEvents: Array.isArray(saved.seenEvents) ? saved.seenEvents.map(String).slice(-MAX_SEEN) : [],
      windows: saved.windows && typeof saved.windows === 'object' ? saved.windows : {},
      alerted: Array.isArray(saved.alerted) ? saved.alerted.map(Number).slice(-MAX_WINDOWS) : [],
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { initialized: false, seenEvents: [], windows: {}, alerted: [] };
    throw new Error(`Cannot load liquidation summary state at ${STATE_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let state = loadState();
const seenEvents = new Set(state.seenEvents);
const alerted = new Set(state.alerted);

function saveState() {
  const next = {
    version: 1,
    initialized: state.initialized,
    seenEvents: [...seenEvents].slice(-MAX_SEEN),
    windows: Object.fromEntries(Object.entries(state.windows).slice(-MAX_WINDOWS)),
    alerted: [...alerted].slice(-MAX_WINDOWS),
    savedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const temp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next));
  fs.renameSync(temp, STATE_PATH);
  state = next;
  if (seenEvents.size > MAX_SEEN) {
    seenEvents.clear();
    for (const key of next.seenEvents) seenEvents.add(key);
  }
  if (alerted.size > MAX_WINDOWS) {
    alerted.clear();
    for (const key of next.alerted) alerted.add(key);
  }
}

async function fetchRecentTrades() {
  // The public REST docs support POST with a JSON argument object. Use POST rather than
  // repeatedly hitting the GET route that is currently returning HTTP 429.
  const response = await fetch(RECENT_TRADES_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'papertrade-liquidation-summary-monitor',
    },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  });
  const rawBody = await response.text().catch(() => '');
  let body = {};
  try { body = rawBody ? JSON.parse(rawBody) : {}; } catch {}
  const events = body?.data?.events;
  if (!response.ok || body?.ok !== true || !Array.isArray(events)) {
    // Never include the response body for rate limits: Cloudflare often returns a full HTML page.
    const safeMessage = response.status === 429
      ? 'papertrade-ai get_recent_trades HTTP 429 (rate limited; response body suppressed)'
      : `papertrade-ai get_recent_trades HTTP ${response.status}: ${body?.error?.message || body?.message || (rawBody && body && Object.keys(body).length ? 'invalid response' : 'empty or invalid response')}`;
    const error = new Error(safeMessage);
    error.status = response.status;
    error.retryAfter = response.headers.get('retry-after');
    throw error;
  }
  return events;
}

async function send(message) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(12_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) throw new Error(`Telegram HTTP ${response.status}: ${body.description || 'send failed'}`);
}

function eventKey(event) {
  if (event?.seq != null) return `seq:${event.seq}`;
  return [
    String(event?.wallet || event?.address || '').toLowerCase(),
    String(event?.positionId ?? ''),
    kindOf(event),
    String(event?.ts ?? event?.time ?? event?.timestamp ?? ''),
    String(event?.notionalUsd ?? ''),
    String(event?.side ?? ''),
  ].join(':');
}

function ensureBucket(periodStart, instrument) {
  const key = String(periodStart);
  const window = state.windows[key] || { periodStart, byInstrument: {} };
  const bucket = window.byInstrument[instrument] || {
    long: { count: 0, usd: 0 },
    short: { count: 0, usd: 0 },
    unknown: { count: 0, usd: 0 },
    total: { count: 0, usd: 0 },
  };
  window.byInstrument[instrument] = bucket;
  state.windows[key] = window;
  return bucket;
}

function recordLiquidation(event, periodStart, instrument) {
  const rawUsd = Number(event?.notionalUsd);
  if (!Number.isFinite(rawUsd) || rawUsd < 0) {
    console.warn(JSON.stringify({ level: 'warn', event: 'liquidation_missing_notional', seq: event?.seq ?? null, instrument, kind: kindOf(event), rawNotionalUsd: event?.notionalUsd ?? null }));
    return false;
  }
  const side = sideOf(event);
  const bucket = ensureBucket(periodStart, instrument);
  bucket[side].count++;
  bucket[side].usd += rawUsd;
  bucket.total.count++;
  bucket.total.usd += rawUsd;
  return true;
}
function marketLink(instrument, periodStart) {
  // Link to the Polymarket 5-minute market aligned with the Papertrade event window.
  return `https://polymarket.com/event/${instrument.toLowerCase()}-updown-5m-${periodStart}`;
}

function formatAlert(periodStart, window) {
  const start = new Date(periodStart * 1000).toISOString().slice(11, 16);
  const end = new Date((periodStart + PERIOD_SECONDS) * 1000).toISOString().slice(11, 16);
  const lines = [
    `<b>ЛИКВИДАЦИИ PAPERTRADE — 5M</b>`,
    `Период UTC: ${start}–${end}`,
    '',
  ];
  let totalCount = 0;
  let totalUsd = 0;
  for (const instrument of ['BTC', 'ETH']) {
    const b = window.byInstrument?.[instrument];
    if (!b || !b.total.count) continue;
    totalCount += b.total.count;
    totalUsd += b.total.usd;
    lines.push(`<b>${instrument}</b>`);
    lines.push(`LONG: ${b.long.count} ликв. / ${money(b.long.usd)}`);
    lines.push(`SHORT: ${b.short.count} ликв. / ${money(b.short.usd)}`);
    if (b.unknown.count) lines.push(`СТОРОНА НЕ ОПРЕДЕЛЕНА: ${b.unknown.count} / ${money(b.unknown.usd)}`);
    lines.push(`Всего: ${b.total.count} ликв. / ${money(b.total.usd)}`);
    lines.push(`<a href="${marketLink(instrument, periodStart)}">Polymarket ${instrument} 5m</a>`);
    lines.push('');
  }
  lines.push(`<b>ИТОГО: ${totalCount} ликвидаций / ${money(totalUsd)}</b>`);
  return lines.join(String.fromCharCode(10));
}

async function poll() {
  let events = [];
  let fetchError = null;
  try {
    events = await fetchRecentTrades();
  } catch (error) {
      fetchError = error;
  }
  const now = Math.floor(Date.now() / 1000);
  const currentStart = periodStartFor(now);
  const firstRun = !state.initialized;

  for (const event of events) {
    if (!isLiquidation(event)) continue;
    const timestamp = unixSeconds(event?.ts ?? event?.time ?? event?.timestamp ?? event?.closedAt);
    if (!timestamp) continue;
    const periodStart = periodStartFor(timestamp);
    if (periodStart > currentStart || periodStart < currentStart - MAX_WINDOWS * PERIOD_SECONDS) continue;
    // On first startup, seed only the currently active window to avoid sending a stale historical alert.
    if (firstRun && periodStart < currentStart) continue;
    const key = eventKey(event);
    if (seenEvents.has(key)) continue;
    const instrument = instrumentOf(event);
    if (!instrument) {
      console.warn(JSON.stringify({ level: 'warn', event: 'liquidation_instrument_unrecognized', seq: event?.seq ?? null, instrument: event?.instrument ?? null }));
      seenEvents.add(key);
      continue;
    }
    if (recordLiquidation(event, periodStart, instrument)) seenEvents.add(key);
  }

  // Send a single summary for each completed five-minute period, only if liquidations occurred.
  const completedStart = currentStart - PERIOD_SECONDS;
  const completed = state.windows[String(completedStart)];
  if (completed && Number(completed.periodStart) === completedStart && !alerted.has(completedStart) && completed.byInstrument) {
    const hasLiquidations = ['BTC', 'ETH'].some(symbol => Number(completed.byInstrument?.[symbol]?.total?.count || 0) > 0);
    if (hasLiquidations) {
      await send(formatAlert(completedStart, completed));
      console.log(JSON.stringify({
        level: 'info', event: 'liquidation_summary_alert_sent', version: VERSION,
        periodStart: new Date(completedStart * 1000).toISOString(),
        periodEnd: new Date((completedStart + PERIOD_SECONDS) * 1000).toISOString(),
        byInstrument: completed.byInstrument,
      }));
    } else {
      console.log(JSON.stringify({ level: 'info', event: 'liquidation_summary_period_empty', version: VERSION, periodStart: new Date(completedStart * 1000).toISOString() }));
    }
    alerted.add(completedStart);
  }

  state.initialized = true;
  for (const [key, window] of Object.entries(state.windows)) {
    if (Number(window.periodStart) < now - MAX_WINDOWS * PERIOD_SECONDS) delete state.windows[key];
  }
  for (const period of [...alerted]) {
    if (period < currentStart - MAX_WINDOWS * PERIOD_SECONDS) alerted.delete(period);
  }
  saveState();

  const active = state.windows[String(currentStart)];
  console.log(JSON.stringify({
    level: 'info', event: 'liquidation_summary_snapshot', version: VERSION,
    source: 'papertrade-ai get_recent_trades tool', endpoint: RECENT_TRADES_URL, eventCount: events.length, liquidationEvents: events.filter(isLiquidation).length,
    pollMs: POLL_MS, activePeriod: new Date(currentStart * 1000).toISOString(),
    byInstrument: Object.fromEntries(['BTC', 'ETH'].map(symbol => [symbol, active?.byInstrument?.[symbol] || {
      long: { count: 0, usd: 0 }, short: { count: 0, usd: 0 }, unknown: { count: 0, usd: 0 }, total: { count: 0, usd: 0 },
    }])),
  }));
  if (fetchError) throw fetchError;
}

console.log(JSON.stringify({
  level: 'info', event: 'liquidation_summary_monitor_started', version: VERSION,
  sourceProject: 'https://github.com/nirholas/papertrade-ai', endpoint: RECENT_TRADES_URL, pollMs: POLL_MS, periodSeconds: PERIOD_SECONDS,
  statePath: STATE_PATH, eventFilter: 'kind=liquidation', aggregation: 'event-time 5-minute windows, LONG/SHORT count and notionalUsd sum',
  alerts: 'one Telegram summary after each completed 5-minute period with at least one liquidation',
}));

let stopping = false;
let consecutiveRateLimits = 0;
async function loop() {
  while (!stopping) {
    const started = Date.now();
    let delayMs = POLL_MS;
    try {
      await poll();
      consecutiveRateLimits = 0;
      delayMs = Math.max(0, POLL_MS - (Date.now() - started));
    } catch (error) {
      const isRateLimited = Number(error?.status) === 429 || /HTTP 429\b/.test(error instanceof Error ? error.message : String(error));
      if (isRateLimited) {
        consecutiveRateLimits++;
        const retryAfterValue = error?.retryAfter;
        const retryAfterSeconds = retryAfterValue && !Number.isFinite(Number(retryAfterValue))
          ? Math.max(0, (Date.parse(retryAfterValue) - Date.now()) / 1000)
          : Number(retryAfterValue);
        const exponentialBackoff = Math.min(MAX_RATE_LIMIT_BACKOFF_MS, RATE_LIMIT_BACKOFF_MS * (2 ** Math.min(consecutiveRateLimits - 1, 3)));
        delayMs = Math.max(
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 0,
          exponentialBackoff,
        );
        console.warn(JSON.stringify({
          level: 'warn', event: 'liquidation_summary_rate_limited', status: 429,
          consecutiveRateLimits, retryInMs: delayMs,
          message: 'Papertrade AI tool endpoint returned HTTP 429; polling reduced to 60s and retries capped at 5m.',
        }));
      } else {
        const message = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({
          level: 'error', event: 'liquidation_summary_poll_failed',
          message: message.slice(0, 300),
        }));
      }
    }
    await sleep(delayMs);
  }
}
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
loop();
