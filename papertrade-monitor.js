import fs from 'node:fs';
import path from 'node:path';

const API_BASE = (process.env.PAPERTRADE_API_BASE_URL || 'https://papertrade-ai.ninabrekkerese.workers.dev/api/v1/tools').replace(/\/$/, '');
const POLL_MS = Math.max(5000, Number(process.env.POLL_MS || 5000));
const STATE_PATH = process.env.STATE_PATH || './data/state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const SEEN_LIMIT = 5000;
const WINDOW_MS = 5 * 60 * 1000;
const MIN_LIQS = 18;

if (!BOT_TOKEN || !CHAT_ID) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const esc = v => String(v ?? '—').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (s.initialized === true && Array.isArray(s.seenKeys)) {
      return {
        initialized: true,
        seenKeys: s.seenKeys.map(String).slice(-SEEN_LIMIT),
        windows: s.windows && typeof s.windows === 'object' ? s.windows : {},
      };
    }
  } catch {}
  return { initialized: false, seenKeys: [], windows: {} };
}

let state = loadState();
const seen = new Set(state.seenKeys);
const windows = state.windows;

function saveState() {
  const next = {
    initialized: true,
    seenKeys: [...seen].slice(-SEEN_LIMIT),
    windows,
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

function eventKey(event) {
  if (event.seq != null) return String(event.seq);
  return [event.wallet, event.positionId, event.kind, event.ts].map(v => String(v ?? '')).join(':');
}

async function getRecentTrades() {
  const response = await fetch(`${API_BASE}/get_recent_trades`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`get_recent_trades HTTP ${response.status}`);
  const body = await response.json();
  if (body?.ok !== true || !Array.isArray(body?.data?.events)) {
    throw new Error('get_recent_trades returned an unexpected response');
  }
  return body.data.events;
}

function eventTimestamp(event) {
  const ts = Number(event.ts);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

function periodStart(ts) {
  return Math.floor(ts / WINDOW_MS) * WINDOW_MS;
}

function instrumentName(event) {
  return String(event.instrument || 'UNKNOWN').trim().toUpperCase();
}

function sideName(event) {
  const side = String(event.side || event.positionSide || '').trim().toUpperCase();
  if (side === 'LONG' || side.includes('LONG')) return 'LONG';
  if (side === 'SHORT' || side.includes('SHORT')) return 'SHORT';
  return null;
}

function getWindow(start, instrument) {
  const key = `${start}:${instrument}`;
  if (!windows[key]) {
    windows[key] = {
      start,
      instrument,
      long: 0,
      short: 0,
      eventKeys: [],
      alerted: false,
    };
  }
  return windows[key];
}

function countLiquidation(event, key, allowSeenCurrentWindow, currentStart) {
  if (event.kind !== 'liquidation') return;
  const ts = eventTimestamp(event);
  if (ts === null) return;
  const start = periodStart(ts);
  if (seen.has(key) && !allowSeenCurrentWindow && start < currentStart) return;

  const instrument = instrumentName(event);
  const bucket = getWindow(start, instrument);
  if (bucket.eventKeys.includes(key)) return;
  bucket.eventKeys.push(key);
  const side = sideName(event);
  if (side === 'LONG') bucket.long++;
  else if (side === 'SHORT') bucket.short++;
}

function alertText(bucket) {
  const start = new Date(bucket.start).toISOString();
  const end = new Date(bucket.start + WINDOW_MS).toISOString();
  return [
    `<b>${esc(bucket.instrument)} 5m</b>`,
    `LIQS: ${bucket.long + bucket.short}`,
    `LONG: ${bucket.long} | SHORT: ${bucket.short}`,
    `Period: ${esc(start)} — ${esc(end)}`,
  ].join('\\n');
}

async function send(message) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(12000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) {
    throw new Error(`Telegram HTTP ${response.status}: ${body.description || 'send failed'}`);
  }
}

async function poll() {
  const events = await getRecentTrades();
  const ordered = [...events].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
  const now = Date.now();
  const currentStart = periodStart(now);

  // First poll establishes a baseline without alerting for already-finished periods.
  if (!state.initialized) {
    for (const event of ordered) {
      const key = eventKey(event);
      seen.add(key);
      const ts = eventTimestamp(event);
      if (event.kind === 'liquidation' && ts !== null && periodStart(ts) === currentStart) {
        countLiquidation(event, key, true, currentStart);
      }
    }
    saveState();
    console.log(JSON.stringify({
      level: 'info',
      event: 'baseline_initialized',
      recentEvents: ordered.length,
      currentPeriodStart: new Date(currentStart).toISOString(),
      trackedEventKeys: seen.size,
    }));
    return;
  }

  let processed = 0;
  for (const event of ordered) {
    const key = eventKey(event);
    const alreadySeen = seen.has(key);
    const ts = eventTimestamp(event);
    const isCurrentWindow = ts !== null && periodStart(ts) === currentStart;

    // Rebuild the active 5-minute window once after upgrading from the old state format.
    if (event.kind === 'liquidation' && (!alreadySeen || isCurrentWindow)) {
      countLiquidation(event, key, isCurrentWindow, currentStart);
    }
    if (!alreadySeen) {
      seen.add(key);
      processed++;
    }
  }

  // Persist counts and deduplication keys before attempting Telegram delivery.
  saveState();

  let alerts = 0;
  for (const [key, bucket] of Object.entries(windows)) {
    if (bucket.alerted || bucket.start + WINDOW_MS > now) continue;
    const total = bucket.long + bucket.short;
    if (total >= MIN_LIQS) {
      await send(alertText(bucket));
      alerts++;
      console.log(JSON.stringify({
        level: 'info',
        event: 'liqs_5m_alert_sent',
        instrument: bucket.instrument,
        periodStart: new Date(bucket.start).toISOString(),
        liqs: total,
        long: bucket.long,
        short: bucket.short,
      }));
    }
    bucket.alerted = true;
    saveState();
  }

  // Keep only recent windows; event deduplication history remains independently bounded.
  for (const [key, bucket] of Object.entries(windows)) {
    if (bucket.start + WINDOW_MS < now - 60 * 60 * 1000) delete windows[key];
  }

  console.log(JSON.stringify({
    level: 'info',
    event: 'poll_complete',
    recentEvents: ordered.length,
    newlyProcessed: processed,
    alertsSent: alerts,
    currentPeriodStart: new Date(currentStart).toISOString(),
    trackedEventKeys: seen.size,
  }));
  saveState();
}

console.log(JSON.stringify({
  level: 'info',
  event: 'monitor_started',
  mode: 'liqs_5m_long_short',
  pollMs: POLL_MS,
  minLiqs: MIN_LIQS,
  periodMs: WINDOW_MS,
  endpoint: 'get_recent_trades',
}));

while (true) {
  try {
    await poll();
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'poll_failed',
      message: err instanceof Error ? err.message : String(err),
    }));
  }
  await sleep(POLL_MS);
}
