import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const base = process.env.SANDBOX_TEST_URL ?? "http://127.0.0.1:5184";
const url = new URL(base);
if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("loopback_test_only");
const directory = resolve("build/house-sandbox");
mkdirSync(directory, { recursive: true });
const report = { createdAt: new Date().toISOString(), suite: "house-sandbox-alpha", model: "native-local-d1", realDeviceWrites: 0, speech: "browser API fixture, not microphone hardware", cases: [] };
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--no-sandbox", "--disable-background-networking"] });
let page;
const pageErrors = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
await context.route("**/*", (route) => new URL(route.request().url()).origin === url.origin ? route.continue() : route.abort());
await context.addInitScript(() => {
  window.__speechFixture = { transcript: "打开书房射灯", confidence: 0.95, error: null, delay: 50, spoken: [] };
  window.SpeechRecognition = class {
    start() {
      setTimeout(() => {
        if (window.__speechFixture.error) { this.onerror?.({ error: window.__speechFixture.error }); this.onend?.(); return; }
        const result = [{ transcript: window.__speechFixture.transcript, confidence: window.__speechFixture.confidence }];
        result.isFinal = true;
        const event = { resultIndex: 0, results: [result] };
        this.onresult?.(event); this.onresult?.(event); this.onend?.();
        setTimeout(() => this.onresult?.(event), 300);
      }, window.__speechFixture.delay);
    }
    stop() { this.onend?.(); }
  };
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: { cancel() {}, speak(utterance) { window.__speechFixture.spoken.push(utterance.text); } } });
});
const check = async (name, run) => {
  const started = Date.now();
  try { const evidence = await run(); report.cases.push({ name, passed: true, elapsedMs: Date.now() - started, evidence }); console.log(`PASS ${name}`); }
  catch (error) { report.cases.push({ name, passed: false, error: error.message }); throw error; }
};
const state = async () => (await (await context.request.get(`${base}/api/sandbox/state`)).json()).snapshot;
const values = (snapshot) => Object.fromEntries(snapshot.home.things.flatMap((thing) => thing.capabilities.map((capability) => [capability.id, capability.state])));
const pixels = () => page.evaluate(() => {
  const canvas = document.querySelector("canvas");
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  const data = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
  const colors = new Set();
  let sum = 0, occupied = 0, count = 0, hash = 2166136261;
  for (let i = 0; i < data.length; i += 4 * 137) {
    colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    sum += data[i] + data[i + 1] + data[i + 2]; count += 1;
    if (Math.abs(data[i] - data[0]) + Math.abs(data[i + 1] - data[1]) + Math.abs(data[i + 2] - data[2]) > 18) occupied += 1;
    hash = Math.imul(hash ^ data[i] ^ data[i + 1] << 8 ^ data[i + 2] << 16, 16777619) >>> 0;
  }
  return { width: canvas.width, height: canvas.height, colors: colors.size, occupied: occupied / count, mean: sum / count / 3, hash, ...window.__sandboxScene.stats() };
});
const nonblank = async (minimumMeshes = 40) => {
  const start = await page.evaluate(() => window.__sandboxScene?.stats().frames ?? 0);
  await page.waitForFunction((frames) => window.__sandboxScene?.stats().frames > Math.max(frames + 3, 10), start);
  const result = await pixels();
  assert.ok(result.colors > 100 && result.occupied > 0.05 && result.drawCalls > minimumMeshes, JSON.stringify(result));
  return result;
};
const send = async (input) => {
  await page.getByRole("textbox").fill(input);
  const response = page.waitForResponse((response) => response.url().endsWith("/api/sandbox/command") && response.request().method() === "POST");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const http = await response;
  assert.equal(http.status(), 200);
  const data = await http.json();
  await page.getByRole("textbox").waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector(".sandbox-composer input").disabled);
  assert.equal(data.snapshot.mode, "simulation-only");
  return data;
};
try {
  await check("API isolation and validation", async () => {
    assert.notEqual((await state()).blueprint.kind, "ha-replica", "This legacy suite requires SANDBOX_SAMPLE=1; use test:sandbox:ha for an HA-backed house.");
    assert.equal((await context.request.post(`${base}/api/hcm/command`, { data: { input: "开灯" } })).status(), 404);
    assert.equal((await context.request.post(`${base}/api/sandbox/reset`, { headers: { Origin: "https://other.example" }, data: {} })).status(), 403);
    assert.equal((await context.request.post(`${base}/api/sandbox/command`, { data: { commandId: "invalid-pose", sessionId: "qa", input: "开灯", source: "text", pose: { x: 100, z: 0 } } })).status(), 400);
    assert.equal((await context.request.post(`${base}/api/sandbox/reset`, { data: {} })).status(), 200);
    assert.equal((await state()).effects, 0);
  });
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(base);
  await check("Desktop assets and nonblank canvas", async () => {
    const evidence = await nonblank(100);
    await page.screenshot({ path: `${directory}/desktop-idle.png` });
    return evidence;
  });
  await check("Typing preserves canvas and animation", async () => {
    await page.evaluate(() => { window.__testCanvas = document.querySelector("canvas"); window.__testFrames = window.__sandboxScene.stats().frames; });
    await page.getByRole("textbox").fill("打开书房射灯");
    await page.waitForFunction(() => window.__sandboxScene.stats().frames > window.__testFrames + 5);
    assert.ok(await page.evaluate(() => window.__testCanvas === document.querySelector("canvas")));
  });
  const dark = await pixels();
  await check("Native D1 controls the bound study light", async () => {
    const data = await send("打开书房射灯");
    assert.equal(data.result.status, "executed");
    assert.equal(values(data.snapshot).study_spot, true);
    assert.equal(values(data.snapshot).study_ceiling, false);
    assert.equal(values(data.snapshot).study_unused, false);
    await page.waitForFunction(() => window.__sandboxScene.stats().visual.lamps.study_spot > 0);
    await page.waitForFunction((frames) => window.__sandboxScene.stats().frames > frames, dark.frames + 4);
    const light = await pixels();
    assert.notEqual(light.hash, dark.hash);
    assert.ok(Math.abs(light.mean - dark.mean) > 0.05, "Readback must visibly change lighting");
    return { probability: data.result.d1.probability, modelLatencyMs: data.result.d1.latencyMs, pixelMeanChange: light.mean - dark.mean };
  });
  await check("Lighting outcome clarification and confirmation", async () => {
    const data = await send("还是太暗了");
    assert.ok(["needs_clarification", "executed"].includes(data.result.status));
    let final = data;
    if (data.result.status === "needs_clarification") {
      assert.equal(values(data.snapshot).study_ceiling, false);
      assert.ok(data.result.summary.includes("书房"));
      final = await send("可以");
    }
    assert.equal(final.result.status, "executed");
    assert.equal(values(final.snapshot).study_ceiling, true);
    assert.equal(values(final.snapshot).study_unused, false);
    await page.screenshot({ path: `${directory}/desktop-lighting.png` });
    return { firstStatus: data.result.status, firstSummary: data.result.summary, finalSummary: final.result.summary };
  });
  await check("Recording export and isolated visual replay", async () => {
    const before = await state();
    await page.getByRole("tab", { name: /场景轨迹/ }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出轨迹", exact: true }).click();
    await (await download).saveAs(`${directory}/scene.json`);
    const response = page.waitForResponse((response) => response.url().endsWith("/api/sandbox/replay"));
    await page.getByRole("button", { name: "回放", exact: true }).click();
    const data = await (await response).json();
    assert.ok(data.results.length >= 2 && data.results.every((entry) => entry.matches));
    await page.waitForFunction(() => !document.querySelector(".trace-tools button").disabled, null, { timeout: 30000 });
    assert.deepEqual(await state(), before);
    const imported = page.waitForResponse((response) => response.url().endsWith("/api/sandbox/replay"));
    await page.locator(".trace-tools input[type=file]").setInputFiles(`${directory}/scene.json`);
    const importedData = await (await imported).json();
    assert.ok(importedData.results.every((entry) => entry.matches));
    await page.waitForFunction(() => !document.querySelector(".trace-tools button").disabled, null, { timeout: 30000 });
    assert.deepEqual(await state(), before);
    await page.screenshot({ path: `${directory}/desktop-replay.png` });
    await page.getByRole("tab", { name: "对话", exact: true }).click();
    return { interactions: data.results.length, allMatched: true, importedRoundTrip: true };
  });
  await check("Walking crosses the doorway with collision constraints", async () => {
    const point = await page.evaluate(() => window.__sandboxScene.project(1.5, -0.8));
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => window.__sandboxScene.stats().pose.x > 1.35, null, { timeout: 15000 });
    const pose = await page.evaluate(() => window.__sandboxScene.stats().pose);
    assert.equal(await page.getByTestId("actor-room").textContent(), "客厅");
    return pose;
  });
  await check("Explicit referent and new speaking room remain distinct", async () => {
    const oldLight = await send("把刚才那盏关掉");
    assert.equal(oldLight.result.status, "executed");
    assert.equal(values(oldLight.snapshot).study_ceiling, false);
    const current = await send("开灯");
    assert.equal(current.result.status, "executed");
    assert.equal(values(current.snapshot).living_power, true);
    assert.ok(current.result.actions.every((action) => action.logicalRoomId === "living"));
    return { referent: oldLight.result.summary, currentRoom: current.result.summary, scope: current.result.d1.scope.source };
  });
  await check("Read-only state queries create no device effects", async () => {
    const before = await state();
    const data = await send("客厅灯现在开着吗");
    assert.equal(data.result.status, "answered");
    assert.equal(data.snapshot.effects, before.effects);
    assert.ok(data.result.summary.includes("开启"));
  });
  await check("TV, curtains and fan use verified simulator values", async () => {
    for (const [input, capability, value] of [["打开客厅电视", "tv_power", true], ["打开客厅风扇", "fan_power", true], ["把客厅窗帘打开", "curtain_position", 100]]) {
      const data = await send(input);
      assert.equal(data.result.status, "executed", `${input}: ${data.result.summary}`);
      assert.equal(values(data.snapshot)[capability], value);
    }
    await page.waitForFunction(() => window.__sandboxScene.stats().visual.tvEmissive === 0x276770 && Math.abs(window.__sandboxScene.stats().visual.curtainX[0] - 0.28) < 0.01);
    const visual = await page.evaluate(() => window.__sandboxScene.stats());
    await page.waitForFunction((angle) => window.__sandboxScene.stats().visual.fanAngle > angle + 0.1, visual.visual.fanAngle);
    await page.screenshot({ path: `${directory}/desktop-living.png` });
  });
  await check("Orbit rotation and keyboard walking remain interactive", async () => {
    const before = await page.evaluate(() => ({ point: window.__sandboxScene.project(3, 0), pose: window.__sandboxScene.stats().pose }));
    const box = await page.locator("canvas").boundingBox();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.35);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4 + 100, box.y + box.height * 0.35 + 30, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction((point) => { const current = window.__sandboxScene.project(3, 0); return Math.hypot(current.x - point.x, current.y - point.y) > 5; }, before.point);
    await page.keyboard.down("w");
    await page.waitForFunction((z) => window.__sandboxScene.stats().pose.z < z - 0.15, before.pose.z);
    await page.keyboard.up("w");
    assert.equal(await page.getByTestId("actor-room").textContent(), "客厅");
  });
  await check("Voice low-confidence and permission failures have no effects", async () => {
    const before = await state();
    await page.evaluate(() => { window.__speechFixture.confidence = 0.2; });
    await page.getByRole("button", { name: "开始语音输入", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "置信度不足" }).waitFor();
    assert.equal((await state()).effects, before.effects);
    await page.evaluate(() => { window.__speechFixture.error = "not-allowed"; });
    await page.getByRole("button", { name: "开始语音输入", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "麦克风权限未开启" }).waitFor();
    assert.equal((await state()).effects, before.effects);
    await page.evaluate(() => { window.__speechFixture.error = null; window.__speechFixture.delay = 400; window.__speechFixture.confidence = 0.95; });
    await page.getByRole("button", { name: "开始语音输入", exact: true }).click();
    await page.getByRole("button", { name: "停止语音输入", exact: true }).click();
    await page.waitForTimeout(800);
    assert.equal((await state()).effects, before.effects, "Cancelled recognition cannot submit a late final result");
  });
  await check("Voice fixture enters D1 once and optional TTS speaks the result", async () => {
    await page.evaluate(() => { window.__speechFixture.confidence = 0.95; window.__speechFixture.error = null; window.__speechFixture.delay = 50; window.__speechFixture.transcript = "关闭客厅电视"; });
    await page.getByRole("button", { name: "开启播报", exact: true }).click();
    const response = page.waitForResponse((response) => response.url().endsWith("/api/sandbox/command"));
    const before = await state();
    await page.getByRole("button", { name: "开始语音输入", exact: true }).click();
    const data = await (await response).json();
    assert.equal(data.result.status, "executed");
    assert.equal(values(data.snapshot).tv_power, false);
    assert.equal(data.snapshot.effects, before.effects + 1);
    await page.waitForFunction(() => window.__speechFixture.spoken.length === 1);
    await page.waitForTimeout(450);
    assert.equal((await state()).effects, before.effects + 1, "Late duplicate final results must remain deduplicated");
    assert.equal(await page.locator(".message.user").filter({ hasText: "关闭客厅电视" }).count(), 1);
  });
  for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }]) {
    await check(`${viewport.width}px responsive canvas, typing and follow view`, async () => {
      await page.setViewportSize(viewport);
      const evidence = await nonblank();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "No horizontal overflow");
      await page.getByRole("textbox").fill("客厅灯现在是什么状态");
      assert.ok(await page.evaluate(() => window.__testCanvas === document.querySelector("canvas")));
      await page.getByTitle("跟随人物", { exact: true }).click();
      await page.waitForFunction((frames) => window.__sandboxScene.stats().frames > frames + 25, evidence.frames);
      const follow = await nonblank();
      await page.screenshot({ path: `${directory}/${viewport.width === 390 ? "mobile" : "tablet"}.png`, fullPage: true });
      await page.getByTitle("全屋视角", { exact: true }).click();
      const overlap = await page.evaluate(() => {
        const location = document.querySelector(".location-indicator").getBoundingClientRect();
        const views = document.querySelector(".view-switch").getBoundingClientRect();
        return location.right > views.left;
      });
      assert.equal(overlap, false, "Room location must not overlap camera controls");
      return { overview: evidence, follow };
    });
  }
  await check("No browser runtime errors", async () => assert.deepEqual(pageErrors, []));
} catch (error) {
  console.error(error.stack);
  if (page) await page.screenshot({ path: `${directory}/failure.png`, fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  report.passed = report.cases.every((entry) => entry.passed);
  writeFileSync(`${directory}/qa-report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${directory}/qa-report.json`);
}
