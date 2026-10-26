import fs from 'node:fs';
import path from 'node:path';

const API_BASE = (process.env.PAPERTRADE_API_BASE_URL || 'https://papertrade-ai.ninabrekkerese.workers.dev/api/v1/tools').replace(/\/+$/, '');
const POLL_MS = 1_000;
const STATE_PATH = process.env.PAPERTRADE_CLOSED_PNL_STATE_PATH || '/data/papertrade-closed-pnl-state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const PERIOD_SECONDS = 300;
const MAX_SEEN = 10_000;
const VERSION = 'papertrade-closed-pnl-v47-loss-majority-positive-pnl-only';

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
  return null;
};
const isClosed = event => ['close', 'closed', 'position_closed', 'close_position'].includes(String(event?.kind || event?.type || event?.action || '').toLowerCase());

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (saved.version !== 1) throw new Error('unsupported state version');
    return {
      initialized: saved.initialized === true,
      seenEvents: Array.isArray(saved.seenEvents) ? saved.seenEvents.map(String).slice(-MAX_SEEN) : [],
      windows: saved.windows && typeof saved.windows === 'object' ? saved.windows : {},
      alertedWindows: Array.isArray(saved.alertedWindows) ? saved.alertedWindows.map(String) : [],
      lossMajorityAlertedWindows: Array.isArray(saved.lossMajorityAlertedWindows) ? saved.lossMajorityAlertedWindows.map(String) : [],
      lastAlertType: ['positive', 'loss_majority'].includes(saved.lastAlertType) ? saved.lastAlertType : null,
      lastAlertInstrument: ['BTC', 'ETH'].includes(saved.lastAlertInstrument) ? saved.lastAlertInstrument : null,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { initialized: false, seenEvents: [], windows: {}, alertedWindows: [], lossMajorityAlertedWindows: [], lastAlertType: null, lastAlertInstrument: null };
    throw new Error(`Cannot load closed-PnL state at ${STATE_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let state = loadState();
const seenEvents = new Set(state.seenEvents);
const alertedWindows = new Set(state.alertedWindows);
const lossMajorityAlertedWindows = new Set(state.lossMajorityAlertedWindows || []);

function saveState() {
  const next = {
    version: 1,
    initialized: state.initialized,
    seenEvents: [...seenEvents].slice(-MAX_SEEN),
    windows: state.windows,
    alertedWindows: [...alertedWindows].slice(-5000),
    lossMajorityAlertedWindows: [...lossMajorityAlertedWindows].slice(-5000),
    lastAlertType: state.lastAlertType || null,
    lastAlertInstrument: state.lastAlertInstrument || null,
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
    String(event?.kind ?? event?.type ?? ''),
    String(event?.ts ?? event?.closedAt ?? ''),
    String(event?.pnlUsd ?? ''),
  ].join(':');
}

function addClose(event, periodStart, instrument) {
  const key = `${periodStart}:${instrument}`;
  const pnl = Number(event?.pnlUsd);
  const fee = Number(event?.feeUsd ?? 0);
  if (!Number.isFinite(pnl) || !Number.isFinite(fee)) return false;
  const window = state.windows[key] || {
    periodStart, instrument, closedTrades: 0, wins: 0, losses: 0, breakeven: 0,
    grossPnl: 0, fees: 0, netPnl: 0, eventKeys: [],
  };
  window.closedTrades += 1;
  window.grossPnl += pnl;
  window.fees += fee;
  window.netPnl += pnl - fee;
  if (pnl - fee > 0) window.wins += 1;
  else if (pnl - fee < 0) window.losses += 1;
  else window.breakeven += 1;
  window.eventKeys.push(eventKey(event));
  state.windows[key] = window;
  return true;
}

function formatPeriod(start) {
  return new Date(start * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function alertText(window) {
  const start = Number(window.periodStart);
  const slug = window.instrument.toLowerCase() + '-updown-5m-';
  const firstUrl = `https://polymarket.com/event/${slug}${start + PERIOD_SECONDS}`;
  const positive = window.netPnl > 0;
  const negative = window.netPnl < 0;
  const result = positive ? 'ПЛЮСОВОЙ' : negative ? 'МИНУСОВОЙ' : 'В НОЛЬ';
  const pnlArrow = positive ? ' ⬆️' : negative ? ' ⬇️' : '';
  return [
    `<b>${result} период — ${esc(window.instrument)}${pnlArrow}</b>`,
    `CLOSED: ${window.closedTrades}`,
    `Плюсовых сделок: ${window.wins} (+${window.closedTrades > 0 ? (window.wins / window.closedTrades * 100).toFixed(1) : '0.0'}%)`,
    `Минусовых сделок: ${window.losses} (-${window.closedTrades > 0 ? (window.losses / window.closedTrades * 100).toFixed(1) : '0.0'}%)`,
    `В ноль: ${window.breakeven} (${window.closedTrades > 0 ? (window.breakeven / window.closedTrades * 100).toFixed(1) : '0.0'}%)`,
    `PnL: ${esc(money(window.grossPnl))}`,

    '',
    `<a href="${firstUrl}">Начинающийся маркет</a>`,
  ].join('\n');
}


function lossMajorityAlertText(window) {
  const start = Number(window.periodStart);
  const slug = window.instrument.toLowerCase() + '-updown-5m-';
  const firstUrl = `https://polymarket.com/event/${slug}${start + PERIOD_SECONDS}`;
  const total = Number(window.closedTrades);
  return [
    `<b>МИНУСОВЫХ больше — ${esc(window.instrument)} ⬆️</b>`,
    `CLOSED: ${total}`,
    `Плюсовых сделок: ${window.wins} (${total > 0 ? (window.wins / total * 100).toFixed(1) : '0.0'}%)`,
    `Минусовых сделок: ${window.losses} (${total > 0 ? (window.losses / total * 100).toFixed(1) : '0.0'}%)`,
    `В ноль: ${window.breakeven} (${total > 0 ? (window.breakeven / total * 100).toFixed(1) : '0.0'}%)`,
    `PnL: ${esc(money(window.grossPnl))}`,
    '',
    `<a href="${firstUrl}">Начинающийся маркет</a>`,
  ].join('\n');
}

async function poll() {
  let now = Math.floor(Date.now() / 1000);
  let currentPeriodStart = periodStartFor(now);
  const firstRun = !state.initialized;
  const result = await callTool('get_recent_trades');
  // Anchor the alert deadline to the time the API response is received.
  now = Math.floor(Date.now() / 1000);
  currentPeriodStart = periodStartFor(now);
  const events = Array.isArray(result.events) ? result.events : [];
  let newClosed = 0;
  let ignored = 0;

  for (const event of events) {
    if (!isClosed(event)) continue;
    const instrument = instrumentOf(event);
    const closedAt = unixSeconds(event.closedAt ?? event.ts ?? event.timestamp);
    if (!instrument || !closedAt) { ignored++; continue; }
    const periodStart = periodStartFor(closedAt);
    // On first startup, establish a baseline from the currently active 5-minute window only.
    // Do not send historical alerts for periods that finished before this process started.
    if (firstRun && periodStart < currentPeriodStart) continue;
    const key = eventKey(event);
    if (seenEvents.has(key)) continue;
    if (addClose(event, periodStart, instrument)) {
      seenEvents.add(key);
      newClosed++;
    } else {
      ignored++;
    }
  }

  const completed = Object.values(state.windows)
    .filter(window => Number(window.periodStart) + PERIOD_SECONDS <= now)
    .sort((a, b) => Number(a.periodStart) - Number(b.periodStart) || a.instrument.localeCompare(b.instrument));

  let alertsSent = 0;
  for (const window of completed) {
    const key = `${window.periodStart}:${window.instrument}`;
    const grossPnl = Number(window.grossPnl);
    const diagnostic = {
      level: 'info', event: 'papertrade_closed_pnl_window_diagnostic',
      version: VERSION, windowKey: key, instrument: window.instrument,
      periodStart: new Date(Number(window.periodStart) * 1000).toISOString(),
      closedTrades: Number(window.closedTrades), grossPnl: Number.isFinite(grossPnl) ? Number(grossPnl.toFixed(2)) : null,
      fees: Number(Number(window.fees || 0).toFixed(2)),
      netPnl: Number(Number(window.netPnl || 0).toFixed(2)),
      wins: Number(window.wins), losses: Number(window.losses), breakeven: Number(window.breakeven),
      alreadyAlerted: alertedWindows.has(key),
    };
    const periodStart = Number(window.periodStart);

    // Loss-majority alert: only two criteria apply — losses exceed wins and net PnL is positive.
    // Keep the existing just-completed-period delivery window and per-window deduplication.
    if (
      periodStart === currentPeriodStart - PERIOD_SECONDS &&
      now - currentPeriodStart <= 2 &&
      !lossMajorityAlertedWindows.has(key) &&
      Number(window.losses) > Number(window.wins) &&
      Number(window.netPnl) > 0
    ) {
      console.log(JSON.stringify({ ...diagnostic, decision: 'send_attempt', reason: 'LOSSES_EXCEED_WINS_AND_NET_PNL_POSITIVE' }));
      await send(lossMajorityAlertText(window));
      lossMajorityAlertedWindows.add(key);
      state.lastAlertType = 'loss_majority';
      state.lastAlertInstrument = window.instrument;
      saveState();
      console.log(JSON.stringify({ ...diagnostic, decision: 'sent', reason: 'telegram_accepted_loss_majority_positive_pnl' }));
    }

    if (alertedWindows.has(key)) continue;
    // Both alert paths are boundary-only: if this isn't the just-finished period,
    // or the API response arrived more than 2 seconds after the boundary, never send.
    if (periodStart !== currentPeriodStart - PERIOD_SECONDS || now - currentPeriodStart > 2) {
      alertedWindows.add(key);
      continue;
    }
    const netPnl = Number(window.netPnl || 0);
    // Alert each instrument independently only when the completed 5-minute net PnL is at least $15,000.
    if (netPnl < 15_000) {
      alertedWindows.add(key);
      console.log(JSON.stringify({ ...diagnostic, decision: 'skipped', reason: 'NET_PNL_BELOW_15000', netPnl, minimumNetPnl: 15_000 }));
      continue;
    }
    if (state.lastAlertType === 'positive' && state.lastAlertInstrument === window.instrument) {
      alertedWindows.add(key);
      saveState();
      console.log(JSON.stringify({ ...diagnostic, decision: 'skipped', reason: 'REPEATED_POSITIVE_ALERT_SAME_INSTRUMENT_WITHOUT_INTERVENING_ALERT', lastAlertType: state.lastAlertType, lastAlertInstrument: state.lastAlertInstrument }));
      continue;
    }
    console.log(JSON.stringify({ ...diagnostic, decision: 'send_attempt', reason: 'completed_5m_window' }));
    await send(alertText(window));
    alertedWindows.add(key);
    alertsSent++;
    state.lastAlertType = 'positive';
    state.lastAlertInstrument = window.instrument;
    saveState();
    console.log(JSON.stringify({ ...diagnostic, decision: 'sent', reason: 'telegram_accepted' }));
  }

  // Retain only the last 48 hours of window data; keep alert keys for deduplication.
  const cutoff = now - 48 * 60 * 60;
  for (const [key, window] of Object.entries(state.windows)) {
    if (Number(window.periodStart) < cutoff) delete state.windows[key];
  }
  state.initialized = true;
  saveState();
  // Routine poll summaries are intentionally suppressed to keep runtime logs minimal.
}

console.log(JSON.stringify({
  level: 'info', event: 'papertrade_closed_pnl_monitor_started', version: VERSION,
  apiBase: API_BASE, pollMs: POLL_MS, periodSeconds: PERIOD_SECONDS, statePath: STATE_PATH,
  scope: 'all Papertrade closed trades grouped by instrument and 5-minute close-time window',
}));
let stopping = false;
async function loop() {
  while (!stopping) {
    const started = Date.now();
    try { await poll(); }
    catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'papertrade_closed_pnl_poll_failed', message: error instanceof Error ? error.message : String(error) }));
    }
    await sleep(Math.max(0, POLL_MS - (Date.now() - started)));
  }
}
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
loop();