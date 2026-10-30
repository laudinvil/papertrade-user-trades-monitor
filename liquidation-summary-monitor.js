import fs from 'node:fs';
import path from 'node:path';

const HEATMAP_URL = 'https://papertrade-liquidations.pages.dev/api/heatmap';
const PERIOD_SECONDS = 300;
const POLL_MS = Math.max(10_000, Number(process.env.LIQUIDATION_SUMMARY_POLL_MS || 20_000));
const STATE_PATH = process.env.LIQUIDATION_SUMMARY_STATE_PATH || '/data/liquidation-direction-state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const VERSION = 'papertrade-any-coin-30m-all-arrows-up-v37';
const LOG_THROTTLE_MS = 5 * 60_000;
const lastTransientWarningAt = new Map();

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
state.priceHistory ||= { BTC: [], ETH: [] };

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
    const warningKey = `${market}:${response.status}`;
    const lastWarningAt = lastTransientWarningAt.get(warningKey) || 0;
    if (Date.now() - lastWarningAt >= LOG_THROTTLE_MS) {
      console.warn(JSON.stringify({
        level: 'warn', event: 'heatmap_transient_retry', market,
        status: response.status, attempt: attempt + 1, waitMs,
        throttled: true, throttleMs: LOG_THROTTLE_MS,
      }));
      lastTransientWarningAt.set(warningKey, Date.now());
    }
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
  const label = direction === 'down' ? '⬆️ ВНИЗ' : '⬆️ ВВЕРХ';
  const message = `<b>${market} ${label}</b>
Цена: ${priceText(first)} → ${priceText(last)} (${percentText(pct)})
\u200B
<a href="${marketLink(market, periodStart + PERIOD_SECONDS)}">Polymarket ${market} 5m</a>`
  return { direction, pct, message, first, last };
}

async function finishPeriod(periodStart, window) {
  if (!window || window.alerted || window.partial === true) return;

  const closeAtMs = (periodStart + PERIOD_SECONDS) * 1000;
  const rollingStartMs = closeAtMs - 30 * 60_000;
  const result = {};

  for (const market of ['BTC', 'ETH']) {
    const close = Number(window[market]?.lastPrice);
    const samples = (state.priceHistory?.[market] || [])
      .filter(point => point.ts >= rollingStartMs && point.ts <= closeAtMs && Number.isFinite(point.price));
    if (!Number.isFinite(close) || close <= 0 || samples.length === 0) {
      result[market] = null;
      continue;
    }
    const prices = samples.map(point => point.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    result[market] = {
      close, min, max,
      atMinimum: close === min,
      atMaximum: close === max,
      extreme: close === min || close === max,
      samples: samples.length,
    };
  }

  const btc = result.BTC;
  const eth = result.ETH;
  const extremeMarkets = ['BTC', 'ETH'].filter(market => result[market]?.extreme);
  window.alerted = true;
  window.BTC30m = btc;
  window.ETH30m = eth;
  window.extremeMarkets = extremeMarkets;

  console.log(JSON.stringify({
    level: 'info', event: 'rolling_30m_extreme_close_evaluated', version: VERSION,
    periodStart: new Date(periodStart * 1000).toISOString(),
    windowStart: new Date(rollingStartMs).toISOString(),
    windowEnd: new Date(closeAtMs).toISOString(),
    BTC: btc, ETH: eth, extremeMarkets,
  }));

  if (extremeMarkets.length > 0) {
    const currentAlertMarkets = [...extremeMarkets].sort();
    const previousAlertMarkets = Array.isArray(state.lastAlertMarkets)
      ? [...state.lastAlertMarkets].sort()
      : [];
    const sameAlertMarkets = currentAlertMarkets.length === previousAlertMarkets.length
      && currentAlertMarkets.every((market, index) => market === previousAlertMarkets[index]);

    if (!sameAlertMarkets) {
      const lines = extremeMarkets.map(market => {
        const item = result[market];
        const extremeTypes = [
          ...(item.atMinimum ? ['МИНИМУМ ⬆️'] : []),
          ...(item.atMaximum ? ['МАКСИМУМ ⬆️'] : []),
        ].join(' и ');
        return `<b>${market}: 30-минутный ${extremeTypes}</b>
Цена: ${priceText(item.close)}
Диапазон: ${priceText(item.min)} — ${priceText(item.max)}
<a href="${marketLink(market, periodStart + PERIOD_SECONDS)}">Polymarket ${market} 5m</a>`;
      });
      await send(lines.join('\n\n'));
      state.lastAlertSentPeriod = periodStart;
      state.lastAlertMarkets = currentAlertMarkets;
      console.log(JSON.stringify({
        level: 'info', event: 'rolling_30m_extreme_close_alert_sent', version: VERSION,
        periodStart: new Date(periodStart * 1000).toISOString(),
        extremeMarkets,
      }));
    } else {
      console.log(JSON.stringify({
        level: 'info', event: 'rolling_30m_extreme_alert_suppressed_same_markets', version: VERSION,
        periodStart: new Date(periodStart * 1000).toISOString(),
        extremeMarkets,
      }));
    }
  }
  saveState();
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
      const warningKey = `fetch_failed:${market}`;
      const lastWarningAt = lastTransientWarningAt.get(warningKey) || 0;
      if (Date.now() - lastWarningAt >= LOG_THROTTLE_MS) {
        console.warn(JSON.stringify({ level: 'warn', event: 'heatmap_fetch_failed', market, message: errors[market].slice(0, 240), throttled: true, throttleMs: LOG_THROTTLE_MS }));
        lastTransientWarningAt.set(warningKey, Date.now());
      }
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
        state.priceHistory[market].push({ ts: snapshots[market].asOfMs, price: snapshots[market].price });
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
    const history = state.priceHistory[market] ||= [];
    history.push({ ts: snapshot.asOfMs, price: snapshot.price });
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

  const historyCutoffMs = Date.now() - 31 * 60_000;
  for (const market of ['BTC', 'ETH']) {
    state.priceHistory[market] = (state.priceHistory[market] || []).filter(point => point.ts >= historyCutoffMs);
  }

  for (const key of Object.keys(state.windows)) {
    if (Number(key) < currentStart - 2 * PERIOD_SECONDS) delete state.windows[key];
  }
  saveState();

  if (Object.keys(errors).length) throw new Error(Object.values(errors).join('; '));
}

console.log(JSON.stringify({
  level: 'info', event: 'price_movement_monitor_started', version: VERSION,
  source: HEATMAP_URL, pollMs: POLL_MS, periodSeconds: PERIOD_SECONDS, retryTransientHttpOnce: true,
  statePath: STATE_PATH, alert: 'at each completed 5-minute close, alert when BTC and/or ETH closes at its own rolling 30-minute sampled markPrice minimum or maximum; either or both markets may qualify',
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
