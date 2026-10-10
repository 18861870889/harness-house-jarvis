import { describe, expect, it, vi } from "vitest";
import { createD1DemoHome } from "./adapters/d1DemoAdapter.js";
import { buildD1SemanticRequest, compileD1SemanticDecision, decideWithD1V3 } from "./d1SemanticDecision.js";
import { normalizeHcmPlannerDraft } from "./hcmPlanner.js";
import { deviceOperations } from "./deviceOperations.js";

const origin = room => ({ currentRoom: { id: room, name: room === "study" ? "书房" : "客厅", source: "configured_terminal" } });
const score = choice => ({ choice, probability: 0.99, margin: 0.98 });
function compile(input, { home = createD1DemoHome(), conversation = origin("study"), task = "power_on", extent = "matching", feedback = "none", target = "书房射灯", probability = 0.99 } = {}) {
  const pack = buildD1SemanticRequest({ input, home, conversation });
  const ids = pack.devices.filter(d => target === "lights" ? d.type === "light" : d.name === target).map(d => d.id);
  pack.targetChoices = { t0: { ids, label: target }, unclear: { ids: [], label: "未知目标" } };
  const classification = { answers: { task: { ...score(task), probability }, extent: score(extent), feedback: score(feedback), target_form: score("named") }, target: score("t0"), latencyMs: 10 };
  if (task === "set_value") {
    const device = pack.devices.find(d => ids.includes(d.id));
    const op = device && deviceOperations(device, home).find(o => o.operation === "set_temperature");
    if (op) { pack.deviceOperationChoices = { op0: op }; classification.deviceOperation = score("op0"); }
  }
  return { draft: compileD1SemanticDecision({ input, home, conversation, pack, classification }), pack, home };
}

describe("D1 semantic contract v3", () => {
  it.each(["开下灯", "开一下灯", "打开书房射灯", "开一个灯"])("cannot offer an opposite operation for a literal on command: %s", input => {
    const pack = buildD1SemanticRequest({ input, home: createD1DemoHome(), conversation: origin("study") });
    expect(pack.questions.task.criteria.power_on).toBeDefined();
    expect(pack.questions.task.criteria.power_off).toBeUndefined();
  });

  it.each(["关下灯", "关闭书房射灯", "关掉灯"])("cannot offer an opposite operation for a literal off command: %s", input => {
    const pack = buildD1SemanticRequest({ input, home: createD1DemoHome(), conversation: origin("study") });
    expect(pack.questions.task.criteria.power_off).toBeDefined();
    expect(pack.questions.task.criteria.power_on).toBeUndefined();
  });

  it.each(["不要开吊灯", "别关闭书房射灯", "空调如何打开", "风扇支持哪些功能"])("does not authorize writes for negation or method questions: %s", input => {
    const pack = buildD1SemanticRequest({ input, home: createD1DemoHome(), conversation: origin("study") });
    expect(pack.questions.task.criteria.power_on).toBeUndefined();
    expect(pack.questions.task.criteria.power_off).toBeUndefined();
    expect(pack.questions.task.criteria.confirm).toBeUndefined();
  });

  it("excludes the named local light without forbidding every light in the room", () => {
    const pack = buildD1SemanticRequest({ input: "开射灯，但不要开吊灯", home: createD1DemoHome(), conversation: origin("study") });
    expect(pack.excludedIds).toHaveLength(1);
    expect(pack.devices.find(d => d.id === pack.excludedIds[0]).name).toBe("书房吊灯");
  });

  it("opens one light rather than grouping all room channels", () => {
    const { draft } = compile("开一个灯", { extent: "one", target: "lights" });
    expect(draft.actions).toHaveLength(1);
    expect(draft.actions[0].value).toBe(true);
    expect(draft.semanticFrame.extent).toBe("one");
  });

  it("compiles a partial light name to its exact logical endpoint", () => {
    const { draft, home } = compile("开射灯");
    const plan = normalizeHcmPlannerDraft("开射灯", draft, home, { strictSelection: true });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].logicalAssetName).toBe("书房射灯");
  });

  it("only-one is a final-state constraint, not one actuator call", () => {
    const home = createD1DemoHome();
    home.things.find(t => t.id === "study_panel").capabilities.slice(0, 2).forEach(c => { c.state = true; });
    const { draft } = compile("只开一个射灯吧", { home, extent: "only_one" });
    expect(draft.actions).toHaveLength(1);
    expect(draft.actions[0].device_id).toContain("书房吊灯");
    expect(draft.actions[0].value).toBe(false);
  });

  it("does not inject an old room's goal into new-room classification", () => {
    const pack = buildD1SemanticRequest({ input: "开下灯", home: createD1DemoHome(), conversation: { ...origin("study"), activeGoalTask: { roomId: "living", desiredOutcome: "dimmer" } } });
    expect(pack.state).not.toContain("dimmer");
    expect(pack.scope.roomIds).toEqual(["study"]);
  });

  it("keeps a revised request separate from a pending proposal", () => {
    const home = createD1DemoHome();
    const pack = buildD1SemanticRequest({ input: "只开一个射灯吧", home, conversation: { ...origin("study"), focusedTargets: [{ id: "asset_study_ceiling" }], pendingDecision: { roomIds: ["study"], label: "关闭书房吊灯", actions: [] } } });
    expect(pack.devices.filter(d => d.type === "light")).toHaveLength(2);
    expect(pack.state).toContain('本轮用户原话："只开一个射灯吧"');
    expect(pack.state).not.toContain("用户补充");
    expect(pack.questions.task.criteria.confirm).toBeUndefined();
  });

  it("answers actual position without using the room mentioned in the question as evidence", () => {
    const { draft } = compile("我在客厅吗", { task: "location_query" });
    expect(draft.summary).toContain("书房");
    expect(draft.actions).toEqual([]);
  });

  it("does not guess position from occupancy or selected UI rooms", () => {
    const { draft } = compile("我在哪", { task: "location_query", conversation: { selectedRoomId: "study", occupancy: { roomId: "study" } } });
    expect(draft.summary).toContain("无法确定");
    expect(draft.actions).toEqual([]);
  });

  it("continues a known dimming goal without leaf-choice probability dilution", () => {
    const home = createD1DemoHome();
    home.things.find(t => t.id === "study_panel").capabilities.slice(0, 2).forEach(c => { c.state = true; });
    const { draft } = compile("还是太亮", { home, task: "dimmer", extent: "default", target: "lights" });
    expect(draft.actions).toHaveLength(1);
    expect(draft.actions[0].value).toBe(false);
    expect(draft.goal.desired_outcome).toBe("dimmer");
  });

  it("does not treat unknown light states as off", () => {
    const home = createD1DemoHome();
    home.things.find(t => t.id === "study_panel").capabilities.slice(0, 2).forEach(c => { c.state = null; });
    const { draft } = compile("太暗了", { home, task: "brighter", target: "lights" });
    expect(draft.actions).toEqual([]);
    expect(draft.summary).toContain("没有已确认");
  });

  it("provides a specific feedback question without silently reversing actions", () => {
    const { draft } = compile("不合适", { task: "feedback", feedback: "dissatisfied", conversation: { ...origin("study"), activeGoalTask: { roomId: "study", desiredOutcome: "dimmer" } } });
    expect(draft.summary).toContain("太亮还是太暗");
    expect(draft.actions).toEqual([]);
  });

  it("explains an already-on excluded light and asks before closing it", () => {
    const home = createD1DemoHome();
    home.things.find(t => t.id === "study_panel").capabilities[1].state = true;
    const { draft } = compile("不要开吊灯", { home, task: "no_action" });
    expect(draft.actions).toEqual([]);
    expect(draft.summary).toContain("已经开着");
    expect(draft.proposal.actions[0].value).toBe(false);
  });

  it("does not turn a future preference into a current correction", () => {
    const home = createD1DemoHome();
    home.things.find(t => t.id === "study_panel").capabilities[1].state = true;
    const { draft } = compile("以后不要开吊灯", { home, task: "no_action" });
    expect(draft.proposal).toBeUndefined();
    expect(draft.actions).toEqual([]);
  });

  it("retains the write confidence boundary", () => {
    const { draft } = compile("开射灯", { probability: 0.64 });
    expect(draft.actions).toEqual([]);
    expect(draft.intent_frame.decision.mode).toBe("ask_clarification");
  });

  it("only exposes confirmation for a bare agreement, not an agreement with restrictions", () => {
    const home = createD1DemoHome();
    const conversation = { ...origin("study"), pendingDecision: { roomIds: ["study"], label: "打开吊灯", actions: [] } };
    expect(buildD1SemanticRequest({ input: "可以", home, conversation }).questions.task.criteria.confirm).toBeDefined();
    expect(buildD1SemanticRequest({ input: "可以，但不要开吊灯", home, conversation }).questions.task.criteria.confirm).toBeUndefined();
  });

  it("supports adjacent clauses without widening the excluded device set", () => {
    const pack = buildD1SemanticRequest({ input: "开射灯不要开吊灯", home: createD1DemoHome(), conversation: origin("study") });
    expect(pack.positive).toBe("开射灯");
    expect(pack.excludedIds.map(id => pack.devices.find(d => d.id === id).name)).toEqual(["书房吊灯"]);
  });

  it("does not mistake a generic bedroom alias for explicit disambiguation", () => {
    const home = createD1DemoHome(); home.spaces.find(r => r.id === "master").aliases = ["卧室"];
    const { draft } = compile("卧室的灯关一下", { home, task: "power_off", target: "lights" });
    expect(draft.actions).toEqual([]); expect(draft.summary).toContain("主卧还是次卧");
    home.spaces.push({ id: "ha-old-bedroom", name: "卧室", aliases: [] });
    expect(buildD1SemanticRequest({ input: "卧室的灯关一下", home, conversation: origin("study") }).block).toContain("主卧还是次卧");
  });

  it.each(["书房射灯打开了吗", "空调调到25度了吗", "吊灯关闭没有"])("never offers writes while checking past state: %s", input => {
    const pack = buildD1SemanticRequest({ input, home: createD1DemoHome(), conversation: origin("study") });
    expect(pack.questions.task.criteria.power_on).toBeUndefined(); expect(pack.questions.task.criteria.set_value).toBeUndefined();
    expect(pack.questions.task.criteria.state_query).toBeDefined();
  });

  it("cannot authorize another close while receiving past-action feedback", () => {
    const pack = buildD1SemanticRequest({ input: "关闭的太多了", home: createD1DemoHome(), conversation: origin("study") });
    expect(pack.questions.task.criteria.power_off).toBeUndefined();
    expect(pack.questions.task.criteria.feedback).toBeDefined();
  });

  it("does not interpret only-close-one as only-keep-one-on", () => {
    const home = createD1DemoHome(); home.things.find(t => t.id === "study_panel").capabilities.slice(0, 2).forEach(c => { c.state = true; });
    const { draft, pack } = compile("只关一盏灯", { home, task: "power_off", extent: "one", target: "lights" });
    expect(pack.questions.extent.criteria.only_one).toBeUndefined();
    expect(draft.actions).toHaveLength(1); expect(draft.actions[0].value).toBe(false);
  });

  it("does not claim only-one when an unrepresented light remains unknown", () => {
    const home = createD1DemoHome();
    home.things.push({ id: "unknown-light", name: "未知灯", type: "light", spaceId: "study", capabilities: [] });
    const { draft } = compile("只开一个射灯", { home, extent: "only_one" });
    expect(draft.actions).toEqual([]); expect(draft.summary).toContain("不能保证");
  });

  it("does not accept target scores outside the probability range", () => {
    const home = createD1DemoHome(); const input = "开射灯"; const conversation = origin("study");
    const pack = buildD1SemanticRequest({ input, home, conversation }); pack.targetChoices = { t0: { ids: [], label: "unknown" } };
    const answers = { task: score("power_on"), extent: score("matching"), feedback: score("none"), target_form: score("named") };
    expect(() => compileD1SemanticDecision({ input, home, conversation, pack, classification: { answers, target: { ...score("t0"), probability: 5 } } })).toThrow("invalid_semantic_target");
  });

  it("rejects a classifier answer that violates the literal direction schema", () => {
    expect(() => compile("开下灯", { task: "power_off" })).toThrow("invalid_semantic_decision");
  });

  it("rejects an invalid temperature rather than inventing a range", () => {
    const { draft } = compile("把书房空调调到99度", { task: "set_value", target: "书房空调" });
    expect(draft.actions).toEqual([]);
    expect(draft.summary).toContain("范围");
  });

  it.each(["开两盏灯", "开0个灯", "开10盏灯", "开十一盏灯"])("does not silently reinterpret an unsupported exact count: %s", input => {
    const pack = buildD1SemanticRequest({ input, home: createD1DemoHome(), conversation: origin("study") });
    expect(pack.unsupportedCount).toBe(true);
  });

  it("accepts a known temperature range without changing another capability", () => {
    const { draft } = compile("把书房空调调到24度", { task: "set_value", target: "书房空调" });
    expect(draft.actions).toHaveLength(1); expect(draft.actions[0].value).toEqual({ operation: "set_temperature", argument: 24 });
  });

  it("performs no write while querying a sensor", () => {
    const { draft } = compile("入户人体传感器目前是什么状态", { task: "state_query", target: "入户人体传感器" });
    expect(draft.actions).toEqual([]);
  });

  it("prefers identified device power over unrelated boolean attributes", () => {
    const home = createD1DemoHome(); const tv = home.things.find(t => t.id === "living_tv");
    tv.capabilities.unshift({ ...structuredClone(tv.capabilities[0]), id: "mute", name: "静音" });
    const { draft } = compile("打开客厅电视", { home, target: "客厅电视" });
    expect(draft.actions).toHaveLength(1); expect(draft.actions[0].capability).toBe("tv_power");
  });

  it("does not select the first boolean when device power is ambiguous", () => {
    const home = createD1DemoHome(); const tv = home.things.find(t => t.id === "living_tv");
    tv.capabilities[0].name = "播放"; tv.capabilities[0].id = "play";
    tv.capabilities.unshift({ ...structuredClone(tv.capabilities[0]), id: "mute", name: "静音" });
    const { draft } = compile("打开客厅电视", { home, target: "客厅电视" });
    expect(draft.actions).toEqual([]); expect(draft.summary).toContain("整体开关能力不明确");
  });

  it("describes confirmed single-feeding separately from arbitrary HA button execution", () => {
    const home = createD1DemoHome(); const seed = home.things.find(t => t.id === "living_tv").capabilities[0];
    home.things.push({ id: "feeder", name: "书房猫粮机", type: "feeder", spaceId: "study", capabilities: [{ ...structuredClone(seed), id: "feed", name: "定量出粮按钮", kind: "action", binding: { provider: "home_assistant", domain: "button", entityId: "button.demo_feed" } }] });
    const { draft } = compile("书房猫粮机如何控制", { home, task: "capability_query", target: "书房猫粮机" });
    expect(draft.actions).toEqual([]); expect(draft.summary).toContain("投喂一次"); expect(draft.summary).toContain("需确认");
    expect(draft.summary).not.toContain("只有状态读取");
  });

  it("never makes target-selection calls for a position query", async () => {
    const client = { classify: vi.fn(async () => ({ answers: { task: score("location_query"), extent: score("default"), feedback: score("none"), target_form: score("unclear") }, latencyMs: 1 })) };
    const draft = await decideWithD1V3({ input: "我在哪", home: createD1DemoHome(), conversation: origin("study"), client });
    expect(draft.summary).toContain("书房");
    expect(client.classify).toHaveBeenCalledTimes(1);
  });
});
