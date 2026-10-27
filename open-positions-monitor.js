import fs from 'node:fs';
import path from 'node:path';

const API_BASE = (process.env.PAPERTRADE_API_BASE_URL || 'https://papertrade-ai.ninabrekkerese.workers.dev/api/v1/tools').replace(/\/+$/, '');
const POLL_MS = 1000;
const STATE_PATH = process.env.PAPERTRADE_OPEN_POSITIONS_STATE_PATH || '/data/papertrade-open-positions-state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const PERIOD_SECONDS = 300;
const MAX_SEEN = 10000;
const VERSION = 'papertrade-btc-eth-open-positions-5m-v1';

if (!BOT_TOKEN || !CHAT_ID) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const money = value => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0.00';
  return (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
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
  return null;
};
const sideOf = event => {
  const side = String(event?.side || event?.direction || '').toLowerCase();
  if (side === 'long' || side === 'buy') return 'long';
  if (side === 'short' || side === 'sell') return 'short';
  return null;
};
const isOpen = event => ['open', 'opened', 'position_opened', 'open_position'].includes(String(event?.kind || event?.type || event?.action || '').toLowerCase());

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
    throw new Error('Cannot load open-positions state at ' + STATE_PATH + ': ' + (error instanceof Error ? error.message : String(error)));
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
  const temp = STATE_PATH + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(next));
  fs.renameSync(temp, STATE_PATH);
  state = next;
  if (seenEvents.size > MAX_SEEN) {
    seenEvents.clear();
    for (const key of next.seenEvents) seenEvents.add(key);
  }
}

async function callTool(name, args = {}) {
  const response = await fetch(API_BASE + '/' + name, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok !== true) {
    throw new Error('Papertrade ' + name + ' HTTP ' + response.status + ': ' + (body?.error?.message || 'request failed'));
  }
  return body.data ?? {};
}

async function send(message) {
  const response = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(12000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) throw new Error('Telegram HTTP ' + response.status + ': ' + (body.description || 'send failed'));
}

function eventKey(event) {
  if (event?.seq != null) return 'seq:' + event.seq;
  return [
    String(event?.wallet || '').toLowerCase(),
    String(event?.positionId ?? ''),
    String(event?.intentId ?? ''),
    String(event?.kind ?? event?.type ?? ''),
    String(event?.ts ?? event?.time ?? ''),
    String(event?.notionalUsd ?? ''),
  ].join(':');
}

function createWindow(periodStart, instrument) {
  return { periodStart, instrument, longCount: 0, longUsd: 0, shortCount: 0, shortUsd: 0 };
}

function addOpen(event, periodStart, instrument, side, amount) {
  const key = periodStart + ':' + instrument;
  const window = state.windows[key] || createWindow(periodStart, instrument);
  if (side === 'long') {
    window.longCount += 1;
    window.longUsd += amount;
  } else {
    window.shortCount += 1;
    window.shortUsd += amount;
  }
  state.windows[key] = window;
}

function alertText(window) {
  const start = Number(window.periodStart);
  const slug = window.instrument.toLowerCase() + '-updown-5m-';
  const marketUrl = 'https://polymarket.com/event/' + slug + (start + PERIOD_SECONDS);
  return [
    '<b>' + window.instrument + ' OPEN · 5M</b>',
    'LONG: ' + window.longCount + ' позиций — ' + money(window.longUsd),
    'SHORT: ' + window.shortCount + ' позиций — ' + money(window.shortUsd),
    'Всего открытий: ' + (window.longCount + window.shortCount),
    '',
    '<a href="' + marketUrl + '">Маркет 5m</a>',
  ].join('\n');
}

async function poll() {
  const firstRun = !state.initialized;
  let now = Math.floor(Date.now() / 1000);
  let currentPeriodStart = periodStartFor(now);
  const result = await callTool('get_recent_trades');
  now = Math.floor(Date.now() / 1000);
  currentPeriodStart = periodStartFor(now);
  const events = Array.isArray(result.events) ? result.events : [];
  let newOpens = 0;
  let ignored = 0;

  for (const event of events) {
    if (!isOpen(event)) continue;
    const instrument = instrumentOf(event);
    const side = sideOf(event);
    const timestamp = unixSeconds(event.ts ?? event.time ?? event.timestamp);
    const amount = Number(event.notionalUsd);
    if (!instrument || !side || !timestamp || !Number.isFinite(amount) || amount < 0) {
      ignored++;
      continue;
    }
    const periodStart = periodStartFor(timestamp);
    if (firstRun && periodStart !== currentPeriodStart) continue;
    if (periodStart < currentPeriodStart - PERIOD_SECONDS || periodStart > currentPeriodStart) continue;
    const key = eventKey(event);
    if (seenEvents.has(key)) continue;
    addOpen(event, periodStart, instrument, side, amount);
    seenEvents.add(key);
    newOpens++;
  }

  for (const instrument of ['BTC', 'ETH']) {
    const key = currentPeriodStart + ':' + instrument;
    if (!state.windows[key]) state.windows[key] = createWindow(currentPeriodStart, instrument);
  }

  const justCompletedStart = currentPeriodStart - PERIOD_SECONDS;
  if (firstRun) {
    alertedWindows.add(justCompletedStart + ':BTC');
    alertedWindows.add(justCompletedStart + ':ETH');
  }

  if (now - currentPeriodStart <= 10) {
    for (const instrument of ['BTC', 'ETH']) {
      const key = justCompletedStart + ':' + instrument;
      if (alertedWindows.has(key)) continue;
      const window = state.windows[key] || createWindow(justCompletedStart, instrument);
      await send(alertText(window));
      alertedWindows.add(key);
      console.log(JSON.stringify({
        level: 'info', event: 'papertrade_open_positions_alert_sent',
        version: VERSION, instrument, periodStart: new Date(justCompletedStart * 1000).toISOString(),
        longCount: window.longCount, longUsd: Number(window.longUsd.toFixed(2)),
        shortCount: window.shortCount, shortUsd: Number(window.shortUsd.toFixed(2)),
        newOpensSeenThisPoll: newOpens, ignoredEvents: ignored,
      }));
    }
  } else {
    alertedWindows.add(justCompletedStart + ':BTC');
    alertedWindows.add(justCompletedStart + ':ETH');
  }

  const cutoff = now - 48 * 60 * 60;
  for (const [key, window] of Object.entries(state.windows)) {
    if (Number(window.periodStart) < cutoff) delete state.windows[key];
  }
  state.initialized = true;
  saveState();
}

console.log(JSON.stringify({
  level: 'info', event: 'papertrade_open_positions_monitor_started',
  version: VERSION, apiBase: API_BASE, pollMs: POLL_MS, periodSeconds: PERIOD_SECONDS,
  statePath: STATE_PATH, thresholdsEnabled: false,
  scope: 'Independent Papertrade BTC/ETH open events grouped by 5-minute open-time window; counts and notional USD by long/short',
}));

let stopping = false;
async function loop() {
  while (!stopping) {
    const started = Date.now();
    try { await poll(); }
    catch (error) {
      const cause = error && typeof error === 'object' ? error.cause : null;
      console.error(JSON.stringify({
        level: 'error', event: 'papertrade_open_positions_poll_failed',
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
