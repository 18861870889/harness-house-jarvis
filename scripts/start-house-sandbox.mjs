import express from "express";
import { createServer as createViteServer } from "vite";
import react from "@vitejs/plugin-react";
import { createD1Client } from "../src/d1Client.js";
import { createSandboxService } from "../src/sandbox/sandboxService.js";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readSandboxSourceConfig, createHaHouseSource, prepareHaHouse } from "../src/sandbox/haHouse.js";
import { haHouseFixture } from "../src/sandbox/haHouse.fixture.js";
import { sandboxDevices } from "../src/sandbox/sandboxDeviceView.js";

const port = Number(process.env.SANDBOX_PORT ?? 5184);
if (!Number.isInteger(port) || port < 1024 || port > 65435) throw new Error("invalid_port");
const serviceName = "harness-house-sandbox";
const probe = async () => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/sandbox/state`, { signal: AbortSignal.timeout(800) });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.serviceName !== serviceName) throw new Error("sandbox_port_in_use");
    return true;
  } catch (error) {
    if (error.message === "sandbox_port_in_use") throw error;
    return false;
  }
};
if (process.argv.includes("--background")) {
  if (await probe()) { console.log(`Sandbox already running: http://localhost:${port}/`); process.exit(0); }
  mkdirSync("build/house-sandbox", { recursive: true });
  const stem = port === 5184 ? "server" : `server-${port}`;
  const logPath = `build/house-sandbox/${stem}.log`;
  const log = openSync(logPath, "a");
  const child = spawn(process.execPath, [resolve("scripts/start-house-sandbox.mjs")], { cwd: process.cwd(), detached: true, stdio: ["ignore", log, log] });
  closeSync(log);
  let exited = false;
  child.on("exit", () => { exited = true; });
  child.on("error", () => { exited = true; });
  child.unref();
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 120 && !exited; attempt += 1) {
      if (await probe()) { healthy = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!healthy) throw new Error(`sandbox_start_failed: see ${logPath}`);
    writeFileSync(`build/house-sandbox/${stem}.pid`, `${child.pid}\n`);
    console.log(`Sandbox process ${child.pid}; http://localhost:${port}/; log: ${logPath}`);
  } catch (error) { if (!exited) child.kill("SIGTERM"); throw error; }
} else {
  const client = createD1Client({ endpoint: process.env.D1_ENDPOINT ?? "http://192.168.1.154:8080/v1/systemone", timeoutMs: 5000 });
  const fixture = process.env.SANDBOX_FIXTURE === "1" ? haHouseFixture() : null;
  const config = process.env.SANDBOX_SAMPLE === "1" || fixture ? null : readSandboxSourceConfig();
  const source = config ? await createHaHouseSource({ ...config, cachePath: resolve("build/house-sandbox/ha-home.local.json") }) : null;
  const newService = () => {
    const house = source?.house() ?? (fixture ? prepareHaHouse(fixture.home, {}, fixture.state) : null);
    return createSandboxService({ client, decisionVersion: process.env.SANDBOX_DECISION_VERSION ?? "v3", ...(house ? { initialHome: house.home, blueprint: house.blueprint, baselineId: house.baselineId } : {}) });
  };
  let service = await newService();
  const present = snapshot => ({ ...snapshot, source: source ? { ...source.status(), copyCapturedAt: snapshot.home.syncedAt, updateAvailable: source.status().latestBaselineId !== snapshot.baselineId }
    : { kind: fixture ? "fixture" : "sample", readOnly: true, connectionState: "simulated", updateAvailable: false } });
  const refreshTimer = source ? setInterval(() => { source.refresh().catch(() => {}); }, 30000) : null;
  refreshTimer?.unref();
  if (source) source.refresh().catch(() => {});
  let transitioning = false;
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const host = req.headers.host;
    if (![ `localhost:${port}`, `127.0.0.1:${port}` ].includes(host)) return res.status(403).json({ error: "loopback_host_required" });
    if (req.headers.origin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(req.headers.origin)) return res.status(403).json({ error: "same_origin_required" });
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "512kb" }));
  app.get("/api/sandbox/state", (_req, res) => res.json({ serviceName, snapshot: present(service.snapshot()), recordingCount: service.recording().events.length, model: client.model }));
  app.get("/api/sandbox/reference", (_req, res) => {
    const house = source?.house();
    res.json({ source: source?.status() ?? null, devices: house ? sandboxDevices(house.home, house.blueprint) : [] });
  });
  app.get("/api/sandbox/source/status", (_req, res) => res.json({ source: source?.status() ?? null }));
  app.get("/api/sandbox/recording", (_req, res) => res.json(service.recording()));
  const handler = (method) => async (req, res, next) => {
    if (transitioning) return res.status(409).json({ error: "runtime_busy" });
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    try { res.json(await method(req.body, controller.signal)); } catch (error) { next(error); }
  };
  app.post("/api/sandbox/command", handler(async (body, signal) => { const data = await service.command(body, { signal }); return { ...data, snapshot: present(data.snapshot) }; }));
  app.post("/api/sandbox/replay", handler((body, signal) => service.replay(body, { signal })));
  app.post("/api/sandbox/source/refresh", handler(async () => { if (source) await source.refresh(); return { snapshot: present(service.snapshot()), recordingCount: service.recording().events.length }; }));
  app.post("/api/sandbox/reset", async (_req, res, next) => {
    if (transitioning || service.snapshot().busy) return res.status(409).json({ error: "runtime_busy" });
    transitioning = true;
    try { const replacement = await newService(); await service.close(); service = replacement; res.json({ snapshot: present(service.snapshot()), recordingCount: 0 }); }
    catch (error) { next(error); }
    finally { transitioning = false; }
  });
  app.use("/api", (_req, res) => res.status(404).json({ error: "sandbox_api_only" }));
  app.get("/", (_req, res) => res.redirect("/sandbox.html"));
  app.use((req, res, next) => {
    const path = decodeURIComponent(req.path);
    return /(?:^|\/)(?:data|build)\//.test(path) || /(?:^|\/)\.env(?:\.|$)/.test(path) || path.endsWith("/home_model_cache.json") ? res.status(404).end() : next();
  });
  const vite = await createViteServer({ configFile: false, plugins: [react()], server: { host: "127.0.0.1", middlewareMode: true, hmr: { host: "127.0.0.1", port: port + 100 }, fs: { allow: [process.cwd()], deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/data/**", "**/build/**", "**/home_model_cache.json"] } }, appType: "mpa" });
  app.use(vite.middlewares);
  app.use((error, _req, res, _next) => {
    const message = error.message ?? "sandbox_failed";
    res.status(/busy|conflict/.test(message) ? 409 : /invalid|incomplete|origin|required|large|baseline_mismatch/.test(message) ? 400 : 500).json({ error: message });
  });
  const server = app.listen(port, "127.0.0.1", () => console.log(`Harness House sandbox: http://localhost:${port}/ — ${source ? "HA read-only source + isolated memory copy" : fixture ? "HA fixture" : "sample"}, local D1; real device writes disabled`));
  let shuttingDown = false;
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (refreshTimer) clearInterval(refreshTimer);
    source?.close();
    server.close();
    while (service.snapshot().busy) await new Promise((resolve) => setTimeout(resolve, 100));
    await service.close();
    await vite.close();
    process.exit(exitCode);
  };
  server.on("error", (error) => { console.error(error.message); shutdown(1); });
  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());
}
