import { spawn } from "node:child_process";

const services = [
  { name: "liquidation-monitor", script: "papertrade-monitor.js" },
  { name: "shark-radar-monitor", script: "shark-radar-monitor.js" },
];
const children = new Map();
let stopping = false;

function start(service, restartCount = 0) {
  if (stopping) return;
  console.log(JSON.stringify({ level: "info", event: "service_starting", service: service.name, script: service.script, restartCount }));
  const child = spawn(process.execPath, [service.script], { stdio: "inherit", env: process.env });
  children.set(service.name, child);
  child.on("error", error => {
    if (stopping) return;
    console.error(JSON.stringify({ level: "error", event: "service_spawn_error", service: service.name, message: error.message }));
  });
  child.on("exit", (code, signal) => {
    if (children.get(service.name) === child) children.delete(service.name);
    if (stopping) return;
    console.error(JSON.stringify({ level: "error", event: "service_exited", service: service.name, code, signal, restartInMs: Math.min(30_000, 1000 * (2 ** Math.min(restartCount, 5))) }));
    const delay = Math.min(30_000, 1000 * (2 ** Math.min(restartCount, 5)));
    setTimeout(() => start(service, restartCount + 1), delay);
  });
}
for (const service of services) start(service);

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", event: "supervisor_stopping", signal }));
  // Deplexo may deny signalling child processes (EACCES). During container shutdown,
  // stop supervising immediately and let the platform terminate the container process group.
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 100).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
console.log(JSON.stringify({ level: "info", event: "supervisor_started", services: services.map(s => s.name) }));
