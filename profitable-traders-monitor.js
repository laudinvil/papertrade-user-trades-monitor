import fs from 'node:fs';
import path from 'node:path';

const UPNL_URL = 'https://exchange.papertrade.xyz/state/leaderboard/accounts';
const POLL_MS = 15_000;
const RATE_LIMIT_BACKOFF_MS = 300_000;
const PERIOD_SECONDS = 300;
const STATE_PATH = process.env.PAPERTRADE_UPNL_STATE_PATH || '/data/papertrade-upnl-state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const VERSION = 'aggregate-upnl-change-5m-v1';
const MAX_SNAPSHOTS = 2_000;
const SAMPLE_TOLERANCE_SECONDS = 45;
// Fail closed rather than sending alerts if the endpoint is misparsed or returns non-dollar-scaled values.
const MAX_ABSOLUTE_ACCOUNT_UPNL_USD = 1_000_000_000;
const MAX_ABSOLUTE_AGGREGATE_UPNL_USD = 10_000_000_000;

if (!BOT_TOKEN || !CHAT_ID) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const money = value => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n < 0 ? '-$' : '$'}${Math.abs(n).toFixed(2)}`;
};
const periodStartFor = seconds => Math.floor(seconds / PERIOD_SECONDS) * PERIOD_SECONDS;
const esc = value => String(value ?? '—').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// Papertrade stores these account-state amounts as 18-decimal fixed-point (WAD) integers.
// Convert exactly before applying dollar-scale sanity limits.
function wadToUsd(value) {
  if (typeof value !== 'string' || !/^-?\\d+$/.test(value.trim())) {
    throw new Error(`Unexpected currentUnrealizedPnl format; expected an integer WAD string, received ${String(value).slice(0, 80)}`);
  }
  const raw = BigInt(value.trim());
  const scale = 10n ** 18n;
  const sign = raw < 0n ? -1 : 1;
  const absolute = raw < 0n ? -raw : raw;
  const whole = absolute / scale;
  const fraction = absolute % scale;
  return sign * (Number(whole) + Number(fraction) / 1e18);
}

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (saved.version !== 1) throw new Error('unsupported state version');
    return {
      snapshots: Array.isArray(saved.snapshots)
        ? saved.snapshots.filter(x => Number.isFinite(Number(x?.ts)) && Number.isFinite(Number(x?.totalUpnl))).slice(-MAX_SNAPSHOTS)
        : [],
      alertedPeriods: Array.isArray(saved.alertedPeriods) ? saved.alertedPeriods.map(Number) : [],
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { snapshots: [], alertedPeriods: [] };
    throw new Error(`Cannot load uPnL state at ${STATE_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let state = loadState();

function saveState() {
  state.snapshots = state.snapshots.slice(-MAX_SNAPSHOTS);
  state.alertedPeriods = state.alertedPeriods.slice(-500);
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const temp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, ...state, savedAt: new Date().toISOString() }));
  fs.renameSync(temp, STATE_PATH);
}

async function fetchAggregateUpnl() {
  const response = await fetch(UPNL_URL, {
    method: 'GET',
    headers: { accept: 'application/json', 'user-agent': 'papertrade-upnl-monitor' },
    signal: AbortSignal.timeout(15_000),
  });
  const rawBody = await response.text().catch(() => '');
  let body;
  try { body = rawBody ? JSON.parse(rawBody) : null; } catch {}
  if (!response.ok || !body || typeof body !== 'object') {
    const error = new Error(`Papertrade accounts HTTP ${response.status}: ${rawBody.slice(0, 250) || 'empty or invalid response'}`);
    error.status = response.status;
    error.retryAfter = response.headers.get('retry-after');
    throw error;
  }

  // The endpoint may wrap its account rows in different envelope keys.
  // Sum the current uPnL field for each account row. The API field is an 18-decimal WAD integer, not USD; convert before summing. Never include trader names in alerts.
  const accounts = [];
  const visited = new Set();
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const pnlValue = value.currentUnrealizedPnl ?? value.currentUnrealizedPnL ?? value.current_unrealized_pnl;
    if (pnlValue !== undefined && pnlValue !== null && pnlValue !== '') {
      const pnl = wadToUsd(String(pnlValue));
      if (Number.isFinite(pnl)) {
        if (Math.abs(pnl) > MAX_ABSOLUTE_ACCOUNT_UPNL_USD) {
          throw new Error(`Rejected suspicious currentUnrealizedPnl value (${String(pnlValue).slice(0, 80)}); endpoint field/units must be verified`);
        }
        const identity = String(value.wallet ?? value.address ?? value.account ?? value.accountId ?? value.id ?? '');
        const dedupeKey = identity ? `${identity.toLowerCase()}:${pnl}` : null;
        if (!dedupeKey || !visited.has(dedupeKey)) {
          accounts.push(pnl);
          if (dedupeKey) visited.add(dedupeKey);
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (['currentUnrealizedPnl', 'currentUnrealizedPnL', 'current_unrealized_pnl'].includes(key)) continue;
      if (child && typeof child === 'object') walk(child);
    }
  }
  walk(body);
  if (accounts.length === 0) {
    throw new Error('Papertrade accounts response contains no numeric currentUnrealizedPnl account rows');
  }
  const totalUpnl = accounts.reduce((sum, pnl) => sum + pnl, 0);
  if (!Number.isFinite(totalUpnl) || Math.abs(totalUpnl) > MAX_ABSOLUTE_AGGREGATE_UPNL_USD) {
    throw new Error(`Rejected suspicious aggregate uPnL (${String(totalUpnl)}); refusing to store snapshots or send alerts`);
  }
  return { totalUpnl, accountCount: accounts.length };
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

function marketLinks(periodStart) {
  const marketStart = periodStart + PERIOD_SECONDS;
  return [
    `<a href="https://polymarket.com/event/btc-updown-5m-${marketStart}">BTC маркет</a>`,
    `<a href="https://polymarket.com/event/eth-updown-5m-${marketStart}">ETH маркет</a>`,
  ].join(' | ');
}

function alertText(previous, current, delta, periodStart) {
  const direction = delta > 0 ? '⬆️ ОБЩИЙ uPnL УВЕЛИЧИЛСЯ' : '⬇️ ОБЩИЙ uPnL УМЕНЬШИЛСЯ';
  return [
    `<b>${direction} за 5 минут</b>`,
    `uPnL 5 минут назад: ${esc(money(previous.totalUpnl))}`,
    `Текущий общий uPnL: ${esc(money(current.totalUpnl))}`,
    `Изменение: <b>${delta > 0 ? '+' : ''}${esc(money(delta))}</b>`,
    '',
    marketLinks(periodStart),
  ].join(String.fromCharCode(10));
}

async function poll() {
  const now = Math.floor(Date.now() / 1000);
  const { totalUpnl, accountCount } = await fetchAggregateUpnl();
  const current = { ts: now, totalUpnl: Number(totalUpnl.toFixed(8)) };
  const last = state.snapshots[state.snapshots.length - 1];
  if (!last || now - Number(last.ts) >= 10) state.snapshots.push(current);
  else state.snapshots[state.snapshots.length - 1] = current;

  const targetTs = now - PERIOD_SECONDS;
  const candidates = state.snapshots.filter(s => Math.abs(Number(s.ts) - targetTs) <= SAMPLE_TOLERANCE_SECONDS);
  const previous = candidates.sort((a, b) => Math.abs(Number(a.ts) - targetTs) - Math.abs(Number(b.ts) - targetTs))[0];
  const periodStart = periodStartFor(now);

  if (previous && !state.alertedPeriods.includes(periodStart)) {
    const delta = Number((current.totalUpnl - Number(previous.totalUpnl)).toFixed(2));
    if (delta !== 0) {
      await send(alertText(previous, current, delta, periodStart));
      console.log(JSON.stringify({
        level: 'info', event: 'aggregate_upnl_alert_sent', version: VERSION,
        periodStart: new Date(periodStart * 1000).toISOString(),
        previousUpnl: previous.totalUpnl, currentUpnl: current.totalUpnl,
        delta, direction: delta > 0 ? 'increase' : 'decrease', accountCount,
      }));
    } else {
      console.log(JSON.stringify({
        level: 'info', event: 'aggregate_upnl_unchanged', version: VERSION,
        periodStart: new Date(periodStart * 1000).toISOString(), totalUpnl: current.totalUpnl,
      }));
    }
    state.alertedPeriods.push(periodStart);
  } else if (!previous && !state.alertedPeriods.includes(periodStart)) {
    console.log(JSON.stringify({
      level: 'info', event: 'aggregate_upnl_waiting_for_5m_baseline', version: VERSION,
      snapshotCount: state.snapshots.length, targetTs,
    }));
  }

  const cutoff = now - 60 * 60;
  state.snapshots = state.snapshots.filter(s => Number(s.ts) >= cutoff);
  state.alertedPeriods = state.alertedPeriods.filter(p => p >= periodStart - 24 * 60 * 60);
  saveState();
  console.log(JSON.stringify({
    level: 'info', event: 'aggregate_upnl_snapshot', version: VERSION,
    totalUpnl: current.totalUpnl, accountCount, pollMs: POLL_MS,
  }));
}

console.log(JSON.stringify({
  level: 'info', event: 'aggregate_upnl_monitor_started', version: VERSION,
  endpoint: UPNL_URL, pollMs: POLL_MS, comparisonSeconds: PERIOD_SECONDS,
  statePath: STATE_PATH, alertPolicy: 'alert on any aggregate uPnL change of at least $0.01 versus approximately 5 minutes earlier; no trader names',
}));

let stopping = false;
async function loop() {
  while (!stopping) {
    const started = Date.now();
    let delayMs = POLL_MS;
    try {
      await poll();
      delayMs = Math.max(0, POLL_MS - (Date.now() - started));
    } catch (error) {
      const isRateLimited = Number(error?.status) === 429 || /HTTP 429\b/.test(error instanceof Error ? error.message : String(error));
      if (isRateLimited) {
        const retryAfterSeconds = Number(error?.retryAfter);
        delayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : RATE_LIMIT_BACKOFF_MS;
      } else {
        delayMs = POLL_MS;
      }
      console.error(JSON.stringify({
        level: 'error', event: 'aggregate_upnl_poll_failed',
        message: error instanceof Error ? error.message : String(error),
      }));
    }
    await sleep(delayMs);
  }
}
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
loop();
