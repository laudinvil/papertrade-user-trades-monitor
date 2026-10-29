import { createServer } from "node:http";

const services = [];

const bootDiagnostics = {
  startedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  pid: process.pid,
  cwd: process.cwd(),
  requestedPort: process.env.PORT || "8080",
  events: [],
};
function diagnostic(level, event, details = {}) {
  const entry = { time: new Date().toISOString(), level, event, ...details };
  bootDiagnostics.events.push(entry);
  if (bootDiagnostics.events.length > 50) bootDiagnostics.events.shift();
  const line = JSON.stringify(entry);
  (level === "error" ? console.error : console.log)(line);
}
const children = new Map();
const healthServer = createServer((req, res) => {
  if (req.url === "/diagnostics") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ...bootDiagnostics, uptimeSeconds: Math.floor(process.uptime()), services: services.map(service => ({ name: service.name, running: children.has(service.name) })) }));
    return;
  }
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, services: [] }));
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

let stopping = false;
let healthServerStarted = false;
const requestedPort = Number(process.env.PORT || 8080);
const candidatePorts = [...new Set([requestedPort, 8080, 8000, 3000].filter(port => Number.isInteger(port) && port > 0 && port < 65536))];

function listenHealthServer(index = 0) {
  if (stopping || healthServerStarted) return;
  if (index >= candidatePorts.length) {
    diagnostic("error", "health_server_unavailable", { requestedPort, attemptedPorts: candidatePorts });
    return;
  }
  const port = candidatePorts[index];
  const onError = error => {
    healthServer.off("listening", onListening);
    diagnostic("error", "health_server_listen_failed", { port, code: error.code || null, message: error.message });
    if (error.code === "EADDRINUSE" && index + 1 < candidatePorts.length) listenHealthServer(index + 1);
    else if (index + 1 < candidatePorts.length && !process.env.PORT) listenHealthServer(index + 1);
  };
  const onListening = () => {
    healthServer.off("error", onError);
    healthServerStarted = true;
    diagnostic("info", "health_server_started", { host: "0.0.0.0", port, requestedPort, fallback: port !== requestedPort });
  };
  healthServer.once("error", onError);
  healthServer.once("listening", onListening);
  healthServer.listen(port, "0.0.0.0");
}

healthServer.on("error", error => diagnostic("error", "health_server_unhandled_error", { code: error.code || null, message: error.message }));
listenHealthServer();

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  healthServer.close();
  diagnostic("info", "supervisor_stopping", { signal });
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 100).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
diagnostic("info", "supervisor_started", { services: [] });
