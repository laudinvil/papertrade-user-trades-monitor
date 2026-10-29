import fs from 'node:fs';
import path from 'node:path';

const HEATMAP_URL = 'https://papertrade-liquidations.pages.dev/api/heatmap';
const PERIOD_SECONDS = 300;
const POLL_MS = Math.max(10_000, Number(process.env.LIQUIDATION_SUMMARY_POLL_MS || 20_000));
const STATE_PATH = process.env.LIQUIDATION_SUMMARY_STATE_PATH || '/data/liquidation-direction-state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const VERSION = 'papertrade-opposite-coin-closes-single-period-v24-startup-state-recovery';

if (!BOT_TOKEN || !CHAT_ID) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const periodStartFor = seconds => Math.floor(seconds / PERIOD_SECONDS) * PERIOD_SECONDS;
const esc = value => String(value ?? '—').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const priceText = value => Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const percentText = value => `${value > 0 ? '+' : ''}${value.toFixed(3)}%`;

function loadState() {
  try {
    const value = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (value?.version === 1 && value.windows && typeof value.windows === 'object') return value;
    console.warn(JSON.stringify({
      level: 'warn', event: 'state_reset_invalid_shape',
      statePath: STATE_PATH, foundVersion: value?.version ?? null,
    }));
    return { version: 1, initialized: false, windows: {} };
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, initialized: false, windows: {} };
    console.warn(JSON.stringify({
      level: 'warn', event: 'state_reset_unreadable',
      statePath: STATE_PATH,
      message: error instanceof Error ? error.message : String(error),
    }));
    return { version: 1, initialized: false, windows: {} };
  }
}

let state = loadState();

function saveState() {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const temp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ ...state, savedAt: new Date().toISOString() }));
  fs.renameSync(temp, STATE_PATH);
}

async function fetchHeatmap(market) {
  const url = new URL(HEATMAP_URL);
  url.searchParams.set('market', market);
  let response;
  // The heatmap API can return 502 when its upstream Hyperliquid allMids
  // request is rate-limited (429). Retry transient failures once, with a pause.
  for (let attempt = 0; attempt < 2; attempt++) {
    response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'papertrade-liquidation-direction-monitor' },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok || ![429, 502, 503, 504].includes(response.status) || attempt === 1) break;
    const retryAfter = Number(response.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(10_000, retryAfter * 1000)
      : 3_000;
    console.warn(JSON.stringify({
      level: 'warn', event: 'heatmap_transient_retry', market,
      status: response.status, attempt: attempt + 1, waitMs,
    }));
    await sleep(waitMs);
  }
  const contentType = response.headers.get('content-type') || '';
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = null; }

  // The published API documents markPrice at the top level. Also tolerate common
  // proxy/wrapper envelopes so a harmless response-shape change doesn't stop monitoring.
  const candidates = [
    body?.markPrice,
    body?.data?.markPrice,
    body?.heatmap?.markPrice,
    body?.result?.markPrice,
  ];
  const markPrice = candidates.map(Number).find(value => Number.isFinite(value) && value > 0);
  if (!response.ok || markPrice === undefined) {
    const apiError = body?.error?.message || body?.message || body?.error || '';
    const detail = apiError
      ? String(apiError)
      : !body
        ? `non-JSON response (${contentType || 'unknown content type'}): ${raw.slice(0, 160).replace(/\\s+/g, ' ')}`
        : `markPrice not found; keys=${Object.keys(body).join(',') || '(none)'}; contentType=${contentType}`;
    const error = new Error(`Heatmap ${market} HTTP ${response.status}: ${detail}`);
    error.status = response.status;
    error.retryAfter = response.headers.get('retry-after');
    throw error;
  }
  const asOfCandidates = [body?.asOfMs, body?.data?.asOfMs, body?.heatmap?.asOfMs, body?.result?.asOfMs];
  const asOfMs = asOfCandidates.map(Number).find(value => Number.isFinite(value) && value > 0) || Date.now();
  return { market, price: markPrice, asOfMs };
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

function marketLink(market, periodStart) {
  return `https://polymarket.com/event/${market.toLowerCase()}-updown-5m-${periodStart}`;
}

function utcTime(seconds) {
  return new Date(seconds * 1000).toISOString().slice(11, 16);
}

function getMarketMovement(market, window, periodStart) {
  const first = Number(window?.firstPrice);
  const last = Number(window?.lastPrice);
  if (!window || !Number.isFinite(first) || !Number.isFinite(last) || first <= 0 || last <= 0) return null;

  const pct = (last - first) / first * 100;
  const direction = pct < 0 ? 'down' : 'up';
  const label = direction === 'down' ? '⬇️ ВНИЗ' : '⬆️ ВВЕРХ';
  const message = `<b>${market} ${label}</b>
Цена: ${priceText(first)} → ${priceText(last)} (${percentText(pct)})
\u200B
<a href="${marketLink(market, periodStart + PERIOD_SECONDS)}">Polymarket ${market} 5m</a>`
  return { direction, pct, message, first, last };
}

async function finishPeriod(periodStart, window) {
  if (!window || window.alerted || window.partial === true) return;

  const btc = getMarketMovement('BTC', window.BTC, periodStart);
  const eth = getMarketMovement('ETH', window.ETH, periodStart);
  const sign = movement => !movement ? 0 : movement.pct > 0 ? 1 : movement.pct < 0 ? -1 : 0;
  const btcSign = sign(btc);
  const ethSign = sign(eth);
  const opposite = btcSign !== 0 && ethSign !== 0 && btcSign === -ethSign;

  // Each completed 5-minute period is evaluated independently. No multi-period
  // streak requirement and no percentage threshold.
  window.alerted = true;
  saveState();

  console.log(JSON.stringify({
    level: 'info',
    event: 'opposite_coin_close_evaluated',
    version: VERSION,
    periodStart: new Date(periodStart * 1000).toISOString(),
    BTC: btc ? { direction: btc.direction, changePct: btc.pct } : null,
    ETH: eth ? { direction: eth.direction, changePct: eth.pct } : null,
    oppositeDirections: opposite,
  }));

  if (!opposite) return;

  const directionText = movement => movement.direction === 'up' ? 'ВВЕРХ' : 'ВНИЗ';
  const message = `<b>BTC и ETH закрылись разнонаправленно</b>
BTC: ${directionText(btc)} ${priceText(btc.first)} → ${priceText(btc.last)} (${percentText(btc.pct)})
ETH: ${directionText(eth)} ${priceText(eth.first)} → ${priceText(eth.last)} (${percentText(eth.pct)})
<a href="${marketLink('BTC', periodStart + PERIOD_SECONDS)}">Polymarket BTC 5m</a> · <a href="${marketLink('ETH', periodStart + PERIOD_SECONDS)}">Polymarket ETH 5m</a>`;

  await send(message);
  state.lastAlertSentPeriod = periodStart;
  saveState();
  console.log(JSON.stringify({
    level: 'info',
    event: 'opposite_coin_close_alert_sent',
    version: VERSION,
    periodStart: new Date(periodStart * 1000).toISOString(),
    BTC: { direction: btc.direction, changePct: btc.pct },
    ETH: { direction: eth.direction, changePct: eth.pct },
  }));
}

async function poll() {
  const now = Math.floor(Date.now() / 1000);
  let currentStart = periodStartFor(now);

  // Finalize the previous 5-minute window immediately when the boundary is
  // detected, before making fresh HTTP requests for the new period.
  if (state.initialized && currentStart !== Number(state.currentPeriod)) {
    const previousStart = Number(state.currentPeriod);
    const previous = state.windows[String(previousStart)];
    if (previousStart === currentStart - PERIOD_SECONDS && previous && !previous.alerted) {
      await finishPeriod(previousStart, previous);
    }
    state.currentPeriod = currentStart;
    state.windows[String(currentStart)] = {
      periodStart: currentStart, BTC: null, ETH: null, alerted: false, partial: false,
    };
    saveState();
  }

  const snapshots = {};
  const errors = {};
  await Promise.all(['BTC', 'ETH'].map(async market => {
    try {
      snapshots[market] = await fetchHeatmap(market);
    } catch (error) {
      errors[market] = error instanceof Error ? error.message : String(error);
      console.warn(JSON.stringify({ level: 'warn', event: 'heatmap_fetch_failed', market, message: errors[market].slice(0, 240) }));
    }
  }));

  // The HTTP requests may straddle a 5-minute boundary. Reconcile the
  // period again after fetching so post-boundary prices are never written into
  // the period that just ended.
  const observedStart = periodStartFor(Math.floor(Date.now() / 1000));
  if (observedStart !== currentStart) {
    const previousStart = currentStart;
    const previous = state.windows[String(previousStart)];
    if (state.initialized && observedStart === previousStart + PERIOD_SECONDS && previous && !previous.alerted) {
      await finishPeriod(previousStart, previous);
    }
    currentStart = observedStart;
    state.currentPeriod = currentStart;
    state.windows[String(currentStart)] ||= {
      periodStart: currentStart, BTC: null, ETH: null, alerted: false, partial: false,
    };
    saveState();
  }

  if (!state.initialized) {
    state.initialized = true;
    state.currentPeriod = currentStart;
    state.windows[String(currentStart)] = { periodStart: currentStart, BTC: null, ETH: null, alerted: false, partial: true };
    for (const market of ['BTC', 'ETH']) {
      if (snapshots[market]) {
        state.windows[String(currentStart)][market] = {
          firstPrice: snapshots[market].price,
          lastPrice: snapshots[market].price,
          firstAtMs: snapshots[market].asOfMs,
          lastAtMs: snapshots[market].asOfMs,
          samples: 1,
        };
      }
    }
    saveState();
    console.log(JSON.stringify({ level: 'info', event: 'price_movement_baseline_set', version: VERSION, periodStart: new Date(currentStart * 1000).toISOString(), prices: Object.fromEntries(Object.entries(snapshots).map(([m, s]) => [m, s.price])) }));
    if (Object.keys(errors).length) throw new Error(Object.values(errors).join('; '));
    return;
  }

  const active = state.windows[String(currentStart)] || (state.windows[String(currentStart)] = { periodStart: currentStart, BTC: null, ETH: null, alerted: false, partial: false });
  for (const market of ['BTC', 'ETH']) {
    const snapshot = snapshots[market];
    if (!snapshot) continue;
    const item = active[market];
    if (!item) {
      active[market] = {
        firstPrice: snapshot.price,
        lastPrice: snapshot.price,
        firstAtMs: snapshot.asOfMs,
        lastAtMs: snapshot.asOfMs,
        samples: 1,
        buckets: snapshot.buckets,
        firstBuckets: snapshot.buckets,
      };
    } else {
      item.lastPrice = snapshot.price;
      item.buckets = snapshot.buckets;
      item.lastAtMs = snapshot.asOfMs;
      item.samples = Number(item.samples || 0) + 1;
    }
  }

  for (const key of Object.keys(state.windows)) {
    if (Number(key) < currentStart - 2 * PERIOD_SECONDS) delete state.windows[key];
  }
  saveState();
  console.log(JSON.stringify({
    level: 'info', event: 'price_movement_snapshot', version: VERSION,
    source: 'papertrade liquidation heatmap markPrice', pollMs: POLL_MS,
    periodStart: new Date(currentStart * 1000).toISOString(),
    prices: Object.fromEntries(['BTC', 'ETH'].map(m => [m, snapshots[m]?.price ?? null])),
    errors,
  }));
  if (Object.keys(errors).length) throw new Error(Object.values(errors).join('; '));
}

console.log(JSON.stringify({
  level: 'info', event: 'price_movement_monitor_started', version: VERSION,
  source: HEATMAP_URL, pollMs: POLL_MS, periodSeconds: PERIOD_SECONDS, retryTransientHttpOnce: true,
  statePath: STATE_PATH, alert: 'no percentage thresholds; alert once when BTC and ETH close in opposite directions in a single completed 5-minute period',
  markets: ['BTC', 'ETH'], link: 'Polymarket up/down 5-minute market for the same UTC period',
}));

let stopping = false;
let consecutiveFailures = 0;
async function loop() {
  while (!stopping) {
    const started = Date.now();
    try {
      await poll();
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures++;
      console.error(JSON.stringify({
        level: 'error', event: 'price_movement_poll_failed',
        consecutiveFailures, message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      }));
    }

    // Take a final sample shortly before the boundary, then wake at the exact
    // next 5-minute boundary so the previous window is finalized immediately.
    const now = Date.now();
    if (state.initialized && periodStartFor(Math.floor(now / 1000)) !== Number(state.currentPeriod)) {
      continue;
    }
    const nextBoundaryMs = (Math.floor(now / (PERIOD_SECONDS * 1000)) + 1) * PERIOD_SECONDS * 1000;
    const preBoundaryMs = nextBoundaryMs - 1_000;
    const targetMs = (preBoundaryMs > now && preBoundaryMs - now < POLL_MS)
      ? preBoundaryMs
      : Math.min(now + POLL_MS, nextBoundaryMs);
    await sleep(Math.max(0, targetMs - Date.now()));
  }
}
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
loop();
