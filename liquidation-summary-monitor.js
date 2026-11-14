import fs from 'node:fs';
import path from 'node:path';
import { lookup as lookupPromise } from 'node:dns/promises';
import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';

const PAPERTRADE_HEATMAP_URL = 'https://papertrade-liquidations.pages.dev/api/heatmap';
const PERIOD_SECONDS_LIST = [300];
const POLL_MS = Math.max(5_000, Number(process.env.LIQUIDATION_SUMMARY_POLL_MS || 5_000));
const PAPERTRADE_REQUEST_TIMEOUT_MS = 45_000;
const PAPERTRADE_REQUEST_ATTEMPTS = 4;
const PERIOD_FINALIZATION_GRACE_MS = 15_000;
const STATE_PATH = process.env.LIQUIDATION_SUMMARY_STATE_PATH || '/data/liquidation-direction-state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const VERSION = 'papertrade-5m-opposite-direction-ignore-eth-plus-010-v123';;;;;
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
async function fetchGetWithRetry(url, options, label, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(8_000),
      });
      if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt === attempts - 1) {
        return response;
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(5_000, retryAfter * 1000)
        : [500, 1_500, 3_000][attempt] || 3_000;
      const warningKey = `external_get_retry:${label}:${response.status}`;
      const lastWarningAt = lastTransientWarningAt.get(warningKey) || 0;
      if (Date.now() - lastWarningAt >= LOG_THROTTLE_MS) {
        console.warn(JSON.stringify({
          level: 'warn', event: 'external_get_request_retry',
          target: label, status: response.status, attempt: attempt + 1, maxAttempts: attempts, waitMs,
        }));
        lastTransientWarningAt.set(warningKey, Date.now());
      }
      await sleep(waitMs);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) break;
      const waitMs = [500, 1_500, 3_000][attempt] || 3_000;
      const warningKey = `external_get_retry:${label}:network`;
      const lastWarningAt = lastTransientWarningAt.get(warningKey) || 0;
      if (Date.now() - lastWarningAt >= LOG_THROTTLE_MS) {
        console.warn(JSON.stringify({
          level: 'warn', event: 'external_get_request_retry',
          target: label, attempt: attempt + 1, maxAttempts: attempts, waitMs,
          message: describeFetchError(error),
        }));
        lastTransientWarningAt.set(warningKey, Date.now());
      }
      await sleep(waitMs);
    }
  }
  throw new Error(`${label} request failed after ${attempts} attempts: ${lastError ? describeFetchError(lastError) : 'retryable HTTP response'}`);
}

const periodStartFor = (seconds, periodSeconds) => Math.floor(seconds / periodSeconds) * periodSeconds;
const esc = value => String(value ?? '—').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const priceText = value => String(Math.round(Number(value)));
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
state.periodWindows ||= {};
state.currentPeriods ||= {};
state.lastAlertSentPeriods ||= {};
state.rangeStreaks ||= {};
// Migrate the existing 5-minute state without resetting its history or deduplication.
state.periodWindows['300'] ||= state.windows || {};
if (state.currentPeriods['300'] === undefined && state.currentPeriod !== undefined) {
  state.currentPeriods['300'] = Number(state.currentPeriod);
}
if (state.lastAlertSentPeriods['300'] === undefined && state.lastAlertSentPeriod !== undefined) {
  state.lastAlertSentPeriods['300'] = Number(state.lastAlertSentPeriod);
}
for (const seconds of PERIOD_SECONDS_LIST) {
  state.periodWindows[String(seconds)] ||= {};
}

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
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    throw new Error(`Telegram send request failed: ${describeFetchError(error)}`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) throw new Error(`Telegram HTTP ${response.status}: ${body.description || 'send failed'}`);
}

const gammaEventsCache = new Map();

async function marketLink(market, periodStart, periodSeconds) {
  const cacheKey = `${market}:${periodSeconds}`;
  const cached = gammaEventsCache.get(cacheKey);
  let events;
  if (cached && Date.now() - cached.fetchedAt < 60_000) {
    events = cached.events;
  } else {
    const minutes = periodSeconds / 60;
    const url = new URL('https://gamma-api.polymarket.com/events');
    url.searchParams.set('series_slug', `${market.toLowerCase()}-up-or-down-${minutes}m`);
    url.searchParams.set('closed', 'false');
    url.searchParams.set('limit', '500');
    url.searchParams.set('order', 'endDate');
    url.searchParams.set('ascending', 'true');
    const response = await fetchGetWithRetry(url, {
      headers: { accept: 'application/json', 'user-agent': 'papertrade-polymarket-event-link-resolver' },
    }, `Polymarket Gamma events ${market} ${minutes}m`);
    if (!response.ok) throw new Error(`Gamma events ${market} ${minutes}m HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body)) throw new Error(`Gamma events ${market} ${minutes}m: unexpected response shape`);
    events = body;
    gammaEventsCache.set(cacheKey, { fetchedAt: Date.now(), events });
  }

  const event = events.find(item => {
    const start = item?.startTime || item?.eventStartTime || item?.markets?.[0]?.eventStartTime;
    return start && Math.floor(Date.parse(start) / 1000) === periodStart;
  });
  if (!event?.slug) throw new Error(`Gamma event not found for ${market} ${periodSeconds / 60}m period ${periodStart}`);
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
  const message = `<b>${market}</b>
Цена: ${priceText(first)} - ${priceText(last)} (${percentText(pct)})
\u200B
<a href="${marketLink(market, periodStart + 1200, PERIOD_SECONDS_LIST[0])}">Polymarket ${market} 5m</a>`
  return { pct, message, first, last };
}

async function finishPeriod(periodSeconds, periodStart, window) {
  if (!window || window.alerted || window.partial === true) return;

  const closeAtMs = (periodStart + periodSeconds) * 1000;
  const result = {};

  for (const market of ['BTC', 'ETH']) {
    const open = Number(window[market]?.firstPrice);
    const close = Number(window[market]?.lastPrice);
    const valid = Number.isFinite(open) && open > 0 && Number.isFinite(close) && close > 0;
    result[market] = {
      open: valid ? open : null,
      close: valid ? close : null,
      change: valid ? Number((close - open).toFixed(8)) : null,
      samples: Number(window[market]?.samples || 0),
    };
  }

  // Alert only when BTC and ETH close in opposite directions.
  // No numeric thresholds: one must be positive and the other negative.
  // A zero change does not qualify.
  const bothHaveData = ['BTC', 'ETH'].every(market =>
    Number.isFinite(result[market].open) && Number.isFinite(result[market].close) &&
    Number.isFinite(result[market].change));
  const oppositeDirections = bothHaveData && result.ETH.change !== 0.1 && (
    (result.BTC.change > 0 && result.ETH.change < 0) ||
    (result.BTC.change < 0 && result.ETH.change > 0)
  );
  const alertMarkets = oppositeDirections ? ['BTC', 'ETH'] : [];

  window.BTC = result.BTC;
  window.ETH = result.ETH;
  window.alertMarkets = alertMarkets;

  const minutes = periodSeconds / 60;
  console.log(JSON.stringify({
    level: 'info', event: `period_${minutes}m_open_close_change_evaluated`, version: VERSION,
    periodStart: new Date(periodStart * 1000).toISOString(),
    periodEnd: new Date(closeAtMs).toISOString(),
    BTC: result.BTC, ETH: result.ETH, alertMarkets,
  }));

  if (alertMarkets.length !== 2) {
    window.alerted = true;
    saveState();
  }

  if (alertMarkets.length === 2) {
    const alreadySentForPeriod = Number(state.lastAlertSentPeriods[String(periodSeconds)]) === periodStart;
    if (!alreadySentForPeriod) {
      const links = await Promise.all(alertMarkets.map(async market => [
        market,
        await marketLink(market, periodStart + 1200, periodSeconds),
      ]));
      const linkByMarket = Object.fromEntries(links);
      const sections = alertMarkets.map(market => {
        const item = result[market];
        const changeText = item.change > 0
          ? `+${item.change.toFixed(2).replace('.', ',')}`
          : item.change < 0
            ? item.change.toFixed(2).replace('.', ',')
            : '0,00';
        const closeText = market === "ETH" ? Number(item.close).toFixed(1).replace(".", ",") : priceText(item.close);
        return `${market}: ${closeText} (${changeText})`;
      });
      const marketLinks = alertMarkets.map(market =>
        `<a href="${linkByMarket[market]}">Polymarket ${market} ${minutes}m</a>`);
      const directionArrow = result.BTC.change < 0 ? '⬇️' : '⬆️';
      const message = `${sections.join('\n\n')}\n\n${marketLinks.map(link => `${link} ${directionArrow}`).join('\n\n')}`;
      await send(message);
      window.alerted = true;
      state.lastAlertSentPeriods[String(periodSeconds)] = periodStart;
      saveState();
      console.log(JSON.stringify({
        level: 'info', event: `period_${minutes}m_open_close_change_alert_sent`, version: VERSION,
        periodStart: new Date(periodStart * 1000).toISOString(),
        BTC: result.BTC, ETH: result.ETH,
      }));
    } else {
      window.alerted = true;
      saveState();
      console.log(JSON.stringify({
        level: 'info',
        event: `period_${minutes}m_open_close_change_alert_suppressed_duplicate_period`,
        version: VERSION, periodStart: new Date(periodStart * 1000).toISOString(),
      }));
    }
  }
  saveState();
}

async function poll() {
  const advancePeriods = async (observedNowSeconds, finalizeCompleted = true) => {
    for (const periodSeconds of PERIOD_SECONDS_LIST) {
      const currentStart = periodStartFor(observedNowSeconds, periodSeconds);
      const durationKey = String(periodSeconds);
      const windows = state.periodWindows[durationKey] ||= {};
      const previousCurrentStart = Number(state.currentPeriods[durationKey]);
      if (!Number.isFinite(previousCurrentStart)) {
        windows[String(currentStart)] ||= {
          periodStart: currentStart, BTC: null, ETH: null, alerted: false, partial: true,
        };
        state.currentPeriods[durationKey] = currentStart;
        continue;
      }

      if (currentStart !== previousCurrentStart) {
        windows[String(currentStart)] ||= {
          periodStart: currentStart, BTC: null, ETH: null, alerted: false, partial: false,
        };
        state.currentPeriods[durationKey] = currentStart;
      }

      // Finalize immediately once both markets have valid observations.
      // The 15-second grace is used only when BTC or ETH data is missing.
      // Keep an incomplete period pending and retry on subsequent polls.
      if (!finalizeCompleted) continue;
      for (const [key, completed] of Object.entries(windows)) {
        const completedStart = Number(key);
        if (!Number.isFinite(completedStart) || completedStart >= currentStart ||
            completed.alerted || completed.partial === true) continue;
        const closeAtMs = (completedStart + periodSeconds) * 1000;
        const hasBothMarkets = ['BTC', 'ETH'].every(market => {
          const item = completed[market];
          return Number.isFinite(Number(item?.firstPrice)) && Number(item?.firstPrice) > 0 &&
            Number.isFinite(Number(item?.lastPrice)) && Number(item?.lastPrice) > 0;
        });
        if (!hasBothMarkets) {
          if (Date.now() < closeAtMs + PERIOD_FINALIZATION_GRACE_MS) continue;
          console.warn(JSON.stringify({
            level: 'warn', event: 'period_waiting_for_both_market_data',
            version: VERSION, periodStart: new Date(completedStart * 1000).toISOString(),
            graceMs: PERIOD_FINALIZATION_GRACE_MS,
            hasBTC: Boolean(completed.BTC), hasETH: Boolean(completed.ETH),
          }));
          continue;
        }
        completed.partial = false;
        await finishPeriod(periodSeconds, completedStart, completed);
      }
    }
  };

  await advancePeriods(Math.floor(Date.now() / 1000));

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

  // Create any newly active period after the HTTP request, but defer
  // finalization until delayed response snapshots have been assigned.
  await advancePeriods(Math.floor(Date.now() / 1000), false);

  for (const market of ['BTC', 'ETH']) {
    const snapshot = snapshots[market];
    if (!snapshot) continue;
    const history = state.priceHistory[market] ||= [];
    history.push({ ts: snapshot.asOfMs, price: snapshot.price });
    for (const periodSeconds of PERIOD_SECONDS_LIST) {
      // Attribute a delayed HTTP response to the period represented by its
      // source timestamp, not automatically to the period active at receipt.
      const snapshotPeriodStart = periodStartFor(Math.floor(snapshot.asOfMs / 1000), periodSeconds);
      const windows = state.periodWindows[String(periodSeconds)];
      const targetWindow = windows[String(snapshotPeriodStart)];
      if (!targetWindow || targetWindow.alerted) continue;
      const item = targetWindow[market];
      if (!item) {
        targetWindow[market] = {
          firstPrice: snapshot.price, lastPrice: snapshot.price,
          firstAtMs: snapshot.asOfMs, lastAtMs: snapshot.asOfMs, samples: 1,
        };
      } else {
        if (snapshot.asOfMs < Number(item.firstAtMs || Infinity)) {
          item.firstPrice = snapshot.price;
          item.firstAtMs = snapshot.asOfMs;
        }
        if (snapshot.asOfMs >= Number(item.lastAtMs || 0)) {
          item.lastPrice = snapshot.price;
          item.lastAtMs = snapshot.asOfMs;
        }
        item.samples = Number(item.samples || 0) + 1;
      }
    }
  }

  // Now that late snapshots have been assigned by source timestamp, finalize
  // any completed period whose 15-second grace window has elapsed.
  await advancePeriods(Math.floor(Date.now() / 1000), true);

  // Keep enough observations for the active 5-minute period windows.
  const historyCutoffMs = Date.now() - 31 * 60_000;
  for (const market of ['BTC', 'ETH']) {
    state.priceHistory[market] = (state.priceHistory[market] || []).filter(point => point.ts >= historyCutoffMs);
  }
  for (const periodSeconds of PERIOD_SECONDS_LIST) {
    const currentStart = Number(state.currentPeriods[String(periodSeconds)]);
    const windows = state.periodWindows[String(periodSeconds)];
    for (const key of Object.keys(windows)) {
      if (Number(key) < currentStart - 2 * periodSeconds) delete windows[key];
    }
  }
  state.initialized = true;
  state.currentPeriod = state.currentPeriods['300'];
  state.windows = state.periodWindows['300'];
  saveState();

  if (Object.keys(errors).length) throw new Error(Object.values(errors).join('; '));
}

console.log(JSON.stringify({
  level: 'info', event: 'price_movement_monitor_started', version: VERSION,
  source: PAPERTRADE_HEATMAP_URL, priceField: 'markPrice (top-level or documented wrapper)', pollMs: POLL_MS, periodSeconds: PERIOD_SECONDS_LIST, requestTimeoutMs: PAPERTRADE_REQUEST_TIMEOUT_MS, requestAttempts: PAPERTRADE_REQUEST_ATTEMPTS,
  statePath: STATE_PATH, finalizationGraceMs: PERIOD_FINALIZATION_GRACE_MS, alert: '5m monitoring only. Send alerts when BTC and ETH close in opposite directions: one positive and one negative. No numeric thresholds. Zero change does not qualify. No special alerts, arrows, or alternation. Polymarket links target the market starting 1200 seconds after the completed period start.',
  markets: ['BTC', 'ETH'], link: 'Matching Polymarket up/down market for the same UTC period duration',
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
    // next configured period boundary so the previous window is finalized immediately.
    const now = Date.now();
    const activePeriodSeconds = PERIOD_SECONDS_LIST[0];
    const activePeriodStart = Number(state.currentPeriods[String(activePeriodSeconds)]);
    if (state.initialized &&
        periodStartFor(Math.floor(now / 1000), activePeriodSeconds) !== activePeriodStart) {
      continue;
    }
    const nextBoundaryMs = (Math.floor(now / (PERIOD_SECONDS_LIST[0] * 1000)) + 1) * PERIOD_SECONDS_LIST[0] * 1000;
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
