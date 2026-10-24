import fs from 'node:fs';
import path from 'node:path';

const API_URL = (process.env.PAPERTRADE_API_URL || 'https://exchange.papertrade.xyz').replace(/\/+$/, '');
const POLL_MS = Math.max(2000, Number(process.env.POLL_MS || 2000));
const STATE_PATH = process.env.STATE_PATH || '/data/state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const WINDOW_MS = 5 * 60 * 1000;
const SEEN_LIMIT = 5000;
const MONITOR_VERSION = 'papertrade-api-only-cascade0-series0-v15-retry-alert-send-log-liq-pnl';
const SUMMARY_LOG_MS = 60_000;
let lastSummaryLogAt = 0;

if (!BOT_TOKEN || !CHAT_ID) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const esc = v => String(v ?? '—').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    const valid = s.sourceVersion === 1;
    return {
      initialized: valid && s.initialized === true,
      seenKeys: valid && Array.isArray(s.seenKeys) ? s.seenKeys.map(String).slice(-SEEN_LIMIT) : [],
      windows: valid && s.windows && typeof s.windows === 'object' ? s.windows : {},
      lastSentAlertPeriodStart: valid && Number.isSafeInteger(s.lastSentAlertPeriodStart) ? s.lastSentAlertPeriodStart : null,
      lastFollowingMarket: valid && s.lastFollowingMarket && typeof s.lastFollowingMarket === 'object' ? s.lastFollowingMarket : {},
    };
  } catch (err) {
    if (err?.code === 'ENOENT') return { initialized: false, seenKeys: [], windows: {}, lastSentAlertPeriodStart: null };
    throw new Error(`Cannot load persisted monitor state at ${STATE_PATH}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let state = loadState();
state.lastFollowingMarket ||= {};
const seen = new Set(state.seenKeys);
const windows = state.windows;

function saveState() {
  const next = {
    sourceVersion: 1,
    initialized: true,
    seenKeys: [...seen].slice(-SEEN_LIMIT),
    windows,
    lastSentAlertPeriodStart: state.lastSentAlertPeriodStart ?? null,
    lastFollowingMarket: state.lastFollowingMarket || {},
  };
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next));
  fs.renameSync(tmp, STATE_PATH);
  state = next;
  if (seen.size > SEEN_LIMIT) {
    seen.clear();
    for (const key of state.seenKeys) seen.add(key);
  }
}

async function fetchRecentTrades() {
  const url = `${API_URL}/query/protocol/trades/recent`;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`Papertrade HTTP ${response.status}`);
      }
      const body = await response.json();
      if (body?.ok !== true || !Array.isArray(body.events)) {
        throw new Error('Papertrade API response schema invalid');
      }
      return body.events;
    } catch (err) {
      lastError = err;
      if (attempt < 2) await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error(`Papertrade request failed after 3 attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function eventIdentity(e) {
  // Position IDs are protocol-wide unique. Instrument is included as a defensive namespace.
  return `${String(e.instrumentId)}:${String(e.positionId)}`;
}

function instrumentSymbol(e) {
  const symbol = String(e.instrument || '').toUpperCase();
  if (symbol === 'BTC' || symbol === 'ETH') return symbol;
  if (Number(e.instrumentId) === 0) return 'BTC';
  if (Number(e.instrumentId) === 1) return 'ETH';
  return null;
}

function getWindow(start, instrument) {
  const key = `${start}:${instrument}`;
  if (!windows[key]) {
    windows[key] = {
      start, instrument, total: 0, long: 0, short: 0, unknownSide: 0,
      positionKeys: [], timestamps: [], alerted: false,
    };
  }
  return windows[key];
}

function cascadeStats(bucket) {
  const timestamps = (bucket.timestamps || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  let run = 0, series = 0, maxCascade = 0;
  for (let i = 0; i < timestamps.length; i++) {
    if (i === 0 || timestamps[i] - timestamps[i - 1] <= 1000) run++;
    else {
      if (run >= 2) { series++; maxCascade = Math.max(maxCascade, run); }
      run = 1;
    }
  }
  if (run >= 2) { series++; maxCascade = Math.max(maxCascade, run); }
  return { series, maxCascade };
}

function alertText(bucket) {
  const instrument = bucket.instrument;
  const startSeconds = Math.floor(Number(bucket.start) / 1000);
  const nextUrl = `https://polymarket.com/event/${instrument.toLowerCase()}-updown-5m-${startSeconds + 300}`;
  const followingUrl = `https://polymarket.com/event/${instrument.toLowerCase()}-updown-5m-${startSeconds + 600}`;
  const timestamps = (bucket.timestamps || []).map(Number).filter(Number.isFinite);
  const span = timestamps.length > 1 ? Math.round((Math.max(...timestamps) - Math.min(...timestamps)) / 1000) : 0;
  const seconds = new Set(timestamps.map(ts => Math.floor(ts / 1000))).size;
  const cascade = cascadeStats(bucket);
  return [
    `<b>${esc(instrument)} 5m</b>`,
    `LIQS: ${bucket.total}`,
    `LONG: ${bucket.long}`,
    `SHORT: ${bucket.short}`,

    `SECONDS: ${seconds}`,
    `LIQ SPAN: ${span}s`,
    `CASCADE: ${cascade.maxCascade}`,
    `SERIES: ${cascade.series}`,
    `<a href="${nextUrl}">Начинающийся маркет</a>`,
    `<a href="${followingUrl}">Следующий маркет</a>`,
  ].join(String.fromCharCode(10));
}

async function send(message) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) throw new Error(`Telegram HTTP ${response.status}: ${body.description || 'send failed'}`);
}

async function poll() {
  const events = await fetchRecentTrades();
  const now = Date.now();
  const currentStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;

  // First run establishes a clean baseline. Do not send alerts for history accumulated before startup.
  if (!state.initialized) {
    for (const e of events) {
      if (['liq', 'liquidation'].includes(String(e?.kind ?? e?.type ?? e?.eventType ?? '').trim().toLowerCase()) && e.positionId != null) seen.add(eventIdentity(e));
    }
    saveState();
    console.log(JSON.stringify({
      level: 'info', event: 'liquidation_baseline_initialized',
      source: 'Papertrade SDK recentTrades endpoint', receivedRecentEvents: events.length,
      preexistingLiquidationsBaselined: seen.size,
    }));
    return;
  }

  let newlyConfirmed = 0;
  let ignoredNonLiquidations = 0;
  const liquidationSkipReasons = { already_seen: 0, missing_position_id: 0, invalid_fields: 0, future_period: 0, already_in_window: 0 };
  const liquidationSamples = [];
  const recordLiq = (e, reason) => {
    liquidationSkipReasons[reason]++;
    if (liquidationSamples.length < 10) liquidationSamples.push({ reason, seq: e.seq ?? null, ts: e.ts ?? null, positionId: e.positionId ?? null, instrument: e.instrument ?? null, instrumentId: e.instrumentId ?? null, side: e.side ?? null });
  };
  const kindCounts = {};
  const eventShapeSamples = [];
  for (const e of events) {
    const kind = String(e?.kind ?? e?.type ?? e?.eventType ?? '(missing)').trim().toLowerCase();
    kindCounts[kind] = (kindCounts[kind] || 0) + 1;
    // Capture actual API fields from ordinary open/close events to diagnose whether
    // liquidation metadata is present under a different field name.
    if (eventShapeSamples.length < 5 || (['liq', 'liquidation'].includes(kind) && eventShapeSamples.filter(s => ['liq', 'liquidation'].includes(String(s.kind ?? s.type ?? s.eventType ?? '').toLowerCase())).length < 5)) {
      eventShapeSamples.push({
        keys: Object.keys(e || {}),
        kind: e?.kind ?? null,
        type: e?.type ?? null,
        eventType: e?.eventType ?? null,
        seq: e?.seq ?? null,
        ts: e?.ts ?? null,
        positionId: e?.positionId ?? null,
        instrument: e?.instrument ?? null,
        side: e?.side ?? null,
        entry: e?.entry ?? null,
        exit: e?.exit ?? null,
        pnlUsd: e?.pnlUsd ?? null,
        intentId: e?.intentId ?? null,
      });
    }
  }
  for (const e of events) {
    // This API includes opens, ordinary closes and liquidations. Only its explicit liquidation kind is authoritative.
    if (!['liq', 'liquidation'].includes(String(e?.kind ?? e?.type ?? e?.eventType ?? '').trim().toLowerCase())) {
      ignoredNonLiquidations++;
      continue;
    }
    if (e.positionId == null) { recordLiq(e, 'missing_position_id'); continue; }
    const key = eventIdentity(e);
    if (seen.has(key)) { recordLiq(e, 'already_seen'); continue; }

    const instrument = instrumentSymbol(e);
    const ts = Number(e.ts);
    if (!instrument || !Number.isFinite(ts) || ts <= 0) {
      recordLiq(e, 'invalid_fields');
      seen.add(key);
      continue;
    }
    // Retain the just-closed window briefly so the first poll after a 5-minute boundary can still capture it.
    const eventPeriodStart = Math.floor(ts / WINDOW_MS) * WINDOW_MS;
    if (eventPeriodStart > currentStart) {
      recordLiq(e, 'future_period');
      seen.add(key);
      continue;
    }

    const bucket = getWindow(eventPeriodStart, instrument);
    if (bucket.positionKeys.includes(key)) {
      recordLiq(e, 'already_in_window');
      seen.add(key);
      continue;
    }
    bucket.positionKeys.push(key);
    bucket.timestamps.push(ts);
    bucket.total++;
    const side = String(e.side || '').toLowerCase();
    if (side === 'long') bucket.long++;
    else if (side === 'short') bucket.short++;
    else bucket.unknownSide++;
    seen.add(key);
    newlyConfirmed++;
  }
  saveState();

  let alertsSent = 0;
  const completed = Object.values(windows)
    .filter(b => Number(b.start) + WINDOW_MS <= now && b.alerted !== true)
    .sort((a, b) => Number(a.start) - Number(b.start));

  for (const bucket of completed) {
    const cascade = cascadeStats(bucket);
    // Only alert when there are liquidations but both cascade and series are zero.
    // All other completed windows are marked handled and ignored.
    if (bucket.total <= 0 || cascade.maxCascade !== 0 || cascade.series !== 0) {
      bucket.alerted = true;
      saveState();
      console.log(JSON.stringify({
        level: 'info', event: 'liquidation_alert_ignored_by_cascade_series_filter',
        instrument: bucket.instrument, periodStart: new Date(bucket.start).toISOString(),
        liqs: bucket.total, cascade: cascade.maxCascade, series: cascade.series,
      }));
      continue;
    }
    const startSeconds = Math.floor(Number(bucket.start) / 1000);
    const startingMarket = `https://polymarket.com/event/${bucket.instrument.toLowerCase()}-updown-5m-${startSeconds + 300}`;
    if (state.lastFollowingMarket[bucket.instrument] === startingMarket) {
      bucket.alerted = true;
      saveState();
      continue;
    }
    // Do not mark the window handled until Telegram confirms delivery.
    // If sending fails, poll() throws and this window is retried on the next poll.
    await send(alertText(bucket));
    bucket.alerted = true;
    state.lastFollowingMarket[bucket.instrument] = `https://polymarket.com/event/${bucket.instrument.toLowerCase()}-updown-5m-${startSeconds + 600}`;
    saveState();
    alertsSent++;
    console.log(JSON.stringify({
      level: 'info', event: 'liquidation_alert_sent',
      instrument: bucket.instrument, periodStart: new Date(bucket.start).toISOString(),
      confirmedUniqueLiquidations: bucket.total, long: bucket.long, short: bucket.short,
      unknownSide: bucket.unknownSide,
      uniquePositions: bucket.positionKeys.length,
      cascade: cascade.maxCascade,
      series: cascade.series,
      filter: 'LIQS>0,CASCADE=0,SERIES=0',
    }));
  }

  for (const [key, bucket] of Object.entries(windows)) {
    if (bucket.alerted && Number(bucket.start) + WINDOW_MS < now - 60 * 60 * 1000) delete windows[key];
  }
  saveState();

  if (alertsSent > 0 || Date.now() - lastSummaryLogAt >= SUMMARY_LOG_MS) {
    console.log(JSON.stringify({
      level: 'info', event: 'monitor_summary', monitorVersion: MONITOR_VERSION,
      recentEventsReturned: events.length,
      eventKindCounts: kindCounts,
      eventShapeSamples,
      ignoredNonLiquidations,
      skipReasons: liquidationSkipReasons,
      sampleSkippedEvents: liquidationSamples,
      liquidationEventsSkipped: Object.values(liquidationSkipReasons).reduce((sum, count) => sum + count, 0),
      newLiquidations: newlyConfirmed, alertsSent,
    }));
    lastSummaryLogAt = Date.now();
  }
}

console.log(JSON.stringify({
  level: 'info', event: 'monitor_started', monitorVersion: MONITOR_VERSION,
  mode: 'confirmed_protocol_liquidations_only',
  source: 'Papertrade SDK recentTrades endpoint; alerts only when LIQS > 0, CASCADE = 0 and SERIES = 0; deduplicates repeated poll results',
  endpoint: `${API_URL}/query/protocol/trades/recent`,
  pollMs: POLL_MS, periodMs: WINDOW_MS,
  statePath: STATE_PATH,
}));

let lastPollError = null;
while (true) {
  try {
    await poll();
    lastPollError = null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message !== lastPollError) {
      console.error(JSON.stringify({ level: 'error', event: 'poll_failed', message, retryInMs: 5000 }));
      lastPollError = message;
    }
  }
  await sleep(POLL_MS);
}
