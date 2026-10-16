const KEY = process.env.NODEFLARE_API_KEY;
if (!KEY) {
  console.error(JSON.stringify({ ok: false, check: "env", error: "NODEFLARE_API_KEY is missing" }));
  process.exit(1);
}

const RPC_URL = `https://rpc.nodeflare.app/hl/v1/${KEY}`;
const CONTRACT = "0x6cd5661646289fb6e65ea5c032310fded797d0a2";

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

try {
  const chainId = await rpc("eth_chainId");
  if (chainId !== "0x3e7") throw new Error(`Unexpected chainId: ${chainId}`);

  const blockHex = await rpc("eth_blockNumber");
  const block = BigInt(blockHex);
  const code = await rpc("eth_getCode", [CONTRACT, blockHex]);
  if (!code || code === "0x") throw new Error("No contract code at the configured Papertrade address");

  // Small bounded range: validates eth_getLogs access without scanning history.
  const fromBlock = block > 20n ? block - 20n : 0n;
  const logs = await rpc("eth_getLogs", [{
    address: CONTRACT,
    fromBlock: `0x${fromBlock.toString(16)}`,
    toBlock: blockHex,
  }]);
  if (!Array.isArray(logs)) throw new Error("eth_getLogs returned a non-array result");

  const byTopic = new Map();
  for (const log of logs) {
    const topic = log.topics?.[0] || "NO_TOPIC";
    if (!byTopic.has(topic)) byTopic.set(topic, { count: 0, sample: null });
    const item = byTopic.get(topic);
    item.count++;
    if (!item.sample) {
      item.sample = {
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        topics: log.topics,
        data: log.data,
      };
    }
  }

  console.log(JSON.stringify({
    ok: true,
    chainId,
    latestBlock: blockHex,
    contract: CONTRACT,
    contractCodeBytes: Math.max(0, (code.length - 2) / 2),
    logRange: { fromBlock: `0x${fromBlock.toString(16)}`, toBlock: blockHex },
    logsReturned: logs.length,
    topicSummary: Object.fromEntries([...byTopic.entries()].map(([topic, value]) => [topic, value])),
  }));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exit(1);
}
