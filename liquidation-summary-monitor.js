import fs from 'node:fs';
import path from 'node:path';
import { lookup as lookupPromise } from 'node:dns/promises';
import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';

const PAPERTRADE_HEATMAP_URL = 'https://papertrade-liquidations.pages.dev/api/heatmap';
const PERIOD_SECONDS = 300;
const POLL_MS = Math.max(5_000, Number(process.env.LIQUIDATION_SUMMARY_POLL_MS || 5_000));
const PAPERTRADE_REQUEST_TIMEOUT_MS = 20_000;
const PAPERTRADE_REQUEST_ATTEMPTS = 4;
const STATE_PATH = process.env.LIQUIDATION_SUMMARY_STATE_PATH || '/data/liquidation-direction-state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const VERSION = 'papertrade-5m-btc-eth-both-ranges-narrower-exact-periods-v8-restore-arrows-60-4';
const LOG_THROTTLE_MS = 5 * 60_000;
const lastTransientWarningAt = new Map();

if (!BOT_TOKEN || !CHAT_ID) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Retry transient EAI_AGAIN errors inside Node's HTTPS DNS lookup itself.
function lookupWithDnsRetry(hostname, options, callback) {
  const waits = [250, 500, 1_000];
  let attempt = 0;
  const run = () => {
    dnsLookup(hostname, options || {}, (error, address, family) => {
      if (error?.code === 'EAI_AGAIN' && attempt < waits.length) {
        const waitMs = waits[attempt++];
        setTimeout(run, waitMs);
        return;
      }
      callback(error, address, family);
    });
  };
  run();
}

function requestPapertrade(url) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'papertrade-liquidation-direction-monitor',
      },
      lookup: lookupWithDnsRetry,
      signal: AbortSignal.timeout(PAPERTRADE_REQUEST_TIMEOUT_MS),
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('error', reject);
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode || 0,
          headers: { get: name => response.headers[String(name).toLowerCase()] ?? null },
          text: async () => raw,
        });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

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
state.minimumStreaks ||= { BTC: 0, ETH: 0 };

function saveState() {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const temp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ ...state, savedAt: new Date().toISOString() }));
  fs.renameSync(temp, STATE_PATH);
}

async function fetchPapertradePrices() {
  async function fetchMarket(market) {
    const url = new URL(PAPERTRADE_HEATMAP_URL);
    url.searchParams.set('market', market);
    let response;
    let lastRequestError;
    const maxAttempts = PAPERTRADE_REQUEST_ATTEMPTS;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        response = await requestPapertrade(url);
        lastRequestError = null;
        if (response.ok || ![429, 502, 503, 504].includes(response.status)) break;

        const retryAfter = Number(response.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(8_000, retryAfter * 1000)
          : [2_000, 5_000, 10_000][attempt] || 10_000;
        const warningKey = `papertrade_heatmap:${market}:${response.status}`;
        const lastWarningAt = lastTransientWarningAt.get(warningKey) || 0;
        if (Date.now() - lastWarningAt >= LOG_THROTTLE_MS) {
          console.warn(JSON.stringify({
            level: 'warn', event: 'papertrade_price_request_retry',
            market, status: response.status, attempt: attempt + 1, maxAttempts, waitMs,
            throttled: true, throttleMs: LOG_THROTTLE_MS,
          }));
          lastTransientWarningAt.set(warningKey, Date.now());
        }
        if (attempt < maxAttempts - 1) await sleep(waitMs);
      } catch (error) {
        lastRequestError = error;
        if (attempt >= maxAttempts - 1) break;
        const waitMs = [2_000, 5_000, 10_000][attempt] || 10_000;
        const warningKey = `papertrade_heatmap:${market}:request_error`;
        const lastWarningAt = lastTransientWarningAt.get(warningKey) || 0;
        if (Date.now() - lastWarningAt >= LOG_THROTTLE_MS) {
          console.warn(JSON.stringify({
            level: 'warn', event: 'papertrade_price_request_retry',
            market, attempt: attempt + 1, maxAttempts, waitMs,
            message: describeFetchError(error),
            throttled: true, throttleMs: LOG_THROTTLE_MS,
          }));
          lastTransientWarningAt.set(warningKey, Date.now());
        }
        await sleep(waitMs);
      }
    }

    if (lastRequestError) {
      const hostname = url.hostname;
      const diagnosticKey = `papertrade_dns_diagnostic:${hostname}`;
      const lastDiagnosticAt = lastTransientWarningAt.get(diagnosticKey) || 0;
      if (Date.now() - lastDiagnosticAt >= LOG_THROTTLE_MS) {
        const diagnosticStartedAt = Date.now();
        try {
          const addresses = await lookupPromise(hostname, { all: true, verbatim: true });
          console.warn(JSON.stringify({
            level: 'warn', event: 'papertrade_dns_resolution_check',
            hostname, ok: true, addresses,
            durationMs: Date.now() - diagnosticStartedAt,
          }));
        } catch (dnsError) {
          console.error(JSON.stringify({
            level: 'error', event: 'papertrade_dns_resolution_check',
            hostname, ok: false, message: describeFetchError(dnsError),
            durationMs: Date.now() - diagnosticStartedAt,
          }));
        }
        lastTransientWarningAt.set(diagnosticKey, Date.now());
      }
      throw new Error(`Papertrade heatmap ${market} failed after ${maxAttempts} attempts: ${describeFetchError(lastRequestError)}`);
    }

    const contentType = response.headers.get('content-type') || '';
    const raw = await response.text();
    let body;
    try { body = JSON.parse(raw); } catch { body = null; }

    const candidates = [
      body?.markPrice,
      body?.data?.markPrice,
      body?.heatmap?.markPrice,
      body?.result?.markPrice,
    ];
    const price = candidates.map(Number).find(value => Number.isFinite(value) && value > 0);
    if (!response.ok || price === undefined) {
      const apiError = body?.error?.message || body?.message || body?.error || '';
      const detail = apiError
        ? String(apiError)
        : !body
          ? `non-JSON response (${contentType || 'unknown content type'}): ${raw.slice(0, 160).replace(/\\s+/g, ' ')}`
          : `markPrice not found; keys=${Object.keys(body).join(',') || '(none)'}; contentType=${contentType}`;
      throw new Error(`Papertrade heatmap ${market} HTTP ${response.status}: ${detail}`);
    }

    const asOfCandidates = [body?.asOfMs, body?.data?.asOfMs, body?.heatmap?.asOfMs, body?.result?.asOfMs];
    const asOfMs = asOfCandidates.map(Number).find(value => Number.isFinite(value) && value > 0) || Date.now();
    return { market, price, asOfMs };
  }

  const results = await Promise.all(['BTC', 'ETH'].map(async market => {
    try {
      return [market, await fetchMarket(market)];
    } catch (error) {
      return [market, { error: error instanceof Error ? error.message : String(error) }];
    }
  }));
  return Object.fromEntries(results);
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
  const previousPeriodStartMs = (periodStart - PERIOD_SECONDS) * 1000;
  const previousPeriodWindow = state.windows[String(periodStart - PERIOD_SECONDS)];
  const previousPeriodComplete = Boolean(previousPeriodWindow && previousPeriodWindow.partial !== true);
  const result = {};

  for (const market of ['BTC', 'ETH']) {
    const close = Number(window[market]?.lastPrice);
    const samples = (state.priceHistory?.[market] || [])
      .filter(point => point.ts >= rollingStartMs && point.ts < closeAtMs && Number.isFinite(point.price));
    const prices = samples.map(point => point.price);
    const min = prices.length ? Math.min(...prices) : null;
    const max = prices.length ? Math.max(...prices) : null;
    const previousSamples = (state.priceHistory?.[market] || [])
      .filter(point => point.ts >= previousPeriodStartMs &&
        point.ts < rollingStartMs && Number.isFinite(point.price));
    const previousPrices = previousSamples.map(point => point.price);
    const previousMin = previousPrices.length ? Math.min(...previousPrices) : null;
    const previousMax = previousPrices.length ? Math.max(...previousPrices) : null;
    const matchesPreviousRangeBoundary = Number.isFinite(close) && close > 0 &&
      previousPrices.length > 0 && (close === previousMin || close === previousMax);

    result[market] = {
      close: Number.isFinite(close) && close > 0 ? close : null,
      min, max,
      range: prices.length ? max - min : null,
      previousMin, previousMax,
      matchesPreviousRangeBoundary,
      samples: samples.length,
      previousSamples: previousSamples.length,
    };
  }

  const bothRangesNarrower = previousPeriodComplete && ['BTC', 'ETH'].every(market =>
    Number.isFinite(result[market]?.range) &&
    Number.isFinite(result[market]?.previousMin) &&
    Number.isFinite(result[market]?.previousMax) &&
    result[market].range < result[market].previousMax - result[market].previousMin
  );

  // Only double alerts are allowed: both BTC and ETH ranges must narrow.
  const alertMarkets = bothRangesNarrower ? ['BTC', 'ETH'] : [];
  window.alerted = true;
  window.BTC30m = result.BTC;
  window.ETH30m = result.ETH;
  window.alertMarkets = alertMarkets;

  console.log(JSON.stringify({
    level: 'info', event: 'period_5m_one_market_inside_one_outside_previous_range_evaluated', version: VERSION,
    periodStart: new Date(periodStart * 1000).toISOString(),
    previousPeriodStart: new Date(previousPeriodStartMs).toISOString(),
    previousPeriodEnd: new Date(rollingStartMs).toISOString(),
    windowStart: new Date(rollingStartMs).toISOString(),
    windowEnd: new Date(closeAtMs).toISOString(),
    previousPeriodComplete,
    BTC: result.BTC, ETH: result.ETH, alertMarkets,
  }));

  // Alert each market whose close exactly equals the previous period's Last low or high.
  if (alertMarkets.length > 0) {
    const alreadySentForPeriod = Number(state.lastAlertSentPeriod) === periodStart;

    if (!alreadySentForPeriod) {
      const links = await Promise.all(alertMarkets.map(async market => [
        market,
        await marketLink(market, periodStart + PERIOD_SECONDS),
      ]));
      const linkByMarket = Object.fromEntries(links);
      const sections = alertMarkets.map(market => {
        const item = result[market];
        return `Закрытие ${market}: ${priceText(item.close)} (${priceText(item.previousMax - item.previousMin)})
Last ${market}: ${priceText(item.previousMin)} — ${priceText(item.previousMax)}`;
      });
      const marketLinks = alertMarkets.map(market => {
        const previousRange = result[market].previousMax - result[market].previousMin;
        const arrowThreshold = market === 'BTC' ? 60 : 4;
        const arrow = previousRange > arrowThreshold ? ' ⬆️' : previousRange < arrowThreshold ? ' ⬇️' : '';
        return `<a href="${linkByMarket[market]}">Polymarket ${market}</a>${arrow}`;
      });
      const message = `<b>${alertMarkets.join(' + ')}</b>
${sections.join('\n\n')}

${marketLinks.join('\n\n')}`;
      state.lastAlertSentPeriod = periodStart;
      state.lastAlertMarkets = alertMarkets;
      saveState();
      await send(message);
      console.log(JSON.stringify({
        level: 'info', event: 'period_5m_previous_last_boundary_match_alert_sent', version: VERSION,
        periodStart: new Date(periodStart * 1000).toISOString(),
        alertMarkets, BTC: result.BTC, ETH: result.ETH,
      }));
    } else {
      console.log(JSON.stringify({
        level: 'info',
        event: 'period_5m_previous_last_boundary_match_alert_suppressed_duplicate_period',
        version: VERSION,
        periodStart: new Date(periodStart * 1000).toISOString(),
        alertMarkets,
      }));
    }
  } else {
    console.log(JSON.stringify({
      level: 'info', event: 'period_5m_previous_last_boundary_match_not_met', version: VERSION,
      periodStart: new Date(periodStart * 1000).toISOString(),
      alertMarkets,
    }));
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
      if (prices[market] && !prices[market].error) snapshots[market] = prices[market];
      else errors[market] = prices[market]?.error || `Papertrade heatmap did not return a valid ${market} markPrice`;
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

  // Keep both exact adjacent 5-minute periods in memory for range comparison.
  const historyCutoffMs = Date.now() - 11 * 60_000;
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
  source: PAPERTRADE_HEATMAP_URL, priceField: 'markPrice (top-level or documented wrapper)', pollMs: POLL_MS, periodSeconds: PERIOD_SECONDS, requestTimeoutMs: PAPERTRADE_REQUEST_TIMEOUT_MS, requestAttempts: PAPERTRADE_REQUEST_ATTEMPTS,
  statePath: STATE_PATH, alert: 'send one combined BTC + ETH alert only when each completed 5-minute range is strictly narrower than its immediately preceding completed 5-minute range; compare exact adjacent UTC periods, no single-market alerts',
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
