import { spawn } from "node:child_process";
import { createServer } from "node:http";

const services = [
  { name: "profitable-traders-monitor", script: "profitable-traders-monitor.js" },
];
const children = new Map();
const port = Number(process.env.PORT || 8000);
const healthServer = createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, services: services.map(service => ({ name: service.name, running: children.has(service.name) })) }));
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});
healthServer.listen(port, "0.0.0.0", () => console.log(JSON.stringify({ level: "info", event: "health_server_started", host: "0.0.0.0", port })));
let stopping = false;
function start(service, restartCount = 0) {
  if (stopping) return;
  console.log(JSON.stringify({ level: "info", event: "service_starting", service: service.name, script: service.script, restartCount }));
  const child = spawn(process.execPath, [service.script], { stdio: "inherit", env: process.env });
  children.set(service.name, child);
  child.on("error", error => {
    if (!stopping) console.error(JSON.stringify({ level: "error", event: "service_spawn_error", service: service.name, message: error.message }));
  });
  child.on("exit", (code, signal) => {
    if (children.get(service.name) === child) children.delete(service.name);
    if (stopping) return;
    const delay = Math.min(30_000, 1000 * (2 ** Math.min(restartCount, 5)));
    console.error(JSON.stringify({ level: "error", event: "service_exited", service: service.name, code, signal, restartInMs: delay }));
    setTimeout(() => start(service, restartCount + 1), delay);
  });
}
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
console.log(JSON.stringify({ level: "info", event: "supervisor_started", services: services.map(s => s.name) }));
