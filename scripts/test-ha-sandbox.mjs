import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { actorRoom, findWalkingPath, followWalkingPath } from "../src/sandbox/houseBlueprint.js";
import { createWalker } from "../src/sandbox/walker.js";

const directory = resolve("build/house-sandbox"); mkdirSync(directory, { recursive: true });
const temporary = createServer();
await new Promise(done => temporary.listen(0, "127.0.0.1", done));
const port = temporary.address().port; await new Promise(done => temporary.close(done));
const base = `http://127.0.0.1:${port}`;
const captured = Boolean(process.env.HARNESS_SANDBOX_SOURCE_DIRECTORY);
const server = spawn(process.execPath, ["scripts/start-house-sandbox.mjs"], { cwd: process.cwd(), env: { ...process.env, SANDBOX_PORT: String(port), SANDBOX_FIXTURE: captured ? "0" : "1", SANDBOX_SAMPLE: "0" }, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; server.stdout.on("data", chunk => { log += chunk; }); server.stderr.on("data", chunk => { log += chunk; });
const report = { createdAt: new Date().toISOString(), suite: "ha-backed-house-sandbox", source: captured ? "existing-local-house-cache" : "synthetic-ha-fixture", model: "native-local-d1", realDeviceWrites: 0, cases: [] };
let browser;
const get = async path => { const response = await fetch(`${base}/api/sandbox/${path}`); assert(response.ok); return response.json(); };
const post = async (path, data) => { const response = await fetch(`${base}/api/sandbox/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }); return { status: response.status, data: await response.json() }; };
async function check(name, test) { const start = performance.now(); const evidence = await test(); report.cases.push({ name, passed: true, elapsedMs: Math.round(performance.now() - start), evidence }); console.log(`PASS ${name}`); }
async function pixels(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas"); const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    const buffer = new Uint8Array(canvas.width * canvas.height * 4); gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
    const colors = new Set(); let content = 0;
    for (let i = 0; i < buffer.length; i += 128) { const r = buffer[i], g = buffer[i + 1], b = buffer[i + 2]; colors.add(`${r >> 3},${g >> 3},${b >> 3}`); if (Math.max(r, g, b) - Math.min(r, g, b) > 14 || Math.min(r, g, b) < 170) content++; }
    return { colors: colors.size, content, width: canvas.width, height: canvas.height, ...window.__sandboxScene.stats() };
  });
}
try {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`isolated_server_failed:${log.slice(-1000)}`);
    try { await get("state"); break; } catch { if (i === 99) throw new Error("isolated_server_timeout"); await new Promise(done => setTimeout(done, 200)); }
  }
  const initial = (await get("state")).snapshot, blueprint = initial.blueprint;
  assert.equal(initial.mode, "simulation-only"); assert.equal(blueprint.kind, "ha-replica");
  report.inventory = { rooms: blueprint.rooms.length, physicalDevices: initial.home.things.length, logicalAssets: initial.home.controlGraph.assets.length, sceneDevices: blueprint.devices.length };
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--no-sandbox", "--disable-background-networking"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage(), errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/sandbox.html`); await page.waitForFunction(() => window.__sandboxScene?.stats().ready);
  const command = async text => {
    const input = page.getByRole("textbox", { name: "对住户所在房间发出指令" });
    await input.fill(text);
    const response = page.waitForResponse(r => r.url().endsWith("/api/sandbox/command") && r.request().method() === "POST");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const data = await (await response).json(); await page.waitForFunction(() => !document.querySelector(".sandbox-composer input").disabled); return data;
  };
  await check("read-only network and private file boundary", async () => {
    for (const path of ["/api/ha/execute", "/data/sandbox-source.local.json", "/.env", "/build/house-sandbox/ha-home.local.json", `/@fs${resolve("data/sandbox-source.local.json")}`, `/@fs${resolve("build/house-sandbox/ha-home.local.json")}`]) assert.equal((await context.request.get(`${base}${path}`)).status(), 404);
    assert.equal((await context.request.post(`${base}/api/sandbox/reset`, { headers: { Origin: "http://other.test" }, data: {} })).status(), 403);
    assert.equal(initial.home.provider.token, undefined);
    assert(blueprint.rooms.length >= 8); assert(initial.home.things.length >= 10);
    return report.inventory;
  });
  await check("actual rooms, individual loads and nonblank Blender assets", async () => {
    for (const room of blueprint.rooms) {
      const path = findWalkingPath(blueprint.spawn, blueprint.roomSpawns[room.id], blueprint);
      assert(path.length, `room_not_connected:${room.id}`);
      const walker = await createWalker(blueprint.spawn, blueprint);
      try {
        for (let i = 0; path.length && i < 3000; i++) {
          const movement = followWalkingPath(walker.pose(), path, 0.07);
          walker.move(movement.x, movement.z, 1 / 30);
        }
        assert.equal(path.length, 0, `room_route_stuck:${room.id}`);
        assert.equal(actorRoom(walker.pose(), blueprint), room.id);
      } finally { walker.close(); }
    }
    const evidence = await pixels(page); assert(evidence.colors > 100); assert(evidence.content > 100);
    assert.equal(evidence.roomCount, blueprint.rooms.length); assert.equal(evidence.deviceCount, blueprint.devices.length);
    await page.screenshot({ path: resolve(directory, "ha-desktop.png") }); return { ...evidence, routesVerified: blueprint.rooms.length };
  });
  await check("typing keeps the same animated canvas", async () => {
    await page.evaluate(() => { window.__testCanvas = document.querySelector("canvas"); window.__testFrame = window.__sandboxScene.stats().frames; });
    await page.getByRole("textbox", { name: "对住户所在房间发出指令" }).fill("打开书房射灯");
    await page.waitForFunction(() => window.__sandboxScene.stats().frames > window.__testFrame + 4);
    assert(await page.evaluate(() => window.__testCanvas === document.querySelector("canvas")));
  });
  await check("inspection selection does not fabricate the speaker room", async () => {
    await page.getByRole("combobox", { name: "查看房间设备" }).selectOption("study");
    assert((await page.getByTestId("actor-room").innerText()).includes("入户") || (await page.getByTestId("actor-room").innerText()).includes("玄关"));
  });
  await check("walks through inferred doors to the configured study origin", async () => {
    await page.getByRole("button", { name: "走到所选房间", exact: true }).click();
    try { await page.waitForFunction(target => { const s = window.__sandboxScene.stats(); return s.room === "study" && Math.hypot(s.pose.x - target.x, s.pose.z - target.z) < 0.22; }, blueprint.roomSpawns.study, { timeout: 30000 }); }
    catch { throw new Error(`walk_did_not_arrive:${JSON.stringify(await page.evaluate(() => window.__sandboxScene.stats()))}`); }
    return await page.evaluate(() => ({ room: window.__sandboxScene.stats().room, pose: window.__sandboxScene.stats().pose }));
  });
  await check("native D1 switches only the real study spotlight gang in memory", async () => {
    const result = await command("打开书房射灯"); assert.equal(result.result.status, "executed", JSON.stringify(result.result));
    const asset = result.snapshot.home.controlGraph.assets.find(a => a.name.includes("书房射灯")); assert.equal(asset.state.commandedState, true);
    assert(result.result.actions.every(a => a.logicalAssetId === asset.id));
    const endpoint = result.snapshot.home.controlGraph.endpoints.find(e => e.id === asset.primaryEndpointId);
    const cap = result.snapshot.home.things.find(t => t.id === endpoint.providerThingId).capabilities.find(c => c.id === endpoint.capabilityId); assert.equal(cap.state, true);
    await page.waitForFunction(id => window.__sandboxScene.stats().visual.lamps[id] === 2, asset.id);
    assert(result.result.simulated); return { status: result.result.status, latencyMs: result.result.d1?.latencyMs, actions: result.result.actions.length, logicalReadback: true };
  });
  await check("sensor query has no device effects", async () => {
    const before = (await get("state")).snapshot;
    const sensors = before.home.things.filter(t => t.capabilities.some(c => c.kind === "sensor"));
    const sensor = sensors.find(t => t.spaceId === "study" && /人在|人体/.test(t.name)) ?? sensors.find(t => /人在|人体/.test(t.name));
    assert(sensor, "fixture_requires_a_presence_sensor");
    const result = await command(`${sensor.name}现在是什么状态`); assert.equal(result.result.status, "answered", JSON.stringify(result.result));
    assert.equal(result.snapshot.effects, before.effects); assert.deepEqual(result.snapshot.home.things, before.home.things);
    return { status: result.result.status, effects: 0 };
  });
  await check("compact replay binds to the captured baseline and remains isolated", async () => {
    const recording = await get("recording"), before = (await get("state")).snapshot;
    assert.equal(recording.version, 2); assert(!recording.events[0].after); assert(JSON.stringify(recording).length < 512 * 1024);
    assert.equal((await post("replay", { ...recording, baselineId: "other-house" })).status, 400);
    const replay = await post("replay", recording); assert.equal(replay.status, 200); assert(replay.data.results.every(r => r.matches));
    assert.deepEqual((await get("state")).snapshot.home, before.home); assert.equal((await get("state")).snapshot.effects, before.effects);
    return { events: recording.events.length, bytes: JSON.stringify(recording).length, replayMatches: true };
  });
  await check("room list and controller details retain semantic relationships", async () => {
    await page.getByRole("button", { name: /书房射灯/ }).click();
    assert((await page.locator(".device-details").innerText()).includes("控制器"));
    assert.equal(await page.getByRole("combobox", { name: "查看房间设备" }).locator("option").count() >= blueprint.rooms.length + 1, true);
    await page.getByRole("button", { name: "全屋", exact: true }).click();
    await page.waitForFunction(rooms => {
      const canvas = document.querySelector("canvas").getBoundingClientRect();
      return rooms.every(r => [[r.minX, r.minZ], [r.maxX, r.maxZ]].every(([x, z]) => { const p = window.__sandboxScene.project(x, z); return p.x > canvas.left && p.x < canvas.right && p.y > canvas.top && p.y < canvas.bottom; }));
    }, blueprint.rooms);
  });
  await check("desktop, tablet and mobile frame the complete nonblank house", async () => {
    const checks = [];
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport); await page.reload(); await page.waitForFunction(() => window.__sandboxScene?.stats().frames > 8);
      const evidence = await pixels(page); assert(evidence.colors > 100 && evidence.content > 100);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const framing = await page.evaluate(rooms => {
        const canvas = document.querySelector("canvas").getBoundingClientRect();
        return rooms.every(r => [[r.minX, r.minZ], [r.maxX, r.minZ], [r.maxX, r.maxZ], [r.minX, r.maxZ]].every(([x, z]) => { const p = window.__sandboxScene.project(x, z); return p.x >= canvas.left + 3 && p.x <= canvas.right - 3 && p.y >= canvas.top + 35 && p.y <= canvas.bottom - 3; }));
      }, blueprint.rooms); assert(framing, `clipped_house:${viewport.width}`);
      await page.screenshot({ path: resolve(directory, `ha-${viewport.width}.png`), fullPage: true }); checks.push({ viewport, colors: evidence.colors, fullyFramed: framing });
    }
    return checks;
  });
  await check("no application page errors", async () => { assert.deepEqual(errors, []); });
  report.passed = true;
} catch (failure) { report.passed = false; report.error = failure.message; console.error(failure.message); process.exitCode = 1; }
finally {
  await browser?.close();
  if (server.exitCode === null) await new Promise(done => {
    const timeout = setTimeout(() => { server.kill("SIGKILL"); done(); }, 5000);
    server.once("exit", () => { clearTimeout(timeout); done(); });
    server.kill("SIGTERM");
  });
  writeFileSync(resolve(directory, captured ? "ha-captured-qa.json" : "ha-fixture-qa.json"), `${JSON.stringify(report, null, 2)}\n`);
}
