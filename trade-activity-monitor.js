import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_RECENT_TRADES_URL = 'https://exchange.papertrade.xyz/query/protocol/trades/recent';
const CONFIGURED_RECENT_TRADES_URL = (process.env.PAPERTRADE_RECENT_TRADES_URL || '').trim();
const RECENT_TRADES_URL = !CONFIGURED_RECENT_TRADES_URL || CONFIGURED_RECENT_TRADES_URL.includes('papertrade-ai.ninabrekkerese.workers.dev')
  ? DEFAULT_RECENT_TRADES_URL
  : CONFIGURED_RECENT_TRADES_URL;
const POLL_MS = Math.max(3_000, Number(process.env.TRADE_ACTIVITY_POLL_MS || 10_000));
const RATE_LIMIT_BACKOFF_MS = 300_000;
const PERIOD_SECONDS = 300;
const HISTORY_WINDOWS = 6;
const STATE_PATH = process.env.TRADE_ACTIVITY_STATE_PATH || '/data/trade-activity-state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const MAX_SEEN = 15_000;
const MAX_WINDOWS = 96;
const MIN_FREQUENCY_TRADES = Math.max(3, Number(process.env.TRADE_ACTIVITY_MIN_FREQUENCY_TRADES || 10));
const FREQUENCY_MULTIPLIER = Math.max(1.5, Number(process.env.TRADE_ACTIVITY_FREQUENCY_MULTIPLIER || 2.5));
const MIN_SEQUENCE_TRANSITIONS = Math.max(2, Number(process.env.TRADE_ACTIVITY_MIN_SEQUENCE_TRANSITIONS || 3));
const CLOSE_VOLUME_MULTIPLIER = Math.max(1.5, Number(process.env.TRADE_ACTIVITY_CLOSE_VOLUME_MULTIPLIER || 2.5));
const MIN_CLOSE_VOLUME_USD = Math.max(1, Number(process.env.TRADE_ACTIVITY_MIN_CLOSE_VOLUME_USD || 10_000));
const VERSION = 'trade-activity-frequency-sequences-close-volume-v1';

if (!BOT_TOKEN || !CHAT_ID) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const esc = value => String(value ?? '—').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const money = value => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n < 0 ? '-$' : '$'}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
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
      alerted: Array.isArray(saved.alerted) ? saved.alerted.map(String).slice(-5000) : [],
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { initialized: false, seenEvents: [], windows: {}, alerted: [] };
    throw new Error(`Cannot load trade activity state at ${STATE_PATH}: ${error instanceof Error ? error.message : String(error)}`);
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
    alerted: [...alerted].slice(-5000),
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
  if (alerted.size > 5000) {
    alerted.clear();
    for (const key of next.alerted) alerted.add(key);
  }
}

async function fetchRecentTrades() {
  const response = await fetch(RECENT_TRADES_URL, {
    method: 'GET',
    headers: { accept: 'application/json', 'user-agent': 'papertrade-trade-activity-monitor' },
    signal: AbortSignal.timeout(15_000),
  });
  const rawBody = await response.text().catch(() => '');
  let body = {};
  try { body = rawBody ? JSON.parse(rawBody) : {}; } catch {}
  if (!response.ok || body?.ok !== true || !Array.isArray(body?.events)) {
    const error = new Error(`Papertrade recent trades HTTP ${response.status}: ${body?.error?.message || body?.message || rawBody.slice(0, 250) || 'empty or invalid response'}`);
    error.status = response.status;
    error.retryAfter = response.headers.get('retry-after');
    throw error;
  }
  return body.events;
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
    String(event?.intentId ?? ''),
    eventKind(event),
    String(event?.ts ?? event?.time ?? event?.timestamp ?? event?.closedAt ?? ''),
    String(event?.notionalUsd ?? ''),
  ].join(':');
}

function ensureWindow(periodStart, instrument) {
  const key = String(periodStart);
  const window = state.windows[key] || { periodStart, byInstrument: {} };
  const bucket = window.byInstrument[instrument] || {
    count: 0, openCount: 0, closeCount: 0, openUsd: 0, closeUsd: 0,
    events: [], walletSequences: {},
  };
  window.byInstrument[instrument] = bucket;
  state.windows[key] = window;
  return bucket;
}

function recordEvent(event, periodStart, instrument, kind, timestamp) {
  const notional = Number(event?.notionalUsd);
  if (!Number.isFinite(notional) || notional < 0) return false;
  const bucket = ensureWindow(periodStart, instrument);
  bucket.count++;
  if (kind === 'open') {
    bucket.openCount++;
    bucket.openUsd += notional;
  } else {
    bucket.closeCount++;
    bucket.closeUsd += notional;
  }
  const wallet = String(event?.wallet || event?.address || 'unknown').toLowerCase();
  const entry = {
    ts: timestamp, kind, wallet,
    notionalUsd: notional,
    seq: event?.seq == null ? null : String(event.seq),
  };
  bucket.events.push(entry);
  if (!bucket.walletSequences[wallet]) bucket.walletSequences[wallet] = [];
  bucket.walletSequences[wallet].push({ ts: timestamp, kind });
  return true;
}

function baselineFor(instrument, currentStart) {
  const values = [];
  for (let i = 1; i <= HISTORY_WINDOWS; i++) {
    const window = state.windows[String(currentStart - i * PERIOD_SECONDS)];
    const bucket = window?.byInstrument?.[instrument];
    if (bucket) values.push(bucket);
  }
  const mean = key => values.length
    ? values.reduce((sum, item) => sum + Number(item[key] || 0), 0) / values.length
    : 0;
  return {
    samples: values.length,
    avgTrades: mean('count'),
    avgCloseUsd: mean('closeUsd'),
    avgCloses: mean('closeCount'),
  };
}

function marketLink(instrument, periodStart) {
  const marketStart = Number(periodStart) + PERIOD_SECONDS;
  return `https://polymarket.com/event/${instrument.toLowerCase()}-updown-5m-${marketStart}`;
}

function formatAlert(title, instrument, periodStart, lines) {
  return [
    `<b>${esc(title)} — ${esc(instrument)} / 5M</b>`,
    ...lines.map(esc),
    '',
    `<a href="${marketLink(instrument, periodStart)}">Начинающийся маркет</a>`,
  ].join(String.fromCharCode(10));
}

async function evaluateWindow(window, instrument) {
  const bucket = window.byInstrument?.[instrument];
  if (!bucket) return;
  const periodStart = Number(window.periodStart);
  const baseline = baselineFor(instrument, periodStart);
  const baseKey = `${periodStart}:${instrument}`;

  // Signal 1: unusually high number of open/close events in the 5-minute window.
  const frequencyThreshold = Math.max(MIN_FREQUENCY_TRADES, baseline.avgTrades * FREQUENCY_MULTIPLIER);
  const frequencyKey = `${baseKey}:frequency`;
  if (!alerted.has(frequencyKey) && bucket.count >= frequencyThreshold) {
    await send(formatAlert('РЕЗКИЙ РОСТ ЧАСТОТЫ СДЕЛОК', instrument, periodStart, [
      `Сделок за 5 минут: ${bucket.count}`,
      `OPEN: ${bucket.openCount} | CLOSED: ${bucket.closeCount}`,
      `Среднее за предыдущие окна: ${baseline.samples ? baseline.avgTrades.toFixed(1) : 'нет базы'}`,
      `Порог срабатывания: ${Math.ceil(frequencyThreshold)} сделок`,
    ]));
    alerted.add(frequencyKey);
    console.log(JSON.stringify({ level: 'info', event: 'trade_activity_frequency_alert_sent', version: VERSION, instrument, periodStart, count: bucket.count, baseline: baseline.avgTrades, threshold: frequencyThreshold }));
  } else if (!alerted.has(frequencyKey)) {
    alerted.add(frequencyKey);
  }

  // Signal 2: report repeated OPEN/CLOSED transitions for individual wallets in event-time order.
  const transitions = [];
  for (const [wallet, events] of Object.entries(bucket.walletSequences || {})) {
    const sorted = [...events].sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].kind !== sorted[i - 1].kind) {
        transitions.push({ wallet, from: sorted[i - 1].kind, to: sorted[i].kind, ts: sorted[i].ts });
      }
    }
  }
  const sequenceKey = `${baseKey}:sequence`;
  if (!alerted.has(sequenceKey) && transitions.length >= MIN_SEQUENCE_TRANSITIONS) {
    const openClose = transitions.filter(x => x.from === 'open' && x.to === 'closed').length;
    const closeOpen = transitions.filter(x => x.from === 'closed' && x.to === 'open').length;
    const uniqueWallets = new Set(transitions.map(x => x.wallet)).size;
    await send(formatAlert('ПОСЛЕДОВАТЕЛЬНОСТЬ OPEN/CLOSED', instrument, periodStart, [
      `Переходов OPEN ↔ CLOSED: ${transitions.length}`,
      `OPEN → CLOSED: ${openClose} | CLOSED → OPEN: ${closeOpen}`,
      `Трейдеров с переходами: ${uniqueWallets}`,
      `OPEN: ${bucket.openCount} | CLOSED: ${bucket.closeCount}`,
    ]));
    alerted.add(sequenceKey);
    console.log(JSON.stringify({ level: 'info', event: 'trade_activity_sequence_alert_sent', version: VERSION, instrument, periodStart, transitions: transitions.length, openClose, closeOpen, uniqueWallets }));
  } else if (!alerted.has(sequenceKey)) {
    alerted.add(sequenceKey);
  }

  // Signal 3: a sudden increase in close notional relative to recent completed windows.
  const closeThreshold = Math.max(MIN_CLOSE_VOLUME_USD, baseline.avgCloseUsd * CLOSE_VOLUME_MULTIPLIER);
  const closeKey = `${baseKey}:close-volume`;
  if (!alerted.has(closeKey) && bucket.closeUsd >= closeThreshold && bucket.closeCount > 0) {
    await send(formatAlert('РЕЗКИЙ РОСТ ОБЪЁМА ЗАКРЫТИЙ', instrument, periodStart, [
      `Объём CLOSED: ${money(bucket.closeUsd)}`,
      `Количество закрытий: ${bucket.closeCount}`,
      `Средний объём закрытий за предыдущие окна: ${baseline.samples ? money(baseline.avgCloseUsd) : 'нет базы'}`,
      `Порог срабатывания: ${money(closeThreshold)}`,
    ]));
    alerted.add(closeKey);
    console.log(JSON.stringify({ level: 'info', event: 'trade_activity_close_volume_alert_sent', version: VERSION, instrument, periodStart, closeUsd: Number(bucket.closeUsd.toFixed(2)), baseline: baseline.avgCloseUsd, threshold: closeThreshold }));
  } else if (!alerted.has(closeKey)) {
    alerted.add(closeKey);
  }
}

async function poll() {
  const events = await fetchRecentTrades();
  const now = Math.floor(Date.now() / 1000);
  const currentStart = periodStartFor(now);
  const firstRun = !state.initialized;

  for (const event of events) {
    const kind = isOpen(event) ? 'open' : isClosed(event) ? 'closed' : null;
    if (!kind) continue;
    const timestamp = unixSeconds(event?.ts ?? event?.time ?? event?.timestamp ?? event?.closedAt);
    if (!timestamp) continue;
    const periodStart = periodStartFor(timestamp);
    if (periodStart > currentStart || periodStart < currentStart - MAX_WINDOWS * PERIOD_SECONDS) continue;
    if (firstRun && periodStart < currentStart) continue;
    const key = eventKey(event);
    if (seenEvents.has(key)) continue;
    if (recordEvent(event, periodStart, instrumentOf(event), kind, timestamp)) seenEvents.add(key);
  }

  // Evaluate completed 5-minute windows once. Baselines use up to six earlier windows.
  const completedStart = currentStart - PERIOD_SECONDS;
  const completed = state.windows[String(completedStart)];
  if (completed && completed.periodStart === completedStart) {
    for (const instrument of ['BTC', 'ETH']) await evaluateWindow(completed, instrument);
  }

  state.initialized = true;
  for (const [key, window] of Object.entries(state.windows)) {
    if (Number(window.periodStart) < now - MAX_WINDOWS * PERIOD_SECONDS) delete state.windows[key];
  }
  for (const key of [...alerted]) {
    const period = Number(key.split(':')[0]);
    if (Number.isFinite(period) && period < currentStart - MAX_WINDOWS * PERIOD_SECONDS) alerted.delete(key);
  }
  saveState();

  console.log(JSON.stringify({
    level: 'info', event: 'trade_activity_snapshot', version: VERSION,
    eventCount: events.length, pollMs: POLL_MS,
    activeWindow: new Date(currentStart * 1000).toISOString(),
    instruments: Object.fromEntries(['BTC', 'ETH'].map(instrument => {
      const bucket = state.windows[String(currentStart)]?.byInstrument?.[instrument];
      return [instrument, bucket ? { trades: bucket.count, opens: bucket.openCount, closes: bucket.closeCount, closeUsd: Number(bucket.closeUsd.toFixed(2)) } : { trades: 0, opens: 0, closes: 0, closeUsd: 0 }];
    })),
  }));
}

console.log(JSON.stringify({
  level: 'info', event: 'trade_activity_monitor_started', version: VERSION,
  endpoint: RECENT_TRADES_URL, pollMs: POLL_MS, windowSeconds: PERIOD_SECONDS,
  statePath: STATE_PATH,
  thresholds: {
    minFrequencyTrades: MIN_FREQUENCY_TRADES, frequencyMultiplier: FREQUENCY_MULTIPLIER,
    minSequenceTransitions: MIN_SEQUENCE_TRANSITIONS, closeVolumeMultiplier: CLOSE_VOLUME_MULTIPLIER,
    minCloseVolumeUsd: MIN_CLOSE_VOLUME_USD, baselineWindows: HISTORY_WINDOWS,
  },
  signals: ['trade-frequency-spike', 'open-close-sequences-per-wallet', 'close-volume-spike'],
}));

let stopping = false;
async function loop() {
  while (!stopping) {
    const started = Date.now();
    let delayMs = Math.max(0, POLL_MS - (Date.now() - started));
    try {
      await poll();
      delayMs = Math.max(0, POLL_MS - (Date.now() - started));
    } catch (error) {
      const isRateLimited = Number(error?.status) === 429 || /HTTP 429\\b/.test(error instanceof Error ? error.message : String(error));
      if (isRateLimited) {
        const retryAfterSeconds = Number(error?.retryAfter);
        delayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : RATE_LIMIT_BACKOFF_MS;
      }
      console.error(JSON.stringify({
        level: 'error', event: 'trade_activity_poll_failed',
        message: error instanceof Error ? error.message : String(error),
      }));
    }
    await sleep(delayMs);
  }
}
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
loop();
