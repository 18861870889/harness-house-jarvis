import express from "express";
import { createServer as createViteServer } from "vite";
import react from "@vitejs/plugin-react";
import { createD1Client } from "../src/d1Client.js";
import { createSandboxService } from "../src/sandbox/sandboxService.js";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

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
  const log = openSync("build/house-sandbox/server.log", "a");
  const child = spawn(process.execPath, [resolve("scripts/start-house-sandbox.mjs")], { cwd: process.cwd(), detached: true, stdio: ["ignore", log, log] });
  closeSync(log);
  let exited = false;
  child.on("exit", () => { exited = true; });
  child.on("error", () => { exited = true; });
  child.unref();
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 40 && !exited; attempt += 1) {
      if (await probe()) { healthy = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!healthy) throw new Error("sandbox_start_failed: see build/house-sandbox/server.log");
    writeFileSync("build/house-sandbox/server.pid", `${child.pid}\n`);
    console.log(`Sandbox process ${child.pid}; http://localhost:${port}/; log: build/house-sandbox/server.log`);
  } catch (error) { if (!exited) child.kill("SIGTERM"); throw error; }
} else {
  const client = createD1Client({ endpoint: process.env.D1_ENDPOINT ?? "http://192.168.1.154:8080/v1/systemone", timeoutMs: 5000 });
  let service = await createSandboxService({ client });
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
  app.get("/api/sandbox/state", (_req, res) => res.json({ serviceName, snapshot: service.snapshot(), recordingCount: service.recording().events.length, model: client.model }));
  app.get("/api/sandbox/recording", (_req, res) => res.json(service.recording()));
  const handler = (method) => async (req, res, next) => {
    if (transitioning) return res.status(409).json({ error: "runtime_busy" });
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    try { res.json(await method(req.body, controller.signal)); } catch (error) { next(error); }
  };
  app.post("/api/sandbox/command", handler((body, signal) => service.command(body, { signal })));
  app.post("/api/sandbox/replay", handler((body, signal) => service.replay(body, { signal })));
  app.post("/api/sandbox/reset", async (_req, res, next) => {
    if (transitioning || service.snapshot().busy) return res.status(409).json({ error: "runtime_busy" });
    transitioning = true;
    try { await service.close(); service = await createSandboxService({ client }); res.json({ snapshot: service.snapshot(), recordingCount: 0 }); }
    catch (error) { next(error); }
    finally { transitioning = false; }
  });
  app.use("/api", (_req, res) => res.status(404).json({ error: "sandbox_api_only" }));
  app.get("/", (_req, res) => res.redirect("/sandbox.html"));
  const vite = await createViteServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: { port: port + 100 }, fs: { allow: [process.cwd()] } }, appType: "mpa" });
  app.use(vite.middlewares);
  app.use((error, _req, res, _next) => {
    const message = error.message ?? "sandbox_failed";
    res.status(/busy|conflict/.test(message) ? 409 : /invalid|incomplete|origin|required|large/.test(message) ? 400 : 500).json({ error: message });
  });
  const server = app.listen(port, "127.0.0.1", () => console.log(`Harness House sandbox: http://localhost:${port}/ — memory devices only, local D1`));
  let shuttingDown = false;
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
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
