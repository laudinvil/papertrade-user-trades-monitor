import fs from 'node:fs';
import path from 'node:path';

const API_BASE = (process.env.PAPERTRADE_API_BASE_URL || 'https://papertrade-ai.ninabrekkerese.workers.dev/api/v1/tools').replace(/\/$/, '');
const POLL_MS = Math.max(5000, Number(process.env.POLL_MS || 5000));
const STATE_PATH = process.env.STATE_PATH || './data/state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const LEADERBOARD_URL_DESC = 'https://exchange.papertrade.xyz/leaderboard?mode=accounts&sortKey=currentUnrealizedPnl';
const LEADERBOARD_URL_ASC = 'https://exchange.papertrade.xyz/leaderboard?mode=accounts&sortKey=currentUnrealizedPnl&sortDir=asc';
if (!BOT_TOKEN || !CHAT_ID) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const esc = v => String(v ?? '—').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const usd = v => v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const num = v => v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 8 });

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return {
      leadersInitialized: s.leadersInitialized === true,
      leaders: s.leaders && typeof s.leaders === 'object' ? s.leaders : { positive: null, negative: null },
    };
  } catch {
    return { leadersInitialized: false, leaders: { positive: null, negative: null } };
  }
}
let state = loadState();

function saveState(next) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next));
  fs.renameSync(tmp, STATE_PATH);
  state = next;
}

async function apiGet(tool, params = {}) {
  const query = new URLSearchParams(params);
  const url = `${API_BASE}/${tool}?${query.toString()}`;
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`${tool} HTTP ${r.status}`);
  const body = await r.json();
  if (body?.ok !== true || !body?.data) throw new Error(`${tool} returned an unexpected response`);
  return body.data;
}

async function getLeader(sortDir) {
  const data = await apiGet('get_leaderboard', {
    window: '24h',
    sortKey: 'currentUnrealizedPnl',
    sortDir,
    page: '0',
  });
  if (!Array.isArray(data.rows)) throw new Error('Leaderboard response has no data.rows array');
  const row = data.rows[0];
  if (!row) return null;
  const pnl = Number(row.unrealizedPnlUsd);
  if (!Number.isFinite(pnl)) throw new Error('Leaderboard leader has invalid unrealizedPnlUsd');
  if (sortDir === 'desc' && pnl <= 0) return null;
  if (sortDir === 'asc' && pnl >= 0) return null;
  return {
    address: String(row.address).toLowerCase(),
    name: row.name || null,
    pnl,
  };
}

async function getAccount(address) {
  const data = await apiGet('get_account', { wallet: address });
  return {
    wallet: data.wallet || address,
    unrealizedPnlUsd: Number(data.unrealizedPnlUsd),
    openPositions: Array.isArray(data.openPositions) ? data.openPositions : [],
  };
}

function positionLines(positions) {
  if (!positions.length) return ['Open positions: none'];
  return [
    `Open positions (${positions.length}):`,
    ...positions.map((p, i) =>
      `${i + 1}. <b>${esc(p.market)} ${esc(String(p.side || '—').toUpperCase())}</b> | ${esc(p.leverage)}x` +
      `\nMargin: ${esc(usd(p.marginUsd))} | Notional: ${esc(usd(p.notionalUsd))}` +
      `\nEntry: ${esc(num(p.entryPrice))} | Mark: ${esc(num(p.markPrice))}` +
      `\nuPnL: <b>${esc(usd(p.estimatedNetPnlUsd))}</b> | Bust: ${esc(num(p.bustPrice)}`
    ),
  ];
}

function alertText(kind, leader, account) {
  const isPositive = kind === 'positive';
  const title = isPositive ? 'MAX POSITIVE uPnL LEADER CHANGED' : 'MAX NEGATIVE uPnL LEADER CHANGED';
  const link = isPositive ? LEADERBOARD_URL_DESC : LEADERBOARD_URL_ASC;
  const identity = leader ? (leader.name ? `${esc(leader.name)} (${esc(leader.address)})` : esc(leader.address)) : 'No account currently has uPnL in this category';
  const lines = [
    `<b>${title}</b>`,
    `Leader: ${identity}`,
    `Leaderboard uPnL: <b>${esc(leader ? usd(leader.pnl) : '—')}</b>`,
  ];
  if (account) {
    lines.push(`Account total uPnL: <b>${esc(usd(account.unrealizedPnlUsd))}</b>`);
    lines.push(...positionLines(account.openPositions));
  }
  lines.push(`<a href="${link}">Open sorted leaderboard</a>`);
  return lines.join('\n');
}

async function send(message) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(12000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.ok !== true) throw new Error(`Telegram HTTP ${r.status}: ${body.description || 'send failed'}`);
}

async function processLeader(kind, nextLeader, previousLeader) {
  const changed = (nextLeader?.address || null) !== (previousLeader?.address || null);
  if (!changed) return false;

  let account = null;
  if (nextLeader) account = await getAccount(nextLeader.address);
  await send(alertText(kind, nextLeader, account));
  return true;
}

async function poll() {
  const [positive, negative] = await Promise.all([getLeader('desc'), getLeader('asc')]);
  const nextLeaders = { positive, negative };

  if (!state.leadersInitialized) {
    saveState({ leadersInitialized: true, leaders: nextLeaders });
    console.log(JSON.stringify({
      level: 'info',
      event: 'leaderboard_baseline_initialized',
      positive: positive ? { address: positive.address, pnl: positive.pnl } : null,
      negative: negative ? { address: negative.address, pnl: negative.pnl } : null,
    }));
    return;
  }

  const changes = [];
  for (const kind of ['positive', 'negative']) {
    const previousLeader = state.leaders[kind] || null;
    const nextLeader = nextLeaders[kind];
    if ((nextLeader?.address || null) !== (previousLeader?.address || null)) {
      changes.push({ kind, previousLeader, nextLeader });
    }
  }

  // Do not advance stored leaders until every changed-leader alert has been delivered.
  for (const change of changes) {
    await processLeader(change.kind, change.nextLeader, change.previousLeader);
  }
  saveState({ leadersInitialized: true, leaders: nextLeaders });
  console.log(JSON.stringify({
    level: 'info',
    event: 'leaderboard_poll_complete',
    positive: positive ? { address: positive.address, pnl: positive.pnl } : null,
    negative: negative ? { address: negative.address, pnl: negative.pnl } : null,
    changed: changes.map(c => c.kind),
  }));
}

console.log(JSON.stringify({ level: 'info', event: 'monitor_started', mode: 'unrealized_pnl_leaders', pollMs: POLL_MS }));
while (true) {
  try {
    await poll();
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', event: 'poll_failed', message: err instanceof Error ? err.message : String(err) }));
  }
  await sleep(POLL_MS);
}
