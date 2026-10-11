import fs from 'node:fs';
import path from 'node:path';

const API_URL = process.env.PAPERTRADE_RECENT_TRADES_URL || 'https://papertrade-ai.ninabrekkerese.workers.dev/api/v1/tools/get_recent_trades';
const POLL_MS = Math.max(5000, Number(process.env.POLL_MS || 5000));
const STATE_PATH = process.env.STATE_PATH || './data/state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const BTC_URL = process.env.PAPERTRADE_BTC_URL || '';
const ETH_URL = process.env.PAPERTRADE_ETH_URL || '';
if (!BOT_TOKEN || !CHAT_ID || !BTC_URL || !ETH_URL) throw new Error('Set TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, PAPERTRADE_BTC_URL and PAPERTRADE_ETH_URL.');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const esc = v => String(v ?? '—').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const usd = v => v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const num = v => v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 8 });
function loadState() {
  try { const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); return { initialized: !!s.initialized, seen: Array.isArray(s.seen) ? s.seen.map(String) : [], snapshot: Array.isArray(s.snapshot) ? s.snapshot.map(String) : [] }; }
  catch { return { initialized: false, seen: [], snapshot: [] }; }
}
let state = loadState();
const seen = new Set(state.seen);
function save(snapshot = state.snapshot) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const next = { initialized: state.initialized, seen: [...seen].slice(-5000), snapshot: snapshot.slice(0, 100) };
  const tmp = `${STATE_PATH}.tmp`; fs.writeFileSync(tmp, JSON.stringify(next)); fs.renameSync(tmp, STATE_PATH); state = next;
}
async function recentTrades() {
  const r = await fetch(API_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`API HTTP ${r.status}`);
  const body = await r.json(); const events = body?.data?.events ?? body?.events ?? body?.result?.events;
  if (body?.ok === false || !Array.isArray(events)) throw new Error('Unexpected API response: events array not found');
  return events.filter(e => e?.seq != null && e?.instrument && e?.kind);
}
function eventUrl(e) { return e.instrument === 'BTC' ? BTC_URL : ETH_URL; }
function alertText(e) {
  const kind = ({ open: 'OPEN', close: 'CLOSE', liquidation: 'LIQUIDATION' })[e.kind] || String(e.kind).toUpperCase();
  const time = e.time || (e.ts ? new Date(e.ts).toISOString() : '—');
  const price = e.kind === 'open' ? `Entry: ${num(e.entry)}` : `Exit: ${num(e.exit)}`;
  const pnl = e.kind === 'open' ? '' : `\nPnL: <b>${esc(usd(e.pnlUsd))}</b>`;
  return [`<b>${esc(kind)} ${esc(e.instrument)} ${esc(String(e.side || '—').toUpperCase())}</b>`, `Notional: <b>${esc(usd(e.notionalUsd))}</b>`, `Leverage: ${esc(e.leverage)}x`, price, `Wallet: <code>${esc(e.wallet)}</code>`, `Position: <code>${esc(e.positionId)}</code>`, `Time: ${esc(time)}`, pnl, `<a href="${esc(eventUrl(e))}">Open ${esc(e.instrument)} on Papertrade</a>`].filter(Boolean).join('\n');
}
async function send(text) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }), signal: AbortSignal.timeout(10000) });
  const body = await r.json().catch(() => ({})); if (!r.ok || body.ok !== true) throw new Error(`Telegram HTTP ${r.status}: ${body.description || 'send failed'}`);
}
function ordered(events) { return [...events].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0)); }
async function poll() {
  const events = await recentTrades(); const ids = events.map(e => String(e.seq)); const current = new Set(ids);
  if (!state.initialized) { ids.forEach(id => seen.add(id)); state.initialized = true; save(ids); console.log(JSON.stringify({ level: 'info', event: 'baseline_initialized', returned: events.length })); return; }
  if (state.snapshot.length && !state.snapshot.some(id => current.has(id))) console.warn(JSON.stringify({ level: 'warn', event: 'possible_gap', previousSnapshot: state.snapshot.length, currentSnapshot: ids.length, note: 'No snapshot overlap; API has no confirmed seq cursor.' }));
  const fresh = ordered(events).filter(e => !seen.has(String(e.seq))); let sent = 0;
  for (const e of fresh) {
    try { await send(alertText(e)); seen.add(String(e.seq)); sent++; save(ids); }
    catch (err) { console.error(JSON.stringify({ level: 'error', event: 'alert_failed', seq: String(e.seq), message: err instanceof Error ? err.message : String(err) })); break; }
  }
  save(ids); console.log(JSON.stringify({ level: 'info', event: 'poll_complete', returned: events.length, newEvents: fresh.length, sent }));
}
console.log(JSON.stringify({ level: 'info', event: 'monitor_started', pollMs: POLL_MS }));
while (true) { try { await poll(); } catch (err) { console.error(JSON.stringify({ level: 'error', event: 'poll_failed', message: err instanceof Error ? err.message : String(err) })); } await sleep(POLL_MS); }
