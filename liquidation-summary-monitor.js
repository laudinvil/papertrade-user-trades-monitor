import fs from 'node:fs';
import path from 'node:path';

const PAPERTRADE_MARKETS_URL = 'https://papertrade-ai.ninabrekkerese.workers.dev/api/v1/tools/get_markets';
const PERIOD_SECONDS = 300;
const POLL_MS = Math.max(10_000, Number(process.env.LIQUIDATION_SUMMARY_POLL_MS || 20_000));
const STATE_PATH = process.env.LIQUIDATION_SUMMARY_STATE_PATH || '/data/liquidation-direction-state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const VERSION = 'papertrade-5m-period-minimum-eth-1-31-btc-41-no-maximum-v51';
const LOG_THROTTLE_MS = 5 * 60_000;
const lastTransientWarningAt = new Map();

if (!BOT_TOKEN || !CHAT_ID) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function describeFetchError(error) {
  const chain = [];
  let current = error;
  for (let depth = 0; current && depth < 4; depth++, current = current.cause) {
    const item = {
      name: current.name || 'Error',
      message: String(current.message || current).slice(0, 240),
    };
    for (const key of ['code', 'syscall', 'hostname', 'address', 'port', 'errno']) {
      if (current[key] !== undefined && current[key] !== null) item[key] = current[key];
    }
    chain.push(item);
  }
  return JSON.stringify(chain);
}
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
      message: describeFetchError(error),
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

async function fetchPapertradePrices() {
  let response;
  let lastRequestError;
  const maxAttempts = 3;

  // Papertrade's public get_markets tool returns the live BTC/ETH markPrice
  // used by the exchange. One request supplies both markets from one snapshot.
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      response = await fetch(PAPERTRADE_MARKETS_URL, {
        headers: { accept: 'application/json', 'user-agent': 'papertrade-liquidation-direction-monitor' },
        signal: AbortSignal.timeout(12_000),
      });
      lastRequestError = null;
      if (response.ok || ![429, 502, 503, 504].includes(response.status)) break;

      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(8_000, retryAfter * 1000)
        : 1_500 * (2 ** attempt);
      const warningKey = `papertrade_markets:${response.status}`;
      const lastWarningAt = lastTransientWarningAt.get(warningKey) || 0;
      if (Date.now() - lastWarningAt >= LOG_THROTTLE_MS) {
        console.warn(JSON.stringify({
          level: 'warn', event: 'papertrade_price_request_retry',
          status: response.status, attempt: attempt + 1, maxAttempts, waitMs,
          throttled: true, throttleMs: LOG_THROTTLE_MS,
        }));
        lastTransientWarningAt.set(warningKey, Date.now());
      }
      if (attempt < maxAttempts - 1) await sleep(waitMs);
    } catch (error) {
      lastRequestError = error;
      if (attempt >= maxAttempts - 1) break;
      const waitMs = 1_500 * (2 ** attempt);
      const warningKey = 'papertrade_markets:request_error';
      const lastWarningAt = lastTransientWarningAt.get(warningKey) || 0;
      if (Date.now() - lastWarningAt >= LOG_THROTTLE_MS) {
        console.warn(JSON.stringify({
          level: 'warn', event: 'papertrade_price_request_retry',
          attempt: attempt + 1, maxAttempts, waitMs,
          message: describeFetchError(error),
          throttled: true, throttleMs: LOG_THROTTLE_MS,
        }));
        lastTransientWarningAt.set(warningKey, Date.now());
      }
      await sleep(waitMs);
    }
  }

  if (lastRequestError) {
    throw new Error(`Papertrade get_markets failed after ${maxAttempts} attempts: ${describeFetchError(lastRequestError)}`);
  }

  const contentType = response.headers.get('content-type') || '';
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = null; }
  const markets = body?.data?.markets || body?.markets;
  if (!response.ok || body?.ok === false || !Array.isArray(markets)) {
    const apiError = body?.error?.message || body?.message || body?.error || '';
    const detail = apiError
      ? String(apiError)
      : !body
        ? `non-JSON response (${contentType || 'unknown content type'}): ${raw.slice(0, 160).replace(/\\s+/g, ' ')}`
        : `markets array not found; keys=${Object.keys(body).join(',') || '(none)'}; contentType=${contentType}`;
    throw new Error(`Papertrade get_markets HTTP ${response.status}: ${detail}`);
  }

  const asOfCandidates = [body?.data?.asOfMs, body?.asOfMs, body?.data?.timestamp, body?.timestamp];
  const asOfMs = asOfCandidates.map(value => {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }).find(value => Number.isFinite(value) && value > 0) || Date.now();

  return Object.fromEntries(['BTC', 'ETH'].map(market => {
    const item = markets.find(entry => String(entry?.market || entry?.symbol || '').toUpperCase() === market);
    const price = Number(item?.markPrice);
    if (!Number.isFinite(price) || price <= 0) return [market, null];
    return [market, { market, price, asOfMs }];
  }));
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

const gammaEventsCache = new Map();

async function marketLink(market, periodStart) {
  const cached = gammaEventsCache.get(market);
  let events;
  if (cached && Date.now() - cached.fetchedAt < 60_000) {
    events = cached.events;
  } else {
    const url = new URL('https://gamma-api.polymarket.com/events');
    url.searchParams.set('series_slug', `${market.toLowerCase()}-up-or-down-5m`);
    url.searchParams.set('closed', 'false');
    url.searchParams.set('limit', '500');
    url.searchParams.set('order', 'endDate');
    url.searchParams.set('ascending', 'true');
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'papertrade-polymarket-event-link-resolver' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Gamma events ${market} HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body)) throw new Error(`Gamma events ${market}: unexpected response shape`);
    events = body;
    gammaEventsCache.set(market, { fetchedAt: Date.now(), events });
  }

  const event = events.find(item => {
    const start = item?.startTime || item?.eventStartTime || item?.markets?.[0]?.eventStartTime;
    return start && Math.floor(Date.parse(start) / 1000) === periodStart;
  });
  if (!event?.slug) throw new Error(`Gamma event not found for ${market} period ${periodStart}`);
  return `https://polymarket.com/event/${event.slug}`;
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
  const rollingStartMs = periodStart * 1000;
  const result = {};

  for (const market of ['BTC', 'ETH']) {
    const close = Number(window[market]?.lastPrice);
    const samples = (state.priceHistory?.[market] || [])
      .filter(point => point.ts >= rollingStartMs && point.ts <= closeAtMs && Number.isFinite(point.price));
    // With a 20-second polling interval, a healthy 5-minute period normally
    // contains about 15 samples. Require at least 12 (80%) so outages do not
    // produce an extreme alert from an incomplete price range.
    const minimumSamples = 12;
    if (!Number.isFinite(close) || close <= 0 || samples.length < minimumSamples) {
      result[market] = null;
      console.warn(JSON.stringify({
        level: 'warn', event: 'period_5m_market_skipped_insufficient_samples',
        version: VERSION, market, periodStart: new Date(periodStart * 1000).toISOString(),
        samples: samples.length, minimumSamples,
      }));
      continue;
    }
    const prices = samples.map(point => point.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min;
    const atMinimum = close === min;
    const rangeQualifies = market === 'BTC' ? range >= 41 : range >= 1.31;
    result[market] = {
      close, min, max, range,
      atMinimum,
      atMaximum: close === max,
      rangeQualifies,
      extreme: atMinimum && rangeQualifies,
      samples: samples.length,
    };
  }

  const btc = result.BTC;
  const eth = result.ETH;
  // Re-check the exact numeric limits at the alert-selection boundary as a fail-closed guard.
  const extremeMarkets = ['BTC', 'ETH'].filter(market => {
    const item = result[market];
    if (!item?.atMinimum) return false;
    const range = item.max - item.min;
    return market === 'BTC'
      ? Number.isFinite(range) && range >= 41
      : Number.isFinite(range) && range >= 1.31;
  });
  window.alerted = true;
  window.BTC30m = btc;
  window.ETH30m = eth;
  window.extremeMarkets = extremeMarkets;

  console.log(JSON.stringify({
    level: 'info', event: 'period_5m_extreme_close_evaluated', version: VERSION,
    periodStart: new Date(periodStart * 1000).toISOString(),
    windowStart: new Date(rollingStartMs).toISOString(),
    windowEnd: new Date(closeAtMs).toISOString(),
    BTC: btc, ETH: eth, extremeMarkets,
  }));

  // If BTC and ETH both qualify in the same 5-minute period, ignore both.
  if (extremeMarkets.length === 2) {
    console.log(JSON.stringify({
      level: 'info', event: 'period_5m_extreme_alert_suppressed_both_markets', version: VERSION,
      periodStart: new Date(periodStart * 1000).toISOString(),
      extremeMarkets,
    }));
  } else if (extremeMarkets.length === 1) {
    const currentAlertMarkets = [...extremeMarkets].sort();
    const alreadySentForPeriod = Number(state.lastAlertSentPeriod) === periodStart;

    if (!alreadySentForPeriod) {
      const lines = await Promise.all(extremeMarkets.map(async market => {
        const item = result[market];
        const extremeTypes = 'МИНИМУМ ⬆️';
        const url = await marketLink(market, periodStart + PERIOD_SECONDS);
        return `<b>⬆️ ${market}: 5-минутный ${extremeTypes}</b>
Диапазон: ${priceText(item.min)} — ${priceText(item.max)} (${priceText(item.max - item.min)})

<a href="${url}">Polymarket ${market} 5m</a>`;
      }));
      // Reserve this period before sending so a restart cannot send it twice.
      state.lastAlertSentPeriod = periodStart;
      state.lastAlertMarkets = currentAlertMarkets;
      saveState();
      await send(lines.join('\\n\\n'));
      console.log(JSON.stringify({
        level: 'info', event: 'period_5m_extreme_close_alert_sent', version: VERSION,
        periodStart: new Date(periodStart * 1000).toISOString(),
        extremeMarkets,
      }));
    } else {
      console.log(JSON.stringify({
        level: 'info', event: 'period_5m_extreme_alert_suppressed_duplicate_period', version: VERSION,
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
  try {
    const prices = await fetchPapertradePrices();
    for (const market of ['BTC', 'ETH']) {
      if (prices[market]) snapshots[market] = prices[market];
      else errors[market] = `Papertrade get_markets did not return a valid ${market} markPrice`;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    for (const market of ['BTC', 'ETH']) errors[market] = detail;
    const warningKey = 'papertrade_prices_fetch_failed';
    const lastWarningAt = lastTransientWarningAt.get(warningKey) || 0;
    if (Date.now() - lastWarningAt >= LOG_THROTTLE_MS) {
      console.warn(JSON.stringify({
        level: 'warn', event: 'papertrade_prices_fetch_failed',
        message: detail.slice(0, 500), throttled: true, throttleMs: LOG_THROTTLE_MS,
      }));
      lastTransientWarningAt.set(warningKey, Date.now());
    }
  }

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

  const historyCutoffMs = Date.now() - 6 * 60_000;
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
  source: PAPERTRADE_MARKETS_URL, priceField: 'data.markets[].markPrice', pollMs: POLL_MS, periodSeconds: PERIOD_SECONDS, requestTimeoutMs: 12_000, requestAttempts: 3, minimumSamplesPerMarket: 12,
  statePath: STATE_PATH, alert: 'at each completed 5-minute close, alert when BTC closes at its 5-minute sampled markPrice minimum with range between $2 and $31, or ETH closes at its minimum with range <= $1.49; if both markets qualify, suppress both alerts',
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
