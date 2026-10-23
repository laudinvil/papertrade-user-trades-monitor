import fs from "node:fs/promises";
import path from "node:path";

const LEADERBOARD_URL = "https://sharkradar.app/polymarket-leaderboard";
const ACTIVITY_URL = "https://data-api.polymarket.com/activity";
const POLL_MS = Math.max(30_000, Number(process.env.SHARK_RADAR_POLL_MS || 60_000));
const STATE_PATH = process.env.SHARK_RADAR_STATE_PATH || "/data/shark-radar-state.json";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const VERSION = "shark-radar-standalone-10-compact-logs";

if (!BOT_TOKEN || !CHAT_ID) throw new Error("Shark Radar: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set.");

async function request(url, accept = "*/*") {
  // Normalize accidental whitespace/newlines before making the HTTP request.
  url = String(url).trim();
  const maxRetries = 4;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 SharkRadarLeaderMonitor/1.0", accept },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return res;
    if ([429, 500, 502, 503, 504].includes(res.status) && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(120_000, retryAfter * 1000)
        : Math.min(60_000, 5_000 * (2 ** attempt));
      console.warn(JSON.stringify({
        level: "warn", event: "shark_radar_upstream_retry",
        status: res.status, url, attempt: attempt + 1, maxRetries,
        retryInMs: waitMs,
      }));
      await res.body?.cancel().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, waitMs));
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
}
function decode(s) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
async function getLeader() {
  const html = await (await request(LEADERBOARD_URL, "text/html")).text();
  const links = [...html.matchAll(/<a\b[^>]*href=["'](?:https:\/\/sharkradar\.app)?\/wallet\/(0x[a-fA-F0-9]{40})["'][^>]*>([\s\S]*?)<\/a>/gi)];
  if (!links.length) throw new Error("No wallet address found in Shark Radar leaderboard HTML; refusing to guess the leader.");
  const first = links[0];
  const wallet = first[1].toLowerCase();
  const name = decode(first[2].replace(/<[^>]*>/g, "").trim()) || wallet;
  return { wallet, name, url: `https://sharkradar.app/wallet/${wallet}` };
}
async function getActivity(wallet) {
  const url = new URL(ACTIVITY_URL);
  url.searchParams.set("user", wallet);
  url.searchParams.set("limit", "50");
  url.searchParams.set("sortBy", "TIMESTAMP");
  url.searchParams.set("sortDirection", "DESC");
  const data = await (await request(url, "application/json")).json();
  if (!Array.isArray(data)) throw new Error("Polymarket activity API returned a non-array response.");
  return data;
}
function idOf(a) {
  return String(a.transactionHash || a.id || [a.timestamp, a.conditionId, a.side, a.asset, a.size, a.price].join(":"));
}
function eventUrlOf(a) {
  // `slug` may identify a market rather than its parent event; prefer explicit eventSlug.
  const slug = a.eventSlug || a.event_slug || a.event?.slug;
  if (typeof slug === "string" && slug.trim()) return `https://polymarket.com/event/${encodeURIComponent(slug.trim())}`;
  const direct = a.eventUrl || a.event_url || a.event?.url;
  if (typeof direct === "string" && /^https:\/\/polymarket\.com\/event\/[a-zA-Z0-9_-]+\/?$/.test(direct)) return direct;
  // Keep the market slug visible as a search query rather than emit a broken event URL.
  const marketSlug = a.slug || a.marketSlug || a.market_slug;
  return typeof marketSlug === "string" && marketSlug.trim()
    ? `https://polymarket.com/search?_q=${encodeURIComponent(marketSlug.trim())}`
    : "https://polymarket.com";
}
function marketKeyOf(a) {
  const market = String(a.title || a.market || a.slug || a.marketSlug || a.market_slug || "").trim();
  return market.toLocaleLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, " ").trim();
}
function tradeMessage(a, leader) {
  const action = String(a.side || a.type || "TRADE").toUpperCase();
  const market = a.title || a.market || a.slug || "Polymarket market";
  const outcome = a.outcome ? ` / ${a.outcome}` : "";
  const size = Number(a.size), price = Number(a.price);
  const value = Number.isFinite(size) && Number.isFinite(price) ? `\nValue: $${(size * price).toFixed(2)}` : "";
  const when = a.timestamp ? new Date(Number(a.timestamp) * 1000).toISOString() : "unknown";
  const marketUrl = eventUrlOf(a);
  return `SHARK RADAR\nTrader: ${leader.name}\nWallet: ${leader.wallet}\nAction: ${action}${outcome}\nMarket: ${market}${value}\nTime: ${when}\n${marketUrl}\nProfile: ${leader.url}`;
}
async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(20_000),
  });
  const result = await res.json().catch(() => ({}));
  if (!res.ok || !result.ok) throw new Error(`Telegram send failed: HTTP ${res.status} ${JSON.stringify(result).slice(0, 250)}`);
}
async function loadState() {
  try { return JSON.parse(await fs.readFile(STATE_PATH, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return {}; throw e; }
}
async function saveState(state) {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, STATE_PATH);
}
async function poll(state) {
  const leader = await getLeader();
  const firstRun = !state.leaderWallet;
  const changed = Boolean(state.leaderWallet && state.leaderWallet !== leader.wallet);
  if (changed) {
    await sendTelegram(`SHARK RADAR — TOP LEADER CHANGED\nTrader: ${leader.name}\nWallet: ${leader.wallet}\nLeaderboard: ${LEADERBOARD_URL}\nProfile: ${leader.url}`);
    console.log(JSON.stringify({ level: "info", event: "leader_changed_alert_sent", previousWallet: state.leaderWallet || null, leader }));
  } else if (firstRun) {
    console.log(JSON.stringify({ level: "info", event: "initial_leader_baseline_only", leader, note: "Initial top-leader alert suppressed to avoid duplicate notification." }));
  }

  const activity = await getActivity(leader.wallet);
  const seen = new Set(Array.isArray(state.seenActivityIds) ? state.seenActivityIds : []);
  const trades = activity.filter(a => String(a.type || "").toUpperCase() === "TRADE" && ["BUY", "SELL"].includes(String(a.side || "").toUpperCase()));
  if (firstRun || changed) {
    // Establish a baseline; do not alert on trades that predate the monitoring of this leader.
    for (const trade of trades) seen.add(idOf(trade));
    state.lastAlertedMarketKey = null;
  } else {
    const fresh = trades.filter(trade => !seen.has(idOf(trade))).reverse();
    for (const trade of fresh) {
      const marketKey = marketKeyOf(trade);
      if (marketKey && marketKey === state.lastAlertedMarketKey) {
        seen.add(idOf(trade));
        continue;
      }
      await sendTelegram(tradeMessage(trade, leader));
      seen.add(idOf(trade));
      if (marketKey) state.lastAlertedMarketKey = marketKey;
      console.log(JSON.stringify({ level: "info", event: "leader_trade_alert_sent", wallet: leader.wallet, activityId: idOf(trade), side: trade.side, eventUrl: eventUrlOf(trade) }));
    }
    for (const trade of trades) seen.add(idOf(trade));
  }
  state.leaderWallet = leader.wallet;
  state.leaderName = leader.name;
  state.seenActivityIds = [...seen].slice(-1000);
  state.updatedAt = new Date().toISOString();
  await saveState(state);
}
async function main() {
  console.log(JSON.stringify({ level: "info", event: "shark_radar_started", version: VERSION, pollMs: POLL_MS, leaderboard: LEADERBOARD_URL, statePath: STATE_PATH }));
  let state = await loadState();
  let lastError = null;
  while (true) {
    try { await poll(state); lastError = null; }
    catch (e) {
      const message = String(e?.message || e);
      if (message !== lastError) {
        console.error(JSON.stringify({ level: "error", event: "shark_radar_poll_failed", message }));
        lastError = message;
      }
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
    state = await loadState();
  }
}
main().catch(e => { console.error(JSON.stringify({ level: "fatal", event: "shark_radar_stopped", message: String(e?.stack || e) })); process.exitCode = 1; });
