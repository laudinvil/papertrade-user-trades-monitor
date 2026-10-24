import fs from 'node:fs';
import path from 'node:path';

const API_BASE = (process.env.PAPERTRADE_API_BASE_URL || 'https://papertrade-ai.ninabrekkerese.workers.dev/api/v1/tools').replace(/\/+$/, '');
const POLL_MS = Math.max(30_000, Number(process.env.POLL_MS || 60_000));
const STATE_PATH = process.env.STATE_PATH || '/data/profitable-traders-state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const LEADERBOARD_WINDOW = process.env.LEADERBOARD_WINDOW || '7d';
const CANDIDATE_LIMIT = Math.min(25, Math.max(5, Number(process.env.CANDIDATE_LIMIT || 10)));
const HISTORY_PAGES = Math.min(10, Math.max(1, Number(process.env.HISTORY_PAGES || 4)));
const MIN_CLOSED_TRADES = Math.max(10, Number(process.env.MIN_CLOSED_TRADES || 50));
const MIN_WIN_RATE = Math.min(1, Math.max(0, Number(process.env.MIN_WIN_RATE || 0.55)));
const MIN_PROFIT_FACTOR = Math.max(1, Number(process.env.MIN_PROFIT_FACTOR || 1.3));
const SEEN_LIMIT = 5000;
const VERSION = 'papertrade-profitable-traders-scanner-v1';

if (!BOT_TOKEN || !CHAT_ID) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const esc = value => String(value ?? '—').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const money = value => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n < 0 ? '-$' : '$'}${Math.abs(n).toFixed(2)}`;
};
const shortWallet = wallet => wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : 'unknown';

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (saved.version !== 1) throw new Error('unsupported state version');
    return {
      initialized: saved.initialized === true,
      seenEvents: Array.isArray(saved.seenEvents) ? saved.seenEvents.map(String).slice(-SEEN_LIMIT) : [],
      qualified: saved.qualified && typeof saved.qualified === 'object' ? saved.qualified : {},
      alertedQualified: Array.isArray(saved.alertedQualified) ? saved.alertedQualified.map(String) : [],
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { initialized: false, seenEvents: [], qualified: {}, alertedQualified: [] };
    throw new Error(`Cannot load scanner state at ${STATE_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let state = loadState();
const seenEvents = new Set(state.seenEvents);
const alertedQualified = new Set(state.alertedQualified);

function saveState() {
  const next = {
    version: 1,
    initialized: state.initialized,
    seenEvents: [...seenEvents].slice(-SEEN_LIMIT),
    qualified: state.qualified,
    alertedQualified: [...alertedQualified],
    savedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const temp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next));
  fs.renameSync(temp, STATE_PATH);
  state = next;
  if (seenEvents.size > SEEN_LIMIT) {
    seenEvents.clear();
    for (const key of next.seenEvents) seenEvents.add(key);
  }
}

async function callTool(name, args = {}) {
  const url = `${API_BASE}/${name}`;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok !== true) {
        throw new Error(`Papertrade ${name} HTTP ${response.status}: ${body?.error?.message || 'request failed'}`);
      }
      return body.data ?? {};
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error(`Papertrade ${name} failed after 3 attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
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

function eventKey(event) {
  if (event?.seq != null) return `seq:${event.seq}`;
  return [String(event?.wallet || '').toLowerCase(), String(event?.positionId ?? ''), String(event?.intentId ?? ''), String(event?.kind ?? ''), String(event?.ts ?? '')].join(':');
}
function walletKey(wallet) { return String(wallet || '').toLowerCase(); }

function analyzeTrades(trades) {
  const closed = (Array.isArray(trades) ? trades : []).filter(t => Number.isFinite(Number(t?.pnlUsd)) && Number.isFinite(Number(t?.feeUsd)));
  const results = closed.map(trade => ({ trade, net: Number(trade.pnlUsd) - Number(trade.feeUsd), closedAt: Date.parse(trade.closedAt || '') || 0 }));
  const wins = results.filter(x => x.net > 0).length;
  const grossProfit = results.reduce((sum, x) => sum + Math.max(0, x.net), 0);
  const grossLoss = results.reduce((sum, x) => sum + Math.max(0, -x.net), 0);
  const netPnl = results.reduce((sum, x) => sum + x.net, 0);
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const item of [...results].sort((a, b) => a.closedAt - b.closedAt)) {
    equity += item.net;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return {
    closedTrades: results.length, netPnl, winRate: results.length ? wins / results.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0),
    maxDrawdown, wins, grossProfit, grossLoss,
  };
}
function qualifies(s) {
  return s.closedTrades >= MIN_CLOSED_TRADES && s.netPnl > 0 && s.winRate >= MIN_WIN_RATE && s.profitFactor >= MIN_PROFIT_FACTOR;
}
function formatStats(s) {
  return [
    `Net PnL: <b>${esc(money(s.netPnl))}</b>`,
    `Closed trades: ${s.closedTrades}`,
    `Win rate: ${(s.winRate * 100).toFixed(1)}%`,
    `Profit factor: ${s.profitFactor >= 999 ? '∞' : s.profitFactor.toFixed(2)}`,
    `Max drawdown: ${esc(money(s.maxDrawdown))}`,
  ].join('\n');
}

async function fetchLeaderboardCandidates() {
  const result = await callTool('get_leaderboard', { window: LEADERBOARD_WINDOW, sortKey: 'totalWindowedPnl', sortDir: 'desc', page: 0 });
  const rows = Array.isArray(result.rows) ? result.rows : [];
  return rows.filter(row => /^0x[0-9a-fA-F]{40}$/.test(String(row.address || '')))
    .sort((a, b) => Number(b.windowPnlUsd || 0) - Number(a.windowPnlUsd || 0)).slice(0, CANDIDATE_LIMIT);
}
async function fetchRecentEvents() {
  const result = await callTool('get_recent_trades');
  return Array.isArray(result.events) ? result.events : [];
}
async function inspectWallet(wallet) {
  const result = await callTool('get_trade_history', { wallet, pages: HISTORY_PAGES });
  return analyzeTrades(result.trades);
}

async function poll() {
  const firstRun = !state.initialized;
  const [recentEvents, leaderboard] = await Promise.all([fetchRecentEvents(), fetchLeaderboardCandidates()]);
  if (firstRun) for (const event of recentEvents) seenEvents.add(eventKey(event));

  const candidates = new Map();
  for (const row of leaderboard) candidates.set(walletKey(row.address), row);
  for (const [wallet, oldStats] of Object.entries(state.qualified)) {
    if (oldStats?.qualified === true && /^0x[0-9a-f]{40}$/.test(wallet)) candidates.set(wallet, candidates.get(wallet) || { address: wallet, name: oldStats.name || null });
  }

  const nextQualified = {};
  const newlyQualified = [];
  let inspected = 0;
  for (const [wallet, row] of candidates) {
    const stats = await inspectWallet(row.address || wallet);
    inspected++;
    await sleep(500);
    if (!qualifies(stats)) continue;
    const name = row.name || row.leaderboardName || null;
    nextQualified[wallet] = { ...stats, qualified: true, name, checkedAt: new Date().toISOString() };
    if (!alertedQualified.has(wallet)) newlyQualified.push({ wallet, name, stats });
  }

  state.qualified = nextQualified;
  if (newlyQualified.length) {
    const lines = newlyQualified.slice(0, 10).map(({ wallet, name, stats }) =>
      `• <a href="https://explorer.hyperEVM.org/address/${wallet}">${esc(name || shortWallet(wallet))}</a> — ${esc(money(stats.netPnl))}, ${stats.closedTrades} trades, win ${(stats.winRate * 100).toFixed(1)}%, PF ${stats.profitFactor >= 999 ? '∞' : stats.profitFactor.toFixed(2)}`);
    await send(`<b>${firstRun ? 'Profitable Papertrade traders found' : 'New profitable Papertrade trader'}</b>\nWindow: ${esc(LEADERBOARD_WINDOW)}\nCriteria: ${MIN_CLOSED_TRADES}+ closed trades, win rate ≥ ${(MIN_WIN_RATE * 100).toFixed(0)}%, PF ≥ ${MIN_PROFIT_FACTOR.toFixed(2)}\n\n${lines.join('\n')}`);
    for (const item of newlyQualified) alertedQualified.add(item.wallet);
  }

  let tradeAlerts = 0;
  for (const event of [...recentEvents].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))) {
    const key = eventKey(event);
    if (seenEvents.has(key)) continue;
    const wallet = walletKey(event.wallet);
    const stats = nextQualified[wallet];
    if (!firstRun && stats && String(event.kind || '').toLowerCase() === 'open') {
      await send([
        '<b>New trade — profitable Papertrade trader</b>',
        `Trader: <a href="https://explorer.hyperEVM.org/address/${wallet}">${esc(stats.name || shortWallet(wallet))}</a>`,
        `Market: ${esc(event.instrument)} ${esc(String(event.side || '').toUpperCase())}`,
        `Leverage: ${esc(event.leverage)}x`,
        `Notional: ${esc(money(event.notionalUsd))}`,
        `Entry: ${esc(event.entry ?? '—')}`,
        'Historical stats (after fees):',
        formatStats(stats),
      ].join('\n'));
      tradeAlerts++;
    }
    seenEvents.add(key);
    saveState();
  }

  state.initialized = true;
  saveState();
  console.log(JSON.stringify({
    level: 'info', event: 'profitable_traders_scan_summary', version: VERSION, pollMs: POLL_MS,
    leaderboardWindow: LEADERBOARD_WINDOW, leaderboardCandidates: leaderboard.length,
    walletsInspected: inspected, qualifiedWallets: Object.keys(nextQualified).length,
    newlyQualified: newlyQualified.length, recentEvents: recentEvents.length, tradeAlerts,
  }));
}

console.log(JSON.stringify({
  level: 'info', event: 'profitable_traders_monitor_started', version: VERSION,
  apiBase: API_BASE, pollMs: POLL_MS, leaderboardWindow: LEADERBOARD_WINDOW,
  candidateLimit: CANDIDATE_LIMIT, historyPages: HISTORY_PAGES, minClosedTrades: MIN_CLOSED_TRADES,
  minWinRate: MIN_WIN_RATE, minProfitFactor: MIN_PROFIT_FACTOR, statePath: STATE_PATH,
}));
let stopping = false;
async function loop() {
  while (!stopping) {
    const started = Date.now();
    try { await poll(); }
    catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'profitable_traders_poll_failed', message: error instanceof Error ? error.message : String(error) }));
    }
    await sleep(Math.max(1000, POLL_MS - (Date.now() - started)));
  }
}
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
loop();
