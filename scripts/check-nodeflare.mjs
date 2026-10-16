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

  const LIQUIDATED_TOPIC = "0x87902ed2451849f465fc4d36a01d7f5c67b53af12f63ee85d2814a2d582f89bf";
  const wordAt = (data, index) => {
    const start = 2 + index * 64;
    const word = data.slice(start, start + 64);
    if (word.length !== 64) throw new Error("Liquidated event data has an unexpected length");
    return BigInt("0x" + word);
  };
  const liquidatedEvents = logs
    .filter(log => log.address?.toLowerCase() === CONTRACT.toLowerCase()
      && log.topics?.[0]?.toLowerCase() === LIQUIDATED_TOPIC)
    .map(log => ({
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
      positionId: log.topics[1] ? BigInt(log.topics[1]).toString() : null,
      user: log.topics[2] ? "0x" + log.topics[2].slice(-40) : null,
      markPriceRaw: wordAt(log.data, 0).toString(),
      bustPriceRaw: wordAt(log.data, 1).toString(),
      fromQueuedBalance: wordAt(log.data, 2) !== 0n,
      stakerFeeRaw: wordAt(log.data, 3).toString(),
      devFeeRaw: wordAt(log.data, 4).toString(),
    }));

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
