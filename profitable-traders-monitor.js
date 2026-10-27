import fs from 'node:fs';
import path from 'node:path';

const API_BASE = (process.env.PAPERTRADE_API_BASE_URL || 'https://papertrade-ai.ninabrekkerese.workers.dev/api/v1/tools').replace(/\/+$/, '');
const POLL_MS = 10_000;
const RATE_LIMIT_BACKOFF_MS = 300_000;
const STATE_PATH = process.env.PAPERTRADE_CLOSED_PNL_STATE_PATH || '/data/papertrade-closed-pnl-state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const PERIOD_SECONDS = 300;
const MAX_SEEN = 10_000;
const VERSION = 'closed-greater-than-open-arrow-82-percent-loop-crash-fix-v20';

if (!BOT_TOKEN || !CHAT_ID) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const esc = value => String(value ?? '—').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const money = value => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n < 0 ? '-$' : '$'}${Math.abs(n).toFixed(2)}`;
};
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
const periodStartFor = seconds => Math.floor(seconds / PERIOD_SECONDS) * PERIOD_SECONDS;
const instrumentOf = event => {
  const value = String(event?.instrument || event?.symbol || event?.market || '').toUpperCase();
  if (value.includes('BTC') || value.includes('BITCOIN')) return 'BTC';
  if (value.includes('ETH') || value.includes('ETHEREUM')) return 'ETH';
  return 'OTHER';
};
const eventKind = event => String(event?.kind || event?.type || event?.action || '').toLowerCase();
const isOpen = event => ['open', 'opened', 'position_opened', 'open_position'].includes(eventKind(event));
const isClosed = event => ['close', 'closed', 'position_closed', 'close_position'].includes(eventKind(event));

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (saved.version !== 1) throw new Error('unsupported state version');
    return {
      initialized: saved.initialized === true,
      seenEvents: Array.isArray(saved.seenEvents) ? saved.seenEvents.map(String).slice(-MAX_SEEN) : [],
      windows: saved.windows && typeof saved.windows === 'object' ? saved.windows : {},
      alertedWindows: Array.isArray(saved.alertedWindows) ? saved.alertedWindows.map(String) : [],
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { initialized: false, seenEvents: [], windows: {}, alertedWindows: [] };
    throw new Error(`Cannot load OPEN/CLOSED state at ${STATE_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let state = loadState();
const seenEvents = new Set(state.seenEvents);
const alertedWindows = new Set(state.alertedWindows);

function saveState() {
  const next = {
    version: 1,
    initialized: state.initialized,
    seenEvents: [...seenEvents].slice(-MAX_SEEN),
    windows: state.windows,
    alertedWindows: [...alertedWindows].slice(-5000),
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
}

async function callTool(name, args = {}) {
  const response = await fetch(`${API_BASE}/${name}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(15_000),
  });
  const rawBody = await response.text().catch(() => '');
  let body = {};
  try { body = rawBody ? JSON.parse(rawBody) : {}; } catch {}
  if (!response.ok || body?.ok !== true) {
    const retryAfter = response.headers.get('retry-after');
    const details = body?.error?.message || body?.message || rawBody.slice(0, 300) || 'empty response';
    const error = new Error(`Papertrade ${name} HTTP ${response.status}: ${details}`);
    error.status = response.status;
    error.retryAfter = retryAfter;
    throw error;
  }
  return body.data ?? {};
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
    String(event?.wallet || '').toLowerCase(),
    String(event?.positionId ?? ''),
    String(event?.intentId ?? ''),
    eventKind(event),
    String(event?.ts ?? event?.time ?? event?.timestamp ?? ''),
    String(event?.notionalUsd ?? ''),
  ].join(':');
}

function addEvent(event, periodStart, instrument, kind) {
  const notional = Number(event?.notionalUsd);
  if (!Number.isFinite(notional) || notional < 0) return false;
  const key = String(periodStart);
  const window = state.windows[key] || {
    periodStart,
    openUsd: 0,
    closedUsd: 0,
    openCount: 0,
    closedCount: 0,
    byInstrument: {},
  };
  const bucket = window.byInstrument[instrument] || { openUsd: 0, closedUsd: 0, openCount: 0, closedCount: 0 };
  if (kind === 'open') {
    window.openUsd += notional;
    window.openCount += 1;
    bucket.openUsd += notional;
    bucket.openCount += 1;
  } else {
    window.closedUsd += notional;
    window.closedCount += 1;
    bucket.closedUsd += notional;
    bucket.closedCount += 1;
  }
  window.byInstrument[instrument] = bucket;
  state.windows[key] = window;
  return true;
}

function alertText(window, instrument, bucket) {
  const marketStart = Number(window.periodStart) + PERIOD_SECONDS;
  const marketUrl = `https://polymarket.com/event/${instrument.toLowerCase()}-updown-5m-${marketStart}`;
  const excessPercent = Number(bucket.openUsd) > 0
    ? ((Number(bucket.closedUsd) - Number(bucket.openUsd)) / Number(bucket.openUsd)) * 100
    : Infinity;
  const arrow = excessPercent > 82 ? '⬆️' : '⬇️';
  return [
    `<b>${arrow} ${esc(instrument)} — CLOSED больше OPEN на ${Number.isFinite(excessPercent) ? excessPercent.toFixed(2) : '∞'}%</b>`,
    `OPEN: ${esc(money(bucket.openUsd))} (${bucket.openCount} сделок)`,
    `CLOSED: ${esc(money(bucket.closedUsd))} (${bucket.closedCount} сделок)`,
    '',
    `<a href="${marketUrl}">${esc(instrument)} маркет</a>`,
  ].join(String.fromCharCode(10));
}

async function poll() {
  const firstRun = !state.initialized;
  const result = await callTool('get_recent_trades');
  const now = Math.floor(Date.now() / 1000);
  const currentPeriodStart = periodStartFor(now);
  const events = Array.isArray(result.events) ? result.events : [];

  for (const event of events) {
    const kind = isOpen(event) ? 'open' : isClosed(event) ? 'closed' : null;
    if (!kind) continue;
    const timestamp = unixSeconds(event?.ts ?? event?.time ?? event?.timestamp ?? event?.closedAt);
    if (!timestamp) continue;
    const periodStart = periodStartFor(timestamp);
    // On first start, establish a baseline only from the currently active window.
    if (firstRun && periodStart < currentPeriodStart) continue;
    const key = eventKey(event);
    if (seenEvents.has(key)) continue;
    if (addEvent(event, periodStart, instrumentOf(event), kind)) seenEvents.add(key);
  }

  // Evaluate BTC and ETH independently. Both may alert in the same completed 5-minute window.
  const completed = Object.values(state.windows)
    .filter(window =>
      Number(window.periodStart) === currentPeriodStart - PERIOD_SECONDS &&
      window.byInstrument && typeof window.byInstrument === 'object'
    )
    .sort((a, b) => Number(a.periodStart) - Number(b.periodStart));

  for (const window of completed) {
    const evaluated = ['BTC', 'ETH']
      .map(instrument => ({ instrument, bucket: window.byInstrument[instrument] }))
      .filter(item => item.bucket && !alertedWindows.has(`${window.periodStart}:${item.instrument}`));
    const eligible = evaluated.filter(({ bucket }) => Number(bucket.closedUsd) > Number(bucket.openUsd));

    for (const { instrument, bucket } of evaluated) {
      if (Number(bucket.closedUsd) <= Number(bucket.openUsd)) {
        console.log(JSON.stringify({
          level: 'info', event: 'papertrade_open_closed_window_skipped', version: VERSION,
          instrument, periodStart: new Date(Number(window.periodStart) * 1000).toISOString(),
          openUsd: Number(bucket.openUsd.toFixed(2)), closedUsd: Number(bucket.closedUsd.toFixed(2)),
          reason: 'CLOSED_NOT_GREATER_THAN_OPEN',
        }));
        alertedWindows.add(`${window.periodStart}:${instrument}`);
      }
    }

    for (const { instrument, bucket } of eligible) {
      await send(alertText(window, instrument, bucket));
      alertedWindows.add(`${window.periodStart}:${instrument}`);
      console.log(JSON.stringify({
        level: 'info', event: 'papertrade_open_closed_alert_sent', version: VERSION,
        instrument, periodStart: new Date(Number(window.periodStart) * 1000).toISOString(),
        openUsd: Number(bucket.openUsd.toFixed(2)), closedUsd: Number(bucket.closedUsd.toFixed(2)),
      }));
    }
    saveState();
  }

  const cutoff = now - 48 * 60 * 60;
  for (const [key, window] of Object.entries(state.windows)) {
    if (Number(window.periodStart) < cutoff) delete state.windows[key];
  }
  state.initialized = true;
  saveState();
}

console.log(JSON.stringify({
  level: 'info', event: 'papertrade_open_closed_monitor_started', version: VERSION,
  apiBase: API_BASE, pollMs: POLL_MS, periodSeconds: PERIOD_SECONDS, statePath: STATE_PATH,
  scope: 'BTC and ETH CLOSED notionalUsd compared with OPEN notionalUsd independently per completed 5-minute window; alert whenever CLOSED > OPEN with no percentage threshold; both may alert in the same window; no streaks',
}));

let stopping = false;
async function loop() {
  while (!stopping) {
    const started = Date.now();
    let delayMs = POLL_MS;
    try {
      await poll();
    } catch (error) {
      const isRateLimited = Number(error?.status) === 429 || Number(error?.statusCode) === 429 || /HTTP 429\b/.test(error instanceof Error ? error.message : String(error));
      if (isRateLimited) {
        const retryAfterSeconds = Number(error?.retryAfter);
        delayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1000
          : RATE_LIMIT_BACKOFF_MS;
      } else {
        delayMs = Math.max(0, POLL_MS - (Date.now() - started));
      }
      const cause = error && typeof error === 'object' ? error.cause : null;
      console.error(JSON.stringify({
        level: 'error', event: 'papertrade_open_closed_poll_failed',
        message: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : typeof error,
        errorCode: error && typeof error === 'object' ? (error.code ?? error.errno ?? null) : null,
        causeName: cause && typeof cause === 'object' ? (cause.name ?? null) : null,
        causeMessage: cause instanceof Error ? cause.message : (cause == null ? null : String(cause)),
        causeCode: cause && typeof cause === 'object' ? (cause.code ?? cause.errno ?? null) : null,
        stack: error instanceof Error ? error.stack : null,
      }));
    }
    await sleep(delayMs);
  }
}
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
loop();
