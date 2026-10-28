import fs from 'node:fs';
import path from 'node:path';

const HEATMAP_URL = 'https://papertrade-liquidations.pages.dev/api/heatmap';
const PERIOD_SECONDS = 300;
const POLL_MS = Math.max(30_000, Number(process.env.LIQUIDATION_SUMMARY_POLL_MS || 60_000));
const STATE_PATH = process.env.LIQUIDATION_SUMMARY_STATE_PATH || '/data/liquidation-direction-state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const VERSION = 'papertrade-liquidation-direction-5m-v3-heatmap-price-confirmation';

if (!BOT_TOKEN || !CHAT_ID) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const periodStartFor = seconds => Math.floor(seconds / PERIOD_SECONDS) * PERIOD_SECONDS;
const esc = value => String(value ?? '—').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const priceText = value => Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const percentText = value => `${value > 0 ? '+' : ''}${value.toFixed(3)}%`;
const CLUSTER_MAX_DISTANCE_PERCENT = 0.5;
const usdText = value => `${Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

function loadState() {
  try {
    const value = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (value.version !== 1) throw new Error('unsupported state version');
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, initialized: false, windows: {} };
    throw new Error(`Cannot load direction state: ${error instanceof Error ? error.message : String(error)}`);
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
    signal: AbortSignal.timeout(20_000),
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
  const bucketCandidates = [body?.buckets, body?.data?.buckets, body?.heatmap?.buckets, body?.result?.buckets];
  const rawBuckets = bucketCandidates.find(Array.isArray) || [];
  const buckets = rawBuckets.map(bucket => ({
    lo: Number(bucket?.lo), hi: Number(bucket?.hi), mid: Number(bucket?.mid),
    longNotional: Number(bucket?.longNotional || 0), shortNotional: Number(bucket?.shortNotional || 0),
    longCount: Number(bucket?.longCount || 0), shortCount: Number(bucket?.shortCount || 0),
  })).filter(bucket => Number.isFinite(bucket.mid) && bucket.mid > 0);
  return { market, price: markPrice, asOfMs, buckets };
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

function formatMarketLine(market, window, periodStart) {
  const first = Number(window?.firstPrice);
  const last = Number(window?.lastPrice);
  if (!window || !Number.isFinite(first) || !Number.isFinite(last) || first <= 0 || last <= 0) {
    return `<b>${market}</b> — недостаточно данных за 5m\n<a href="${marketLink(market, periodStart)}">Polymarket ${market} 5m</a>`;
  }
  const delta = last - first;
  const pct = delta / first * 100;
  const trend = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const buckets = Array.isArray(window.buckets) ? window.buckets : [];
  const candidateClusters = buckets.map(bucket => {
    const level = bucket.mid;
    const distancePercent = Math.abs(level - last) / last * 100;
    const above = level > last;
    const notional = trend === 'up' ? bucket.shortNotional : bucket.longNotional;
    const correctSide = trend === 'up' ? above : level < last;
    return { ...bucket, level, distancePercent, notional, correctSide };
  }).filter(cluster => trend !== 'flat' && cluster.correctSide && cluster.distancePercent <= CLUSTER_MAX_DISTANCE_PERCENT && cluster.notional > 0)
    .sort((a, b) => a.distancePercent - b.distancePercent);
  const cluster = candidateClusters[0];
  const confirmed = Boolean(cluster);
  const arrow = confirmed ? (trend === 'up' ? '⬆️' : '⬇️') : '↔️';
  const direction = confirmed ? (trend === 'up' ? 'LONG ПОДТВЕРЖДЁН' : 'SHORT ПОДТВЕРЖДЁН') : 'НЕТ ПОДТВЕРЖДЕНИЯ';
  const clusterLine = cluster
    ? `Кластер ${trend === 'up' ? 'SHORT выше' : 'LONG ниже'}: ${priceText(cluster.level)} (дистанция ${cluster.distancePercent.toFixed(3)}%, объём ${usdText(cluster.notional)})`
    : `Нет подходящего кластера в пределах ${CLUSTER_MAX_DISTANCE_PERCENT}% для подтверждения движения`;
  return [
    `<b>${market} ${arrow} ${direction}</b>`,
    `Цена 5m: ${priceText(first)} → ${priceText(last)} (${percentText(pct)})`,
    clusterLine,
    `<a href="${marketLink(market, periodStart)}">Polymarket ${market} 5m</a>`,
  ].join('\n');
}

async function finishPeriod(periodStart, window) {
  if (!window || window.alerted || window.partial === true) return;
  const hasAnyPrice = ['BTC', 'ETH'].some(market => {
    const first = Number(window[market]?.firstPrice);
    const last = Number(window[market]?.lastPrice);
    return Number.isFinite(first) && Number.isFinite(last) && first > 0 && last > 0;
  });
  if (!hasAnyPrice) {
    window.alerted = true;
    console.warn(JSON.stringify({
      level: 'warn', event: 'liquidation_direction_alert_skipped_no_prices', version: VERSION,
      periodStart: new Date(periodStart * 1000).toISOString(),
      periodEnd: new Date((periodStart + PERIOD_SECONDS) * 1000).toISOString(),
      reason: 'No valid BTC or ETH markPrice snapshots were recorded for this period',
    }));
    return;
  }
  const start = new Date(periodStart * 1000).toISOString().slice(11, 16);
  const end = new Date((periodStart + PERIOD_SECONDS) * 1000).toISOString().slice(11, 16);
  await send([
    formatMarketLine('BTC', window.BTC, periodStart),
    '',
    formatMarketLine('ETH', window.ETH, periodStart),
  ].join('\n'));
  window.alerted = true;
  console.log(JSON.stringify({
    level: 'info', event: 'liquidation_direction_alert_sent', version: VERSION,
    periodStart: new Date(periodStart * 1000).toISOString(),
    periodEnd: new Date((periodStart + PERIOD_SECONDS) * 1000).toISOString(),
    prices: Object.fromEntries(['BTC', 'ETH'].map(m => [m, {
      first: window[m]?.firstPrice ?? null,
      last: window[m]?.lastPrice ?? null,
    }])),
  }));
}

async function poll() {
  const now = Math.floor(Date.now() / 1000);
  const currentStart = periodStartFor(now);
  const snapshots = {};
  const errors = {};
  for (const market of ['BTC', 'ETH']) {
    try {
      snapshots[market] = await fetchHeatmap(market);
    } catch (error) {
      errors[market] = error instanceof Error ? error.message : String(error);
      console.warn(JSON.stringify({ level: 'warn', event: 'heatmap_fetch_failed', market, message: errors[market].slice(0, 240) }));
    }
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
          buckets: snapshots[market].buckets,
        };
      }
    }
    saveState();
    console.log(JSON.stringify({ level: 'info', event: 'liquidation_direction_baseline_set', version: VERSION, periodStart: new Date(currentStart * 1000).toISOString(), prices: Object.fromEntries(Object.entries(snapshots).map(([m, s]) => [m, s.price])) }));
    if (Object.keys(errors).length) throw new Error(Object.values(errors).join('; '));
    return;
  }

  const previousStart = Number(state.currentPeriod);
  if (currentStart !== previousStart) {
    const previous = state.windows[String(previousStart)];
    if (previousStart === currentStart - PERIOD_SECONDS && previous && !previous.alerted) await finishPeriod(previousStart, previous);
    state.currentPeriod = currentStart;
    state.windows[String(currentStart)] = { periodStart: currentStart, BTC: null, ETH: null, alerted: false, partial: false };
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
    level: 'info', event: 'liquidation_direction_snapshot', version: VERSION,
    source: 'papertrade liquidation heatmap markPrice', pollMs: POLL_MS,
    periodStart: new Date(currentStart * 1000).toISOString(),
    prices: Object.fromEntries(['BTC', 'ETH'].map(m => [m, snapshots[m]?.price ?? null])),
    errors,
  }));
  if (Object.keys(errors).length) throw new Error(Object.values(errors).join('; '));
}

console.log(JSON.stringify({
  level: 'info', event: 'liquidation_direction_monitor_started', version: VERSION,
  source: HEATMAP_URL, pollMs: POLL_MS, periodSeconds: PERIOD_SECONDS,
  statePath: STATE_PATH, alert: 'one Telegram message after each completed 5-minute period; arrow only when 5m price direction is confirmed by a nearby matching liquidation cluster (within 0.5%)',
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
        level: 'error', event: 'liquidation_direction_poll_failed',
        consecutiveFailures, message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      }));
    }
    await sleep(Math.max(0, POLL_MS - (Date.now() - started)));
  }
}
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
loop();
