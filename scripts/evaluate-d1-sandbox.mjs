import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createD1Client } from "../src/d1Client.js";
import { createSandboxService } from "../src/sandbox/sandboxService.js";
import { prepareHaHouse } from "../src/sandbox/haHouse.js";
import { compileHcmForPlanner } from "../src/hcmPlanner.js";
import { actorRoom } from "../src/sandbox/houseBlueprint.js";

const source = process.env.HARNESS_SANDBOX_SOURCE_DIRECTORY;
if (!source) throw new Error("Set HARNESS_SANDBOX_SOURCE_DIRECTORY to a local HA cache; no HA network access is used.");
const json = path => JSON.parse(readFileSync(path, "utf8"));
const house = prepareHaHouse(json(resolve(source, "home_model_cache.json")), json(resolve(source, "data/home-model-overlay.local.json")), json(resolve(source, "data/spatial-editor.local.json")));
const client = createD1Client({ endpoint: process.env.D1_ENDPOINT ?? "http://192.168.1.154:8080/v1/systemone", timeoutMs: 5000 });
const directory = resolve("build/house-sandbox"); mkdirSync(directory, { recursive: true });
const report = { createdAt: new Date().toISOString(), suite: "d1-semantic-v3-house", realDeviceWrites: 0, model: client.model, inventory: { rooms: house.blueprint.rooms.length, physicalDevices: house.home.things.length, logicalAssets: house.home.controlGraph.assets.length }, cases: [] };
const details = [];
const lightStates = (home, room) => compileHcmForPlanner(home, { limit: 10000 }).filter(d => d.type === "light" && d.roomId === room).map(d => ({ id: d.id, name: d.name, on: d.capabilities.find(c => c.access === "execute" && c.valueType === "boolean")?.state }));
const setLights = (home, room, on, name) => {
  for (const asset of home.controlGraph.assets.filter(a => a.spaceId === room && a.type === "light" && (!name || a.name === name))) {
    const endpoint = home.controlGraph.endpoints.find(e => e.id === asset.primaryEndpointId);
    const cap = home.things.find(t => t.id === endpoint.providerThingId).capabilities.find(c => c.id === endpoint.capabilityId);
    cap.state = on; cap.binding.currentState = on === null ? "unknown" : on ? "on" : "off";
    endpoint.state = on; asset.state.commandedState = on;
  }
};
const check = (name, result, snapshot, verify, elapsedMs) => {
  let error;
  try { assert(!["failed", "execution_unknown", "cancelled"].includes(result.status), result.summary); verify(result, snapshot); } catch (failure) { error = failure.message; }
  report.cases.push({ name, passed: !error, status: result.status, task: result.d1?.semanticFrame?.task, extent: result.d1?.semanticFrame?.extent, actions: result.actions?.length ?? 0, modelMs: result.d1?.latencyMs, elapsedMs, ...(error ? { error } : {}) });
  details.push({ name, result, snapshot });
  console.log(`${error ? "FAIL" : "PASS"} ${name}: ${result.summary}`);
};
let service;
try {
  service = await createSandboxService({ client, decisionVersion: "v3", initialHome: house.home, blueprint: house.blueprint, baselineId: house.baselineId });
  const recordingPath = process.env.SANDBOX_USER_RECORDING;
  const recording = recordingPath ? json(recordingPath) : null;
  if (recording) assert.equal(recording.baselineId, house.baselineId, "user_recording_baseline_mismatch");
  const defaults = [
    ["打开书房射灯", "study"], ["开下灯", "living"], ["太凉了", "living"], ["太亮了", "living"], ["还是太亮", "living"],
    ["客厅还是太亮了", "living"], ["客厅太亮了", "living"], ["开下灯", "second"], ["开下灯", "second"], ["不行，太亮了，暗一点", "second"],
    ["只开一个射灯吧", "second"], ["不合适", "second"], ["我在次卧吗", "second"], ["关灯", "second"], ["关闭的太多了", "second"],
    ["把次卧灯和客厅灯都关了", "master"], ["开一个灯", "study"], ["开射灯", "study"], ["不要开吊灯", "study"],
  ];
  const turns = recording ? recording.events.map(e => ({ input: e.request.input, pose: e.request.pose, session: e.request.sessionId, resume: Boolean(e.request.resumeFor) }))
    : defaults.map(([input, room], i) => ({ input, pose: house.blueprint.roomSpawns[room], session: i ? "user" : "warmup", resume: [3, 5, 6, 10, 12, 13].includes(i) }));
  assert.equal(turns.length, 19, "requires_warmup_and_18_user_turns");
  const pending = new Map();
  for (const [index, turn] of turns.entries()) {
    const before = service.snapshot();
    const room = actorRoom(turn.pose, house.blueprint);
    const start = performance.now();
    const request = { commandId: `user-${index}`, sessionId: `session-${turn.session}`, input: turn.input, pose: turn.pose, source: "replay", ...(turn.resume && pending.has(turn.session) ? { resumeFor: pending.get(turn.session) } : {}) };
    const { result, snapshot } = await service.command(request);
    if (result.status === "needs_clarification") pending.set(turn.session, request.commandId); else pending.delete(turn.session);
    check(`user-${index}: ${turn.input}`, result, snapshot, (r, s) => {
      const actions = r.actions ?? [];
      if ([0, 1, 7, 8, 16, 17].includes(index)) {
        assert(["executed", "answered"].includes(r.status), "explicit_on_unnecessarily_blocked");
        assert(actions.every(a => a.value === true), "on_became_off");
        assert(actions.length <= 1, "more_than_one_opened");
      }
      if ([3, 4, 5, 6, 9].includes(index)) {
        assert.equal(r.d1.semanticFrame.task, "dimmer");
        assert(actions.every(a => a.value === false || typeof a.value === "number"), "dimming_became_brighter");
        assert(actions.length <= 1);
        if (lightStates(before.home, room).some(d => d.on === true)) assert.equal(r.status, "executed", "actionable_dimming_blocked");
        else assert.equal(r.status, "needs_clarification", "invented_further_dimming");
      }
      if (index === 2) { assert.equal(r.d1.semanticFrame.task, "warmer"); assert(r.summary.includes("温") || r.summary.includes("空调")); }
      if (index === 10) { const on = lightStates(s.home, room).filter(d => d.on === true); assert.equal(on.length, 1); assert(on[0].name.includes("射灯")); }
      if ([11, 14].includes(index)) { assert.equal(r.status, "needs_clarification"); assert.equal(actions.length, 0); assert(!r.summary.includes("无法确定你想")); }
      if (index === 12) { assert.equal(r.status, "answered"); assert(r.summary.includes("次卧")); assert.equal(s.effects, before.effects); }
      if (index === 13) assert(lightStates(s.home, "second").every(d => d.on === false));
      if (index === 15) { assert(["executed", "answered"].includes(r.status)); assert(actions.every(a => ["living", "second"].includes(a.logicalRoomId) && a.value === false)); assert(lightStates(s.home, "living").concat(lightStates(s.home, "second")).every(d => d.on === false)); }
      if (index === 17) assert(actions.every(a => a.logicalAssetName === "书房射灯"));
      if (index === 18) { assert.equal(actions.length, 0); assert.equal(r.status, "needs_clarification"); assert(r.summary.includes("已经开着")); assert(r.proposal.actions.every(a => a.value === false)); }
      if (index !== 15) assert(actions.every(a => a.logicalRoomId === room), "cross_room_effect");
    }, Math.round(performance.now() - start));
  }
  await service.close(); service = null;
  const noWrite = (r, s) => { assert.equal(r.actions.length, 0); assert.equal(s.effects, 0); };
  const oneOn = (r, s, room = "study", name) => { assert.equal(r.status, "executed"); assert.equal(r.actions.length, 1); assert.equal(r.actions[0].value, true); assert.equal(r.actions[0].logicalRoomId, room); if (name) assert.equal(r.actions[0].logicalAssetName, name); assert(lightStates(s.home, room).some(d => d.on)); };
  const onlySpot = (r, s) => { assert(["executed", "answered"].includes(r.status)); const on = lightStates(s.home, "second").filter(d => d.on === true); assert.equal(on.length, 1); assert(on[0].name.includes("射灯")); };
  const holdout = [
    { name: "soft-on", input: "开一下灯", room: "second", verify: (r, s) => oneOn(r, s, "second") },
    { name: "one-light", input: "打开一盏灯", verify: oneOn },
    { name: "cross-room-exact", input: "把书房射灯打开", room: "living", verify: (r, s) => oneOn(r, s, "study", "书房射灯") },
    { name: "mixed-direction", input: "把吊灯关掉，把射灯打开", setup: h => setLights(h, "study", true, "书房吊灯"), verify: (r, s) => { assert.equal(r.status, "executed"); assert.equal(r.actions.length, 2); const lamps = lightStates(s.home, "study"); assert(lamps.find(d => d.name === "书房射灯").on); assert.equal(lamps.find(d => d.name === "书房吊灯").on, false); } },
    { name: "on-with-exclusion", input: "开射灯，但不要开吊灯", verify: (r, s) => oneOn(r, s, "study", "书房射灯") },
    { name: "negative-command", input: "先别动灯", verify: noWrite },
    { name: "adjacent-positive-and-negative", input: "开射灯不要开吊灯", verify: (r, s) => oneOn(r, s, "study", "书房射灯") },
    { name: "unknown-specific-light-not-default", input: "打开落地灯", verify: (r, s) => { noWrite(r, s); assert.equal(r.status, "needs_clarification"); } },
    { name: "read-only-state", input: "灯现在开着吗", verify: (r, s) => { noWrite(r, s); assert.equal(r.status, "answered"); assert.equal(r.d1.semanticFrame.task, "state_query"); } },
    { name: "past-state-not-new-command", input: "书房射灯打开了吗", verify: (r, s) => { noWrite(r, s); assert.equal(r.status, "answered"); assert.equal(r.d1.semanticFrame.task, "state_query"); } },
    { name: "non-dimmable-capability", input: "书房吊灯支持调光吗", verify: (r, s) => { noWrite(r, s); assert.equal(r.status, "answered"); assert(r.summary.includes("书房吊灯")); assert(!/支持.*亮度/.test(r.summary)); } },
    { name: "non-dimmable-set-value", input: "书房吊灯调到50%", verify: (r, s) => { noWrite(r, s); assert.equal(r.status, "needs_clarification"); } },
    { name: "ambiguous-bedroom", input: "卧室的灯关一下", verify: (r, s) => { noWrite(r, s); assert.equal(r.status, "needs_clarification"); assert(r.summary.includes("主卧还是次卧")); } },
    { name: "ungrounded-pronoun", input: "把那个关了", verify: (r, s) => { noWrite(r, s); assert.equal(r.status, "needs_clarification"); } },
    { name: "location-not-query-room", input: "我在次卧吗", verify: (r, s) => { noWrite(r, s); assert.equal(r.status, "answered"); assert(r.summary.includes("书房")); } },
    { name: "unsupported-exact-count", input: "开两盏灯", verify: (r, s) => { noWrite(r, s); assert.equal(r.status, "needs_clarification"); } },
    { name: "negative-already-on", input: "不要开射灯", setup: h => setLights(h, "study", true, "书房射灯"), verify: (r, s) => { noWrite(r, s); assert.equal(r.status, "needs_clarification"); assert(r.summary.includes("已经开着")); } },
    { name: "one-off-not-only-one-on", input: "只关一盏灯", setup: h => setLights(h, "study", true), verify: (r, s) => { assert.equal(r.status, "executed"); assert.equal(r.actions.length, 1); assert.equal(r.actions[0].value, false); assert.equal(lightStates(s.home, "study").filter(d => d.on === true).length, 1); } },
    { name: "retain-one-final-state", input: "只留一盏射灯，其他灯关掉", room: "second", setup: h => setLights(h, "second", true), verify: onlySpot },
    { name: "only-one-final-state", input: "只开一个射灯吧", room: "second", setup: h => setLights(h, "second", true), verify: onlySpot },
    { name: "contradicting-exclusion", input: "只开一个射灯，别碰吊灯", setup: h => setLights(h, "study", true), verify: (r, s) => { noWrite(r, s); assert.equal(r.status, "needs_clarification"); } },
    { name: "out-of-range-temperature", input: "把书房空调调到99度", verify: (r, s) => { noWrite(r, s); assert.equal(r.status, "needs_clarification"); } },
    { name: "dimming-exhausted", input: "还是太亮", verify: (r, s) => { noWrite(r, s); assert.equal(r.status, "needs_clarification"); assert(r.summary.includes("进一步调暗")); } },
    { name: "unknown-state-no-comfort-guess", input: "太暗了", setup: h => setLights(h, "study", null), verify: (r, s) => { noWrite(r, s); assert.equal(r.status, "needs_clarification"); } },
    { name: "brighter-other-light", input: "还是太暗了", setup: h => setLights(h, "study", true, "书房射灯"), verify: (r, s) => oneOn(r, s, "study", "书房吊灯") },
    { name: "fresh-dimming-expression", input: "灯光有点晃眼，柔和些", setup: h => setLights(h, "study", true), verify: r => { assert.equal(r.status, "executed"); assert.equal(r.actions.length, 1); assert.equal(r.actions[0].value, false); } },
    { name: "curtain-method-not-control", input: "窗帘怎么打开", room: "living", verify: (r, s) => { noWrite(r, s); assert(["answered", "needs_clarification"].includes(r.status)); } },
    { name: "cross-room-category-and-name", input: "关掉书房吊灯和客厅的灯", room: "master", setup: h => { setLights(h, "study", true); setLights(h, "living", true); }, verify: (r, s) => { assert.equal(r.status, "executed"); assert(r.actions.every(a => a.value === false)); assert.equal(lightStates(s.home, "study").find(d => d.name === "书房射灯").on, true); assert(lightStates(s.home, "living").every(d => d.on === false)); } },
    { name: "future-preference-not-current-action", input: "以后不要开吊灯", setup: h => setLights(h, "study", true), verify: (r, s) => { noWrite(r, s); assert.equal(r.proposal, undefined); } },
  ];
  for (const [index, test] of holdout.entries()) {
    const home = structuredClone(house.home); test.setup?.(home);
    service = await createSandboxService({ client, decisionVersion: "v3", initialHome: home, blueprint: house.blueprint });
    const start = performance.now();
    const { result, snapshot } = await service.command({ input: test.input, pose: house.blueprint.roomSpawns[test.room ?? "study"], commandId: `extra-${index}`, sessionId: "holdout", source: "text" });
    check(`holdout-${test.name}`, result, snapshot, test.verify, Math.round(performance.now() - start));
    await service.close(); service = null;
  }
  const sequences = [
    { name: "confirm-stored-negative-correction", turns: ["不要开吊灯", "可以"], setup: h => setLights(h, "study", true, "书房吊灯"), verify: (r, s) => { assert.equal(r.status, "executed"); assert.equal(r.actions.length, 1); assert.equal(r.actions[0].logicalAssetName, "书房吊灯"); assert.equal(r.actions[0].value, false); assert.equal(lightStates(s.home, "study").find(d => d.name === "书房吊灯").on, false); } },
    { name: "revised-reply-not-old-action", turns: ["不要开吊灯", "不用，开射灯"], setup: h => setLights(h, "study", true, "书房吊灯"), verify: (r, s) => { oneOn(r, s, "study", "书房射灯"); assert.equal(lightStates(s.home, "study").find(d => d.name === "书房吊灯").on, true); } },
    { name: "state-query-pronoun-follow-up", turns: ["书房吊灯现在开着吗", "把它打开"], verify: (r, s) => oneOn(r, s, "study", "书房吊灯") },
    { name: "default-on-idempotent-new-command", turns: ["开灯", "开灯"], verify: (r, s) => { assert.equal(r.status, "answered"); assert.equal(r.actions.length, 0); assert.equal(s.effects, 1); } },
    { name: "closed-too-many-restore-after-confirmation", turns: ["关一个灯", "关闭的太多了", "可以"], setup: h => setLights(h, "study", true), verify: (r, s) => { assert.equal(r.status, "executed"); assert.equal(r.actions.length, 1); assert.equal(r.actions[0].value, true); assert.equal(lightStates(s.home, "study").filter(d => d.on === true).length, 2); assert.equal(s.effects, 2); } },
  ];
  for (const [index, test] of sequences.entries()) {
    const home = structuredClone(house.home); test.setup?.(home);
    service = await createSandboxService({ client, decisionVersion: "v3", initialHome: home, blueprint: house.blueprint });
    let previous;
    const intermediates = [];
    const start = performance.now();
    for (const [i, input] of test.turns.entries()) {
      const id = `sequence-${index}-${i}`;
      previous = await service.command({ input, pose: house.blueprint.roomSpawns.study, commandId: id, sessionId: "holdout", source: "text", ...(previous?.result.status === "needs_clarification" ? { resumeFor: `sequence-${index}-${i - 1}` } : {}) });
      intermediates.push({ input, result: previous.result });
    }
    check(`sequence-${test.name}`, previous.result, previous.snapshot, test.verify, Math.round(performance.now() - start));
    details.at(-1).intermediates = intermediates;
    await service.close(); service = null;
  }
  report.passed = report.cases.every(c => c.passed);
} finally {
  await service?.close();
  report.passed ??= false;
  report.totals = { passed: report.cases.filter(c => c.passed).length, failed: report.cases.filter(c => !c.passed).length };
  const timings = report.cases.map(c => c.elapsedMs).sort((a, b) => a - b);
  report.latency = { medianMs: timings[Math.floor(timings.length / 2)], p95Ms: timings[Math.ceil(timings.length * 0.95) - 1] };
  writeFileSync(resolve(directory, "semantic-v3-qa.local.json"), `${JSON.stringify({ report, details }, null, 2)}\n`);
  console.log(JSON.stringify(report.totals));
  if (!report.passed) process.exitCode = 1;
}
