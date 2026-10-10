import { describe, expect, it } from "vitest";
import { createNonLightingFixture } from "./sandbox/nonLightingFixture.js";
import { createSandboxService } from "./sandbox/sandboxService.js";
import { deviceOperations } from "./deviceOperations.js";
import { compileHcmForPlanner } from "./hcmPlanner.js";
import { decideWithD1V3 } from "./d1SemanticDecision.js";

function mockClient(home, cases) {
  const catalog = compileHcmForPlanner(home, { limit: 10000, includeConfirmable: true });
  const questionsSeen = [];
  return { questionsSeen, async classify({ state, questions }) {
    questionsSeen.push(questions);
    const input = JSON.parse(state.match(/本轮用户原话：(.*)\n/)[1]);
    const test = cases[input];
    if (!test) throw new Error(`Missing test classification: ${input}`);
    const answers = Object.fromEntries(Object.entries(questions).map(([key, q]) => {
      let choice = { task: test.task, extent: test.extent ?? "matching", target_form: test.targetForm ?? "named", feedback: "none" }[key];
      if (key === "operation") {
        const op = deviceOperations(catalog.find(d => d.id === test.device), home).find(o => o.operation === test.operation);
        choice = Object.entries(q.criteria).find(([, label]) => label === op?.label)?.[0] ?? "unsupported";
      }
      if (key === "target") choice = Object.entries(q.criteria).find(([, label]) => label.includes(catalog.find(d => d.id === test.device)?.name))?.[0] ?? "unclear";
      if (/^d\d+$/.test(key)) choice = test.directions?.[key] ?? "unclear";
      if (!Object.hasOwn(q.criteria, choice)) throw new Error(`Test choice ${key}/${choice} not in contract`);
      return [key, { choice, probability: test.probability ?? 0.98, margin: test.margin ?? 0.9 }];
    }));
    return { answers, latencyMs: 1 };
  } };
}
const conversation = room => ({ currentRoom: { id: room, name: room === "study" ? "书房" : "客厅", source: "configured_terminal" } });
const decision = (input, test, setup) => {
  const home = createNonLightingFixture(); setup?.(home);
  return decideWithD1V3({ input, home, conversation: conversation("living"), client: mockClient(home, { [input]: test }) });
};

describe("D1 non-light semantic contract and Pi simulation", () => {
  it.each([
    ["把书房空调调到24度", "study_ac", "set_value", "set_temperature", 24],
    ["客厅风扇风速设为75%", "living_fan", "set_value", "set_speed", 75],
    ["客厅音箱音量调到30%", "speaker", "set_value", "set_volume", 30],
    ["客厅窗帘开到20%", "living_curtain", "set_value", "set_position", 20],
    ["暂停客厅音箱播放音乐", "speaker", "device_action", "media_pause"],
    ["停止客厅音箱播放音乐", "speaker", "device_action", "media_stop"],
    ["开启客厅风扇摇头", "living_fan", "device_action", "oscillate_on"],
    ["降下客厅晾衣杆", "rack", "device_action", "lower"],
    ["客厅扫地机器人开始清扫", "vacuum", "device_action", "vacuum_start"],
  ])("grounds %s to its exact capability", async (input, device, task, op, argument) => {
    const draft = await decision(input, { device, task, operation: op });
    expect(draft.intent_frame.decision.mode).toBe("execute");
    expect(draft.actions).toHaveLength(1);
    expect(draft.actions[0]).toMatchObject({ device_id: device, value: { operation: op, ...(argument === undefined ? {} : { argument }) } });
    expect(draft.d1.deviceOperation).toBeDefined();
  });
  it.each([
    ["客厅音箱音量调到99度", "speaker", "set_volume"],
    ["书房空调温度调到50%", "study_ac", "set_temperature"],
    ["客厅风扇风速调到33%", "living_fan", "set_speed"],
    ["客厅窗帘开到120%", "living_curtain", "set_position"],
    ["客厅窗帘开到20%还是50%", "living_curtain", "set_position"],
    ["客厅猫粮机投喂两次", "feeder", "feed"],
    ["客厅猫粮机投喂12次", "feeder", "feed"],
    ["客厅猫粮机投喂0次", "feeder", "feed"],
    ["客厅猫粮机投喂30克", "feeder", "feed"],
    ["客厅猫粮机投喂半份", "feeder", "feed"],
    ["打开书房空调并调到24度", "study_ac", "set_temperature"],
  ])("asks rather than executing invalid parameters: %s", async (input, device, op) => {
    const draft = await decision(input, { device, task: op.startsWith("set_") ? "set_value" : "device_action", operation: op });
    expect(draft.intent_frame.decision.mode).toBe("ask_clarification");
    expect(draft.actions).toEqual([]);
    expect(draft.proposal).toBeUndefined();
  });
  it.each([0.64, 0.5])("rejects uncertain semantic decisions p=%s", async probability => {
    const draft = await decision("停止客厅音箱播放音乐", { device: "speaker", task: "device_action", operation: "media_stop", probability });
    expect(draft.actions).toEqual([]);
  });
  it("asks to pause when stop is unavailable, never powering off", async () => {
    const draft = await decision("停止客厅音箱播放音乐", { device: "speaker", task: "device_action", operation: "media_pause" }, home => { home.things.find(t => t.id === "speaker").capabilities[0].binding.supportedFeatures = 1; });
    expect(draft.actions).toEqual([]);
    expect(draft.summary).toContain("要暂停吗");
    expect(draft.proposal.actions[0].value).toEqual({ operation: "media_pause" });
  });
  it("does not invent a rack raising interface", async () => {
    const draft = await decision("升起客厅晾衣杆", { device: "rack", task: "device_action", operation: "raise" }, home => { home.things.find(t => t.id === "rack").capabilities[0].binding.domain = "switch"; });
    expect(draft.actions).toEqual([]);
    expect(draft.intent_frame.decision.mode).toBe("ask_clarification");
  });
  it("an explicit room excludes another room's globally unique generic alias", async () => {
    const draft = await decision("升起客厅晾衣杆", { device: "rack", task: "device_action", operation: "raise" }, home => {
      const other = structuredClone(home.things.find(t => t.id === "rack"));
      Object.assign(other, { id: "other_rack", name: "阳台晾衣杆", spaceId: "balcony", aliases: ["晾衣杆"] });
      home.spaces.push({ id: "balcony", name: "阳台" }); home.things.push(other);
    });
    expect(draft.actions).toHaveLength(1);
    expect(draft.actions[0].device_id).toBe("rack");
  });
  it("supports mixed lighting and curtain directions without touching auxiliary settings", async () => {
    const draft = await decision("关掉客厅灯，打开客厅窗帘", { task: "mixed_control", directions: { d0: "off", d1: "on" } }, home => { home.things.find(t => t.id === "living_light").capabilities[0].state = true; });
    expect(draft.actions).toHaveLength(2);
    expect(draft.actions.find(a => a.device_id === "living_light").value).toBe(false);
    expect(draft.actions.find(a => a.device_id === "living_curtain").value).toEqual({ operation: "power_on" });
  });
  it("reads a sensor without a write", async () => {
    const draft = await decision("客厅人在传感器当前状态", { device: "presence", task: "state_query" });
    expect(draft.actions).toEqual([]);
    expect(draft.query).toEqual({ mode: "state", device_id: "presence" });
  });
  it("describes feeder confirmation rather than promising calibration or custom grams", async () => {
    const draft = await decision("客厅猫粮机怎么控制", { device: "feeder", task: "capability_query" });
    expect(draft.actions).toEqual([]);
    expect(draft.summary).toContain("投喂一次");
    expect(draft.summary).toContain("需确认");
    expect(draft.summary).not.toContain("校准");
  });
  it("isolates offline devices", async () => {
    const draft = await decision("停止客厅音箱播放音乐", { device: "speaker", task: "device_action", operation: "media_stop" }, home => { home.things.find(t => t.id === "speaker").online = false; });
    expect(draft.actions).toEqual([]);
    expect(draft.summary).toContain("离线");
  });
  it("operation selection sees its bound device, not unrelated origin or prior goals", async () => {
    const home = createNonLightingFixture(), input = "暂停客厅音箱播放音乐";
    const client = mockClient(home, { [input]: { device: "speaker", task: "device_action", operation: "media_pause" } });
    const states = [], classify = client.classify;
    client.classify = async request => { states.push(request); return classify(request); };
    const draft = await decideWithD1V3({ input, home, client, conversation: { ...conversation("study"), activeGoalTask: { roomId: "living", desiredOutcome: "dimmer" } } });
    expect(draft.actions[0].value.operation).toBe("media_pause");
    const op = states.find(r => r.questions.operation);
    expect(op.state).toContain("客厅音箱");
    expect(op.state).not.toContain("可信发言房间");
    expect(op.state).not.toContain("未完成的目标");
  });
  it("grounds operation choices in available interfaces and keeps an unsupported exit", async () => {
    const home = createNonLightingFixture(), input = "客厅扫地机器人开始清扫";
    const client = mockClient(home, { [input]: { device: "vacuum", task: "device_action", operation: "vacuum_start" } });
    await decideWithD1V3({ input, home, client, conversation: conversation("living") });
    const op = client.questionsSeen.find(q => q.operation).operation;
    expect(op.instructions).toContain("候选操作均是该设备已接入的接口");
    expect(op.instructions).not.toContain("音乐");
    expect(Object.values(op.criteria)).toContain("扫地机器人开始清扫");
    expect(op.criteria.unsupported).toContain("要求的动作不在选项内");
  });

  it("confirms feeding once and deduplicates a retried command ID", async () => {
    const home = createNonLightingFixture();
    const client = mockClient(home, { "客厅猫粮机投喂一次": { device: "feeder", task: "device_action", operation: "feed" }, "可以": { task: "confirm" } });
    const service = await createSandboxService({ initialHome: home, decisionVersion: "v3", client });
    const request = { pose: { x: 2, z: -1 }, source: "text", sessionId: "feeding" };
    try {
      const first = await service.command({ ...request, commandId: "f1", input: "客厅猫粮机投喂一次" });
      expect(first.result.status).toBe("needs_clarification"); expect(first.snapshot.effects).toBe(0);
      const confirmed = { ...request, commandId: "f2", input: "可以", resumeFor: "f1" };
      const second = await service.command(confirmed);
      expect(second.result.status).toBe("executed"); expect(second.snapshot.effects).toBe(1);
      expect(second.snapshot.home.things.find(t => t.id === "feeder").simulationState.feedCount).toBe(1);
      expect(second.result.actions[0].confirmationGranted).toBe(true);
      const retry = await service.command(confirmed);
      expect(retry.snapshot.effects).toBe(1);
    } finally { await service.close(); }
  });
  it.each(["same-origin", "moved-origin", "expired"])("feeding confirmation boundary: %s", async variant => {
    const home = createNonLightingFixture(); let time = Date.now();
    const client = mockClient(home, { "客厅猫粮机投喂一次": { device: "feeder", task: "device_action", operation: "feed" }, "可以": { task: "confirm" } });
    const service = await createSandboxService({ initialHome: home, decisionVersion: "v3", client, now: () => time });
    const request = { pose: { x: -2, z: 1.1 }, source: "text", sessionId: "origin" };
    try {
      await service.command({ ...request, commandId: "o1", input: "客厅猫粮机投喂一次" });
      if (variant === "expired") time += 31 * 60 * 1000;
      const reply = await service.command({ ...request, commandId: "o2", input: "可以", resumeFor: "o1", ...(variant === "moved-origin" ? { pose: { x: 2, z: -1 } } : {}) });
      expect(reply.snapshot.effects).toBe(variant === "same-origin" ? 1 : 0);
      if (variant === "same-origin") expect(reply.result.status).toBe("executed");
      else expect(reply.result.actions ?? []).toEqual([]);
    } finally { await service.close(); }
  });
  it("a revised reply never feeds from the old proposal", async () => {
    const home = createNonLightingFixture();
    const client = mockClient(home, { "客厅猫粮机投喂一次": { device: "feeder", task: "device_action", operation: "feed" }, "不用，停止客厅音箱播放音乐": { device: "speaker", task: "device_action", operation: "media_stop" } });
    const service = await createSandboxService({ initialHome: home, decisionVersion: "v3", client });
    const request = { pose: { x: 2, z: -1 }, source: "text", sessionId: "revised" };
    try {
      await service.command({ ...request, commandId: "r1", input: "客厅猫粮机投喂一次" });
      const reply = await service.command({ ...request, commandId: "r2", input: "不用，停止客厅音箱播放音乐", resumeFor: "r1" });
      expect(reply.result.status).toBe("executed"); expect(reply.result.results[0].service).toBe("media_player.media_stop");
      expect(reply.snapshot.home.things.find(t => t.id === "feeder").simulationState).toBeUndefined();
    } finally { await service.close(); }
  });
  it("repeated IR button presses are separate actions, not a boolean on-state", async () => {
    const home = createNonLightingFixture();
    const client = mockClient(home, { "客厅电视音量大一点": { device: "living_tv", task: "device_action", operation: "volume_up" } });
    const service = await createSandboxService({ initialHome: home, decisionVersion: "v3", client });
    const request = { pose: { x: 2, z: -1 }, source: "text", sessionId: "ir", input: "客厅电视音量大一点" };
    try {
      await service.command({ ...request, commandId: "ir1" });
      const reply = await service.command({ ...request, commandId: "ir2" });
      expect(reply.result.status).toBe("executed"); expect(reply.snapshot.effects).toBe(2);
      expect(reply.snapshot.home.things.find(t => t.id === "living_tv").simulationState.buttonPresses).toBe(2);
    } finally { await service.close(); }
  });
});
