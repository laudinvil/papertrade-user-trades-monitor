import { spawn } from "node:child_process";
import { createServer } from "node:http";

const services = [
  { name: "profitable-traders-monitor", script: "profitable-traders-monitor.js" },
  { name: "open-positions-monitor", script: "open-positions-monitor.js" },
];

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
const healthServer = createServer((req, res) => {
  if (req.url === "/diagnostics") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ...bootDiagnostics, uptimeSeconds: Math.floor(process.uptime()), services: services.map(service => ({ name: service.name, running: children.has(service.name) })) }));
    return;
  }
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, services: services.map(service => ({ name: service.name, running: children.has(service.name) })) }));
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
    console.error(JSON.stringify({
      level: "error",
      event: "health_server_unavailable",
      requestedPort,
      attemptedPorts: candidatePorts,
      message: "Could not bind the health server; monitor process will continue so its startup errors remain visible.",
    }));
    return;
  }
  const port = candidatePorts[index];
  const onError = error => {
    healthServer.off("listening", onListening);
    console.error(JSON.stringify({
      level: "error",
      event: "health_server_listen_failed",
      port,
      code: error.code || null,
      message: error.message,
    }));
    if (error.code === "EADDRINUSE" && index + 1 < candidatePorts.length) {
      listenHealthServer(index + 1);
    } else if (index + 1 < candidatePorts.length && !process.env.PORT) {
      listenHealthServer(index + 1);
    }
  };
  const onListening = () => {
    healthServer.off("error", onError);
    healthServerStarted = true;
    console.log(JSON.stringify({
      level: "info",
      event: "health_server_started",
      host: "0.0.0.0",
      port,
      requestedPort,
      fallback: port !== requestedPort,
    }));
  };
  healthServer.once("error", onError);
  healthServer.once("listening", onListening);
  healthServer.listen(port, "0.0.0.0");
}

const children = new Map();
function start(service, restartCount = 0) {
  if (stopping) return;
  diagnostic("info", "service_starting", { service: service.name, script: service.script, restartCount });
  const child = spawn(process.execPath, [service.script], { stdio: "inherit", env: process.env });
  children.set(service.name, child);
  child.on("error", error => {
    if (!stopping) diagnostic("error", "service_spawn_error", { service: service.name, code: error.code || null, message: error.message });
  });
  child.on("exit", (code, signal) => {
    if (children.get(service.name) === child) children.delete(service.name);
    if (stopping) return;
    const delay = Math.min(30_000, 1000 * (2 ** Math.min(restartCount, 5)));
    diagnostic("error", "service_exited", { service: service.name, code, signal, restartInMs: delay });
    setTimeout(() => start(service, restartCount + 1), delay);
  });
}

healthServer.on("error", error => {
  diagnostic("error", "health_server_unhandled_error", { code: error.code || null, message: error.message });
});
listenHealthServer();
for (const service of services) start(service);

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  healthServer.close();
  console.log(JSON.stringify({ level: "info", event: "supervisor_stopping", signal }));
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 100).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
diagnostic("info", "supervisor_started", { services: services.map(s => s.name) });
