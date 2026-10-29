import fs from 'node:fs';
import path from 'node:path';

const HEATMAP_URL = 'https://papertrade-liquidations.pages.dev/api/heatmap';
const PERIOD_SECONDS = 300;
const POLL_MS = Math.max(5_000, Number(process.env.LIQUIDATION_SUMMARY_POLL_MS || 10_000));
const STATE_PATH = process.env.LIQUIDATION_SUMMARY_STATE_PATH || '/data/liquidation-direction-state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const VERSION = 'papertrade-price-movement-absolute-max-0025-flat-up-next-period-cooldown-v19';

if (!BOT_TOKEN || !CHAT_ID) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const periodStartFor = seconds => Math.floor(seconds / PERIOD_SECONDS) * PERIOD_SECONDS;
const esc = value => String(value ?? '—').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const priceText = value => Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const percentText = value => `${value > 0 ? '+' : ''}${value.toFixed(3)}%`;

function loadState() {
  try {
    const value = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (value.version !== 1) throw new Error('unsupported state version');
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, initialized: false, windows: {} };
    throw new Error(`Cannot load price movement state: ${error instanceof Error ? error.message : String(error)}`);
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
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'papertrade-liquidation-direction-monitor' },
    signal: AbortSignal.timeout(1_800),
  });
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

  window.marketAlerted ||= {};
  window.pendingAlerts ||= {};

  // After any alert was actually sent, suppress all alerts in the immediately
  // following 5-minute period, regardless of whether BTC or ETH qualifies.
  if (Number(state.lastAlertSentPeriod) === periodStart - PERIOD_SECONDS) {
    for (const market of ['BTC', 'ETH']) {
      window.marketAlerted[market] = true;
      delete window.pendingAlerts[market];
    }
    window.alerted = true;
    saveState();
    console.log(JSON.stringify({
      level: 'info', event: 'price_movement_alerts_suppressed_after_previous_period_alert',
      version: VERSION, markets: ['BTC', 'ETH'],
      periodStart: new Date(periodStart * 1000).toISOString(),
      previousAlertPeriodStart: new Date(Number(state.lastAlertSentPeriod) * 1000).toISOString(),
      reason: 'suppress_next_period_after_any_sent_alert',
    }));
    return;
  }

  // Evaluate both coins before sending anything. If both qualify in the same
  // completed 5-minute window, suppress both alerts for that window.
  const qualifiesForAlert = (market, movement) => {
    if (!movement) return false;
    return movement.pct >= -0.025 && movement.pct <= 0.025;
  };
  const candidates = {};
  for (const market of ['BTC', 'ETH']) {
    if (window.marketAlerted[market]) {
      candidates[market] = false;
      continue;
    }
    candidates[market] = Boolean(window.pendingAlerts[market]) ||
      qualifiesForAlert(market, getMarketMovement(market, window[market], periodStart));
  }
  if (candidates.BTC && candidates.ETH) {
    for (const market of ['BTC', 'ETH']) {
      window.marketAlerted[market] = true;
      delete window.pendingAlerts[market];
    }
    window.alerted = true;
    saveState();
    console.log(JSON.stringify({
      level: 'info', event: 'price_movement_alerts_suppressed_both_coins_qualify',
      version: VERSION, markets: ['BTC', 'ETH'],
      periodStart: new Date(periodStart * 1000).toISOString(),
      reason: 'both_coins_qualify_same_period',
    }));
    return;
  }

  for (const market of ['BTC', 'ETH']) {
    if (window.marketAlerted[market]) continue;

    // Retry an already prepared alert before evaluating the market again.
    if (window.pendingAlerts[market]) {
      await send(window.pendingAlerts[market]);
      delete window.pendingAlerts[market];
      window.marketAlerted[market] = true;
      state.lastAlertSentPeriod = periodStart;
      saveState();
      console.log(JSON.stringify({
        level: 'info', event: 'price_movement_alert_sent', version: VERSION,
        market, periodStart: new Date(periodStart * 1000).toISOString(), retry: true,
      }));
      continue;
    }

    const movement = getMarketMovement(market, window[market], periodStart);
    if (!movement) {
      window.marketAlerted[market] = true;
      saveState();
      console.log(JSON.stringify({
        level: 'info', event: 'price_movement_alert_skipped', version: VERSION,
        market, reason: 'missing_or_invalid_prices',
        periodStart: new Date(periodStart * 1000).toISOString(),
      }));
      continue;
    }

    const qualifies = movement.pct >= -0.025 && movement.pct <= 0.025;
    const thresholdPctUp = 0.025;
    const thresholdPctDown = -0.025;

    if (!qualifies) {
      window.marketAlerted[market] = true;
      saveState();
      console.log(JSON.stringify({
        level: 'info', event: 'price_movement_alert_skipped', version: VERSION,
        market, reason: 'below_threshold', changePct: movement.pct,
        thresholdPctUp, thresholdPctDown, periodStart: new Date(periodStart * 1000).toISOString(),
      }));
      continue;
    }

    window.pendingAlerts[market] = movement.message;
    saveState();
    await send(window.pendingAlerts[market]);
    delete window.pendingAlerts[market];
    window.marketAlerted[market] = true;
    state.lastAlertSentPeriod = periodStart;
    saveState();
    console.log(JSON.stringify({
      level: 'info', event: 'price_movement_alert_sent', version: VERSION,
      market, direction: movement.direction, changePct: movement.pct,
      thresholdPctUp, thresholdPctDown, periodStart: new Date(periodStart * 1000).toISOString(),
    }));
  }

  window.alerted = true;
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
  source: HEATMAP_URL, pollMs: POLL_MS, periodSeconds: PERIOD_SECONDS,
  statePath: STATE_PATH, alert: 'all markets: alert only when movement is between -0.025% and +0.025% inclusive; if both BTC and ETH qualify in one period, suppress both; suppress all alerts in the 5-minute period immediately after any sent alert, regardless of coin; finalize at each 5-minute boundary, sample about 1 second before boundary, target alert within 3 seconds after the linked period starts',
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
