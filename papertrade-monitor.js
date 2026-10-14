import fs from 'node:fs';
import path from 'node:path';

const API_BASE = (process.env.PAPERTRADE_API_BASE_URL || 'https://papertrade-ai.ninabrekkerese.workers.dev/api/v1/tools').replace(/\/$/, '');
const POLL_MS = Math.max(5000, Number(process.env.POLL_MS || 5000));
const STATE_PATH = process.env.STATE_PATH || './data/state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const SEEN_LIMIT = 5000;
const FULL_LOSS_PERCENT = -99.5;

if (!BOT_TOKEN || !CHAT_ID) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const esc = v => String(v ?? '—').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const usd = v => v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const num = v => v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 8 });
const percent = v => (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%';

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (s.initialized === true && Array.isArray(s.seenKeys)) {
      return { initialized: true, seenKeys: s.seenKeys.map(String).slice(-SEEN_LIMIT) };
    }
  } catch {}
  return { initialized: false, seenKeys: [] };
}

let state = loadState();
const seen = new Set(state.seenKeys);

function saveState() {
  const next = { initialized: true, seenKeys: [...seen].slice(-SEEN_LIMIT) };
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next));
  fs.renameSync(tmp, STATE_PATH);
  state = next;
  // Keep the in-memory set bounded as well.
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

function lossPercent(event) {
  const pnl = Number(event.pnlUsd);
  const notional = Number(event.notionalUsd);
  const leverage = Number(event.leverage);
  if (!Number.isFinite(pnl) || !Number.isFinite(notional) || notional <= 0 ||
      !Number.isFinite(leverage) || leverage <= 0) return null;
  const margin = notional / leverage;
  if (margin <= 0) return null;
  return pnl / margin * 100;
}

function isFullLossClose(event) {
  if (event.kind !== 'close' && event.kind !== 'liquidation') return false;
  const loss = lossPercent(event);
  return loss !== null && loss <= FULL_LOSS_PERCENT;
}

function alertText(event, loss) {
  const time = Number.isFinite(Number(event.ts)) ? new Date(Number(event.ts)).toISOString() : '—';
  const kind = event.kind === 'liquidation' ? 'LIQUIDATION' : 'CLOSED AT ~−100%';
  const wallet = String(event.wallet || '—');
  return [
    `<b> PAPERTRADE: ${kind}</b>`,
    `Trader: <code>${esc(wallet)}</code>`,
    `Market: <b>${esc(event.instrument)}</b> | Side: <b>${esc(String(event.side || '—').toUpperCase())}</b>`,
    `Leverage: ${esc(event.leverage)}x | Notional: ${esc(usd(event.notionalUsd))}`,
    `Entry: ${esc(num(event.entry))} | Exit: ${esc(num(event.exit))}`,
    `PnL: <b>${esc(usd(event.pnlUsd))}</b> | Margin loss: <b>${esc(percent(loss))}</b>`,
    `Position: <code>${esc(event.positionId)}</code>`,
    `Closed: ${esc(time)}`,
  ].join('\n');
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

  // First poll establishes a baseline so old events do not produce a burst of alerts.
  if (!state.initialized) {
    for (const event of ordered) seen.add(eventKey(event));
    saveState();
    console.log(JSON.stringify({
      level: 'info',
      event: 'baseline_initialized',
      recentEvents: ordered.length,
      trackedEventKeys: seen.size,
    }));
    return;
  }

  let processed = 0;
  let alerts = 0;
  for (const event of ordered) {
    const key = eventKey(event);
    if (seen.has(key)) continue;

    if (isFullLossClose(event)) {
      const loss = lossPercent(event);
      await send(alertText(event, loss));
      alerts++;
      console.log(JSON.stringify({
        level: 'info',
        event: 'full_loss_alert_sent',
        seq: event.seq ?? null,
        wallet: event.wallet ?? null,
        positionId: event.positionId ?? null,
        kind: event.kind,
        lossPercent: Number(loss.toFixed(4)),
      }));
    }
    seen.add(key);
    saveState();
    processed++;
  }

  console.log(JSON.stringify({
    level: 'info',
    event: 'poll_complete',
    recentEvents: ordered.length,
    newlyProcessed: processed,
    alertsSent: alerts,
    trackedEventKeys: seen.size,
  }));
}

console.log(JSON.stringify({
  level: 'info',
  event: 'monitor_started',
  mode: 'closed_trade_full_margin_loss',
  pollMs: POLL_MS,
  thresholdPercent: FULL_LOSS_PERCENT,
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
