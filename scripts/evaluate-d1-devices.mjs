import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createD1Client } from "../src/d1Client.js";
import { createSandboxService } from "../src/sandbox/sandboxService.js";
import { createNonLightingFixture } from "../src/sandbox/nonLightingFixture.js";
import { prepareHaHouse } from "../src/sandbox/haHouse.js";
import { compileHcmForPlanner } from "../src/hcmPlanner.js";

const client = createD1Client({ endpoint: process.env.D1_ENDPOINT ?? "http://192.168.1.154:8080/v1/systemone", timeoutMs: 5000 });
const report = { createdAt: new Date().toISOString(), suite: "d1-non-light-devices-v3.1", source: "synthetic-HA-capability-fixture", model: client.model, realDeviceWrites: 0, cases: [] };
const directory = resolve("build/house-sandbox"); mkdirSync(directory, { recursive: true });
const cases = [
  ["打开书房空调", "study_ac", "climate.turn_on"], ["关闭书房空调", "study_ac", "climate.turn_off"],
  ["把书房空调调到24度", "study_ac", "climate.set_temperature", "temperature", 24],
  ["打开客厅风扇", "living_fan", "fan.turn_on"], ["关闭客厅风扇", "living_fan", "fan.turn_off"],
  ["客厅风扇风速设为75%", "living_fan", "fan.set_percentage", "percentage", 75], ["开启客厅风扇摇头", "living_fan", "fan.oscillate", "oscillating", true],
  ["关闭客厅风扇摇头", "living_fan", "fan.oscillate", "oscillating", false],
  ["打开客厅窗帘", "living_curtain", "cover.open_cover"], ["关闭客厅窗帘", "living_curtain", "cover.close_cover"],
  ["客厅窗帘开到30%", "living_curtain", "cover.set_cover_position", "position", 30], ["停止客厅窗帘移动", "living_curtain", "cover.stop_cover"],
  ["客厅音箱继续播放音乐", "speaker", "media_player.media_play"], ["暂停客厅音箱播放音乐", "speaker", "media_player.media_pause"], ["停止客厅音箱播放音乐", "speaker", "media_player.media_stop"],
  ["客厅音箱音量调到25%", "speaker", "media_player.volume_set", "volume_level", 0.25],
  ["客厅音箱音量大一点", "speaker", "media_player.volume_up"], ["客厅音箱音量小一点", "speaker", "media_player.volume_down"],
  ["把客厅音箱静音", "speaker", "media_player.volume_mute", "is_volume_muted", true],
  ["打开客厅电视", "living_tv", "button.press"], ["关闭客厅电视", "living_tv", "button.press"], ["客厅电视音量大一点", "living_tv", "button.press"],
  ["升起客厅晾衣杆", "rack", "cover.open_cover"], ["降下客厅晾衣杆", "rack", "cover.close_cover"],
  ["客厅扫地机器人开始清扫", "vacuum", "vacuum.start"], ["客厅扫地机器人停止清扫", "vacuum", "vacuum.stop"], ["客厅扫地机器人回充", "vacuum", "vacuum.return_to_base"],
  ["让客厅扫地机器人开始打扫", "vacuum", "vacuum.start"], ["停止客厅扫地机器人的清扫", "vacuum", "vacuum.stop"], ["让客厅扫地机器人返回充电座", "vacuum", "vacuum.return_to_base"],
];
const noWrite = (r, s) => { assert.equal(r.actions?.length ?? 0, 0); assert.equal(s.effects, 0); };
const scenarios = cases.map(([input, device, service, field, value]) => ({ input, verify: (r, s, before) => {
  assert.equal(r.status, "executed", JSON.stringify({ fields: r.d1?.fields, operation: r.d1?.deviceOperation })); assert.equal(r.actions.length, 1); assert.equal(r.actions[0].thingId, device);
  assert.equal(r.results[0].service, service); assert(r.results[0].verification.ok);
  if (field) assert.equal(r.results[0].serviceData[field], value);
  assert.deepEqual(s.home.things.filter(t => t.id !== device), before.things.filter(t => t.id !== device));
} }));
for (const input of ["暂停客厅音箱播放音乐", "停止客厅音箱播放音乐", "客厅风扇风速设为75%"]) {
  scenarios.push({ ...scenarios.find(c => c.input === input), pose: { x: -2, z: 1.1 } });
}
scenarios.push(
  { input: "书房空调调到99度", verify: noWrite }, { input: "客厅风扇风速设为33%", verify: noWrite },
  { input: "客厅窗帘开到120%", verify: noWrite }, { input: "客厅音箱音量调到99度", verify: noWrite },
  { input: "客厅猫粮机投喂两次", verify: noWrite }, { input: "客厅猫粮机投喂30克", verify: noWrite },
  { input: "客厅猫粮机怎么控制", verify: (r, s) => { noWrite(r, s); assert.equal(r.status, "answered"); assert(r.summary.includes("需确认")); } },
  { input: "客厅人在传感器目前状态", verify: (r, s) => { noWrite(r, s); assert.equal(r.status, "answered"); assert(r.summary.includes("有人")); } },
  { input: "停止客厅音箱播放音乐", setup: h => { h.things.find(t => t.id === "speaker").capabilities[0].binding.supportedFeatures = 1; }, verify: (r, s) => { noWrite(r, s); assert.equal(r.status, "needs_clarification"); assert(r.summary.includes("暂停")); } },
  { input: "升起客厅晾衣杆", setup: h => { h.things.find(t => t.id === "rack").capabilities[0].binding.domain = "switch"; }, verify: (r, s) => { noWrite(r, s); assert.equal(r.status, "needs_clarification"); } },
  { input: "客厅猫粮机投喂一次", turns: ["可以"], verify: (r, s) => { assert.equal(r.status, "executed"); assert.equal(s.effects, 1); assert.equal(s.home.things.find(t => t.id === "feeder").simulationState.feedCount, 1); } },
  { input: "客厅电视音量大一点", turns: ["客厅电视音量大一点"], verify: (r, s) => { assert.equal(r.status, "executed"); assert.equal(s.effects, 2); assert.equal(s.home.things.find(t => t.id === "living_tv").simulationState.buttonPresses, 2); } },
);
const source = process.env.HARNESS_SANDBOX_SOURCE_DIRECTORY;
if (source) {
  const json = path => JSON.parse(readFileSync(resolve(source, path), "utf8"));
  const house = prepareHaHouse(json("home_model_cache.json"), json("data/home-model-overlay.local.json"), json("data/spatial-editor.local.json"));
  const catalog = compileHcmForPlanner(house.home, { limit: 10000, includeConfirmable: true });
  const find = predicate => { const d = catalog.find(predicate); assert(d, "captured_device_not_found"); return d; };
  const speaker = find(d => d.type === "tv" && /小爱/.test(d.name));
  const tv = find(d => d.type === "tv" && /电视/.test(d.name));
  const fan = find(d => d.type === "fan");
  const curtain = find(d => d.type === "curtain");
  const ac = find(d => d.type === "ac" && d.roomId === "study");
  const feeder = find(d => d.type === "pet_feeder");
  const rack = find(d => d.type === "drying_rack");
  const actual = (input, device, service, field, value) => ({ input, device, house, captured: true, verify: (r, s, before) => {
    if (before.things.find(t => t.id === device.id).online === false) { noWrite(r, s); assert.equal(r.status, "needs_clarification"); assert(r.summary.includes("离线")); return; }
    assert.equal(r.status, "executed", JSON.stringify({ summary: r.summary, fields: r.d1?.fields, operation: r.d1?.deviceOperation })); assert.equal(r.actions.length, 1); assert.equal(r.actions[0].thingId, device.id);
    assert.equal(r.results[0].service, service); assert(r.results[0].verification.ok);
    if (field) assert.equal(r.results[0].serviceData[field], value);
    assert.deepEqual(s.home.things.filter(t => t.id !== device.id), before.things.filter(t => t.id !== device.id));
  } });
  scenarios.push(
    actual(`打开${ac.name}`, ac, "climate.turn_on"), actual(`打开${fan.name}`, fan, "fan.turn_on"),
    actual(`${fan.name}风速调到50%`, fan, "fan.set_percentage", "percentage", 50),
    actual(`${curtain.name}开到30%`, curtain, "cover.set_cover_position", "position", 30),
    actual(`打开${tv.name}`, tv, "button.press"), actual(`${tv.name}音量大一点`, tv, "button.press"),
    actual(`${speaker.name}继续播放音乐`, speaker, "media_player.media_play"),
    actual(`${speaker.name}音量调到25%`, speaker, "media_player.volume_set", "volume_level", 0.25),
    { ...actual(`停止${speaker.name}播放音乐`, speaker, "media_player.media_pause"), turns: ["可以"] },
    ...[[`${ac.name}调到24度`, ac], [`${feeder.name}投喂一次`, feeder], [`升起${rack.name}`, rack]].map(([input, device]) => ({ input, device, house, captured: true, verify: (r, s) => { noWrite(r, s); assert.equal(r.status, "needs_clarification"); } })),
  );
}
for (const [i, test] of scenarios.entries()) {
  const home = test.house ? structuredClone(test.house.home) : createNonLightingFixture(); test.setup?.(home);
  const service = await createSandboxService({ initialHome: home, decisionVersion: "v3", client, ...(test.house ? { blueprint: test.house.blueprint, baselineId: test.house.baselineId } : {}) });
  const start = performance.now(); let error, result;
  try {
    const request = { pose: test.pose ?? (test.house ? test.house.blueprint.roomSpawns[test.device.roomId] : { x: 2, z: -1 }), source: "text", sessionId: `devices-${i}` };
    let commandId = `devices-${i}-0`;
    result = await service.command({ ...request, commandId, input: test.input });
    for (const [j, input] of (test.turns ?? []).entries()) {
      const old = commandId; commandId = `devices-${i}-${j + 1}`;
      result = await service.command({ ...request, commandId, input, ...(result.result.status === "needs_clarification" ? { resumeFor: old } : {}) });
    }
    assert(!["failed", "execution_unknown", "cancelled"].includes(result.result.status), result.result.summary);
    test.verify(result.result, result.snapshot, home);
  } catch (failure) { error = failure.message; }
  finally { await service.close(); }
  report.cases.push({ input: test.input, followups: test.turns, source: test.captured ? "existing-local-HA-cache" : "synthetic-capability-fixture", passed: !error, status: result?.result.status, task: result?.result.d1?.semanticFrame?.task, operation: result?.result.actions?.[0]?.value?.operation,
    elapsedMs: Math.round(performance.now() - start), modelMs: result?.result.d1?.latencyMs, ...(error ? { error } : {}) });
  console.log(`${error ? "FAIL" : "PASS"} ${test.input}: ${result?.result.summary ?? error}`);
}
report.totals = { passed: report.cases.filter(c => c.passed).length, failed: report.cases.filter(c => !c.passed).length };
report.passed = report.totals.failed === 0;
const times = report.cases.map(c => c.elapsedMs).sort((a, b) => a - b);
report.latency = { medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.ceil(times.length * 0.95) - 1] };
writeFileSync(resolve(directory, "devices-v3.1-qa.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.totals));
if (!report.passed) process.exitCode = 1;
