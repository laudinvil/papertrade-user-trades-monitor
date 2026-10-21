import fs from "node:fs/promises";

const LEADERBOARD_URL = "https://sharkradar.app/polymarket-leaderboard";
const DATA_API = "https://data-api.polymarket.com/activity";
const POLL_MS = Math.max(30_000, Number(process.env.POLL_MS || 60_000));
const STATE_PATH = process.env.STATE_PATH || "/app/data/shark-radar-state.json";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const VERSION = "shark-radar-standalone-1";

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "SharkRadarLeaderMonitor/1.0" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}
async function fetchJson(url) {
  const res = await fetch(url, { headers: { "user-agent": "SharkRadarLeaderMonitor/1.0", accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}
function decode(s) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
async function getLeader() {
  const html = await fetchText(LEADERBOARD_URL);
  const matches = [...html.matchAll(/<a\b[^>]*href=["'](?:https:\/\/sharkradar\.app)?\/wallet\/(0x[a-fA-F0-9]{40})["'][^>]*>([\s\S]*?)<\/a>/gi)];
  if (!matches.length) throw new Error("Could not find a wallet link in Shark Radar leaderboard HTML");
  const first = matches[0];
  const wallet = first[1].toLowerCase();
  const name = decode(first[2].replace(/<[^>]*>/g, "").trim()) || wallet;
  return { wallet, name, url: `https://sharkradar.app/wallet/${wallet}` };
}
async function getActivity(wallet) {
  const url = new URL(DATA_API);
  url.searchParams.set("user", wallet);
  url.searchParams.set("limit", "30");
  url.searchParams.set("sortBy", "TIMESTAMP");
  url.searchParams.set("sortDirection", "DESC");
  const data = await fetchJson(url);
  if (!Array.isArray(data)) throw new Error("Polymarket activity response was not an array");
  return data;
}
function activityId(a) {
  return String(a.transactionHash || a.id || [a.timestamp, a.conditionId, a.side, a.asset, a.size, a.price].join(":"));
}
function tradeText(a, leader) {
  const side = String(a.side || a.type || "TRADE").toUpperCase();
  const title = a.title || a.market || a.slug || "Polymarket market";
  const outcome = a.outcome ? ` / ${a.outcome}` : "";
  const size = Number(a.size);
  const price = Number(a.price);
  const notional = Number.isFinite(size) && Number.isFinite(price) ? `\nValue: $${(size * price).toFixed(2)}` : "";
  const time = a.timestamp ? new Date(Number(a.timestamp) * 1000).toISOString() : "time unknown";
  const link = a.slug ? `https://polymarket.com/event/${a.slug}` : "https://polymarket.com";
  return `SHARK RADAR — TOP TRADER TRADE\nTrader: ${leader.name}\nAction: ${side}${outcome}\nMarket: ${title}${notional}\nTime: ${time}\n${link}`;
}
async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log(JSON.stringify({ level: "warn", event: "telegram_not_configured", message: "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID" }));
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(20_000)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(`Telegram send failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
}
async function loadState() {
  try { return JSON.parse(await fs.readFile(STATE_PATH, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return {}; throw e; }
}
async function saveState(state) {
  await fs.mkdir(new URL(".", `file://${STATE_PATH}`).pathname, { recursive: true }).catch(async () => {
    const path = await import("node:path");
    await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}
async function cycle(state) {
  const leader = await getLeader();
  const changed = Boolean(state.leaderWallet && state.leaderWallet !== leader.wallet);
  const firstRun = !state.leaderWallet;
  if (changed || firstRun) {
    const message = `SHARK RADAR — ${firstRun ? "INITIAL TOP LEADER" : "TOP LEADER CHANGED"}\nTrader: ${leader.name}\nWallet: ${leader.wallet}\nLeaderboard: ${LEADERBOARD_URL}\nProfile: ${leader.url}`;
    await sendTelegram(message);
    console.log(JSON.stringify({ level: "info", event: firstRun ? "initial_leader" : "leader_changed", previousWallet: state.leaderWallet || null, leader }));
  }

  const activity = await getActivity(leader.wallet);
  const seen = new Set(Array.isArray(state.seenActivityIds) ? state.seenActivityIds : []);
  const newestFirst = activity.slice(0, 30);
  const eligible = newestFirst.filter(a => String(a.type || "").toUpperCase() === "TRADE" && (a.side === "BUY" || a.side === "SELL"));
  if (firstRun || changed) {
    // Establish a baseline for the new leader; do not send historical activity as new trades.
    for (const a of eligible) seen.add(activityId(a));
  } else {
    const fresh = eligible.filter(a => !seen.has(activityId(a))).reverse();
    for (const a of fresh) {
      await sendTelegram(tradeText(a, leader));
      seen.add(activityId(a));
      console.log(JSON.stringify({ level: "info", event: "leader_trade_alert_sent", leader: leader.wallet, activityId: activityId(a), side: a.side }));
    }
    // If activity is briefly reordered, retain the newest IDs without growing state indefinitely.
    for (const a of eligible) seen.add(activityId(a));
  }
  state.leaderWallet = leader.wallet;
  state.leaderName = leader.name;
  state.seenActivityIds = [...seen].slice(-500);
  state.updatedAt = new Date().toISOString();
  await saveState(state);
  console.log(JSON.stringify({ level: "info", event: "shark_radar_poll_ok", leader: leader.wallet, leaderName: leader.name, activityCount: activity.length, tradeCount: eligible.length, changed, firstRun }));
}

async function main() {
  console.log(JSON.stringify({ level: "info", event: "shark_radar_started", version: VERSION, pollMs: POLL_MS, leaderboard: LEADERBOARD_URL, statePath: STATE_PATH }));
  let state = await loadState();
  while (true) {
    try {
      await cycle(state);
    } catch (e) {
      console.error(JSON.stringify({ level: "error", event: "shark_radar_poll_failed", message: String(e?.stack || e) }));
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
    try { state = await loadState(); } catch (e) { console.error(JSON.stringify({ level: "error", event: "state_read_failed", message: String(e) })); }
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
