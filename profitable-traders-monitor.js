import fs from 'node:fs';
import path from 'node:path';

const API_BASE = (process.env.PAPERTRADE_API_BASE_URL || 'https://papertrade-ai.ninabrekkerese.workers.dev/api/v1/tools').replace(/\/+$/, '');
const POLL_MS = 1_000;
const STATE_PATH = process.env.PAPERTRADE_CLOSED_PNL_STATE_PATH || '/data/papertrade-closed-pnl-state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const PERIOD_SECONDS = 300;
const MAX_SEEN = 10_000;
const VERSION = 'open-vs-closed-notional-min-0.15-percent-5m-link-v11';

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
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok !== true) {
    throw new Error(`Papertrade ${name} HTTP ${response.status}: ${body?.error?.message || 'request failed'}`);
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
  return [
    `<b>${esc(instrument)} — OPEN больше CLOSED на ${Number(bucket.closedUsd) > 0 ? (((Number(bucket.openUsd) - Number(bucket.closedUsd)) / Number(bucket.closedUsd)) * 100).toFixed(2) : '∞'}%</b>`,
    `OPEN: ${esc(money(bucket.openUsd))} (${bucket.openCount} сделок)`,
    `CLOSED: ${esc(money(bucket.closedUsd))} (${bucket.closedCount} сделок)`,
    '',
    `<a href="${marketUrl}">${esc(instrument)} маркет</a>`,
  ].join('\n');
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

  // Evaluate BTC and ETH together. Send an alert only when exactly one instrument qualifies.
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
    const eligible = evaluated.filter(({ bucket }) => {
      const openUsd = Number(bucket.openUsd);
      const closedUsd = Number(bucket.closedUsd);
      if (!(openUsd > closedUsd)) return false;
      const excessPercent = closedUsd > 0 ? ((openUsd - closedUsd) / closedUsd) * 100 : Infinity;
      return excessPercent >= 0.15;
    });

    for (const { instrument, bucket } of evaluated) {
      if (Number(bucket.openUsd) <= Number(bucket.closedUsd)) {
        console.log(JSON.stringify({
          level: 'info', event: 'papertrade_open_closed_window_skipped', version: VERSION,
          instrument, periodStart: new Date(Number(window.periodStart) * 1000).toISOString(),
          openUsd: Number(bucket.openUsd.toFixed(2)), closedUsd: Number(bucket.closedUsd.toFixed(2)),
          reason: 'OPEN_NOT_GREATER_THAN_CLOSED_OR_BELOW_0_15_PERCENT',
        }));
        alertedWindows.add(`${window.periodStart}:${instrument}`);
      }
    }

    if (eligible.length === 1) {
      const { instrument, bucket } = eligible[0];
      await send(alertText(window, instrument, bucket));
      alertedWindows.add(`${window.periodStart}:${instrument}`);
      console.log(JSON.stringify({
        level: 'info', event: 'papertrade_open_closed_alert_sent', version: VERSION,
        instrument, periodStart: new Date(Number(window.periodStart) * 1000).toISOString(),
        openUsd: Number(bucket.openUsd.toFixed(2)), closedUsd: Number(bucket.closedUsd.toFixed(2)),
      }));
    } else if (eligible.length > 1) {
      for (const { instrument, bucket } of eligible) {
        alertedWindows.add(`${window.periodStart}:${instrument}`);
        console.log(JSON.stringify({
          level: 'info', event: 'papertrade_open_closed_window_skipped', version: VERSION,
          instrument, periodStart: new Date(Number(window.periodStart) * 1000).toISOString(),
          openUsd: Number(bucket.openUsd.toFixed(2)), closedUsd: Number(bucket.closedUsd.toFixed(2)),
          reason: 'MULTIPLE_INSTRUMENTS_QUALIFIED_ONLY_SINGLE_ALERT_ALLOWED',
        }));
      }
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
  scope: 'BTC and ETH OPEN notionalUsd compared with CLOSED notionalUsd per completed 5-minute window; alert only if exactly one instrument qualifies; no streaks',
}));

let stopping = false;
async function loop() {
  while (!stopping) {
    const started = Date.now();
    try { await poll(); }
    catch (error) {
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
    await sleep(Math.max(0, POLL_MS - (Date.now() - started)));
  }
}
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
loop();
