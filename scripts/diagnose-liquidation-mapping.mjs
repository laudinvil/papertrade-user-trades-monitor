const KEY = process.env.NODEFLARE_API_KEY;
if (!KEY) throw new Error("NODEFLARE_API_KEY is missing");

const RPC_URL = `https://rpc.nodeflare.app/hl/v1/${KEY}`;
const API_BASE = (process.env.PAPERTRADE_API_BASE_URL || "https://papertrade-ai.ninabrekkerese.workers.dev/api/v1/tools").replace(/\/$/, "");
const CONTRACT = "0x6cd5661646289fb6e65ea5c032310fded797d0a2";
const LIQUIDATED_TOPIC = "0x87902ed2451849f465fc4d36a01d7f5c67b53af12f63ee85d2814a2d582f89bf";
const BLOCK_LOOKBACK = Math.max(20, Math.min(500, Number(process.env.DIAG_BLOCK_LOOKBACK || 100)));

async function rpc(method, params = []) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message || JSON.stringify(body.error)}`);
  return body.result;
}

async function recentEvents() {
  const response = await fetch(`${API_BASE}/get_recent_trades`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`get_recent_trades HTTP ${response.status}`);
  const body = await response.json();
  if (body?.ok !== true || !Array.isArray(body?.data?.events)) {
    throw new Error("get_recent_trades returned an unexpected response shape");
  }
  return body.data.events;
}

try {
  const [chainId, blockHex, events] = await Promise.all([
    rpc("eth_chainId"),
    rpc("eth_blockNumber"),
    recentEvents(),
  ]);
  if (chainId !== "0x3e7") throw new Error(`Unexpected chainId: ${chainId}`);

  const latestBlock = BigInt(blockHex);
  const fromBlock = latestBlock > BigInt(BLOCK_LOOKBACK) ? latestBlock - BigInt(BLOCK_LOOKBACK) : 0n;
  const logs = await rpc("eth_getLogs", [{
    address: CONTRACT,
    fromBlock: `0x${fromBlock.toString(16)}`,
    toBlock: blockHex,
    topics: [LIQUIDATED_TOPIC],
  }]);

  const chainEvents = logs.map(log => ({
    blockNumber: Number(BigInt(log.blockNumber)),
    transactionHash: log.transactionHash,
    logIndex: Number(BigInt(log.logIndex)),
    positionId: log.topics?.[1] ? BigInt(log.topics[1]).toString() : null,
  }));

  const byPosition = new Map();
  for (const event of events) {
    if (event?.positionId == null) continue;
    const id = String(event.positionId);
    if (!byPosition.has(id)) byPosition.set(id, []);
    byPosition.get(id).push(event);
  }

  const matches = chainEvents.map(onchain => {
    const candidates = byPosition.get(String(onchain.positionId)) || [];
    const exactLiquidation = candidates.filter(e => String(e.kind).toLowerCase() === "liquidation");
    const chosen = exactLiquidation[0] || candidates[0] || null;
    return {
      onchain: {
        blockNumber: onchain.blockNumber,
        transactionHash: onchain.transactionHash,
        logIndex: onchain.logIndex,
        positionId: onchain.positionId,
      },
      apiMatchCount: candidates.length,
      matchedLiquidationEvent: exactLiquidation.length > 0,
      apiEvent: chosen ? {
        seq: chosen.seq ?? null,
        ts: chosen.ts ?? null,
        kind: chosen.kind ?? null,
        instrument: chosen.instrument ?? null,
        instrumentId: chosen.instrumentId ?? null,
        side: chosen.side ?? null,
        positionId: chosen.positionId ?? null,
        hasRequiredFields: Boolean(chosen.kind && chosen.instrument && chosen.side && chosen.ts != null && chosen.positionId != null),
      } : null,
    };
  });

  const matched = matches.filter(m => m.matchedLiquidationEvent && m.apiEvent);
  const withRequiredFields = matched.filter(m => m.apiEvent.hasRequiredFields);
  const apiKindSummary = {};
  for (const event of events) {
    const kind = event?.kind == null ? "(missing)" : String(event.kind);
    apiKindSummary[kind] = (apiKindSummary[kind] || 0) + 1;
  }
  const apiEventSamples = events.slice(0, 10).map(event => ({
    seq: event?.seq ?? null,
    ts: event?.ts ?? null,
    kind: event?.kind ?? null,
    instrument: event?.instrument ?? null,
    instrumentId: event?.instrumentId ?? null,
    side: event?.side ?? null,
    positionId: event?.positionId ?? null,
    keys: event && typeof event === "object" ? Object.keys(event) : [],
  }));
  console.log(JSON.stringify({
    ok: true,
    diagnostic: "liquidation_position_id_mapping",
    chainId,
    contract: CONTRACT,
    latestBlock: blockHex,
    blockRange: { fromBlock: `0x${fromBlock.toString(16)}`, toBlock: blockHex, blocksRequested: Number(latestBlock - fromBlock + 1n) },
    apiEventsReturned: events.length,
    onchainLiquidationsFound: chainEvents.length,
    positionIdMatches: matches.filter(m => m.apiMatchCount > 0).length,
    liquidationKindMatches: matched.length,
    matchesWithInstrumentAndSide: withRequiredFields.length,
    apiKindSummary,
    apiEventSamples,
    positionIdMatchSamples: matches.filter(m => m.apiMatchCount > 0).slice(0, 20),
    samples: matches.slice(0, 10),
    note: "One-shot bounded diagnostic only. It does not change monitor state or send Telegram messages.",
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    diagnostic: "liquidation_position_id_mapping",
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exit(1);
}
