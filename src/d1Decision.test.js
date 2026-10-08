import { describe, expect, it, vi } from "vitest";
import { buildD1Candidates, decideWithD1 } from "./d1Decision.js";
import { createD1DemoAdapter, createD1DemoHome } from "./adapters/d1DemoAdapter.js";
import { compileHcmForPlanner, normalizeHcmPlannerDraft } from "./hcmPlanner.js";
import { buildHcmExecutionPlan } from "./hcmExecutor.js";
import { simulateProviderExecutionPlan, executeSimulatedProviderPlan, verifyProviderExecutionResults } from "./providerExecutionRuntime.js";
import { createConversationContextStore } from "./conversationContext.js";

function fakeClient(selector, { probability = 0.99, margin = 0.98 } = {}) {
  return { choose: vi.fn(async ({ candidates }) => ({ candidate: candidates.find(selector), probability, margin, probabilities: {} })) };
}

describe("D1 HCM candidates and strict execution", () => {
  it("derives a logical light from a controller in a different room", async () => {
    const home = createD1DemoHome();
    const client = fakeClient((candidate) => candidate.label === "打开餐厅射灯");
    const draft = await decideWithD1({ input: "打开餐厅射灯", home, client });
    const plan = normalizeHcmPlannerDraft("打开餐厅射灯", draft, home, { strictSelection: true });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ thingId: "entry_panel", logicalRoomId: "dining", capabilityId: "dining_spot", value: true });
    expect(buildHcmExecutionPlan(plan.actions, home).accepted[0].serviceCall.serviceData.entity_id).toBe("switch.demo_dining_spot");
  });

  it("includes opposite multi-target directions without hardcoding a test answer", () => {
    const { candidates } = buildD1Candidates({ input: "打开书房射灯，但关闭书房吊灯", home: createD1DemoHome() });
    expect(candidates.some((candidate) => candidate.actions.length === 2 && candidate.actions[0].value !== candidate.actions[1].value)).toBe(true);
    expect(candidates.every((candidate) => candidate.actions.every((action) => !action.device_id.includes("unused")))).toBe(true);
  });

  it.each(["把它关了", "关闭卧室灯", "开灯", "打开空气净化器", "把书房空调调到99度"])("blocks unsafe or unsupported target/value: %s", async (input) => {
    const home = createD1DemoHome();
    const conversation = { focusedTargets: [{ id: "one", name: "射灯" }, { id: "two", name: "吊灯" }] };
    const client = fakeClient(() => true);
    const draft = await decideWithD1({ input, home, conversation, client });
    expect(client.choose).toHaveBeenCalledTimes(1);
    expect(draft.actions).toEqual([]);
    expect(draft.d1.scopeBlock).toBeTruthy();
  });

  it("does not infer user location from the selected UI room", () => {
    const pack = buildD1Candidates({ input: "开灯", home: createD1DemoHome(), selectedRoomId: "study" });
    expect(pack.block).toBeTruthy();
    expect(pack.candidates.every((candidate) => candidate.actions.length === 0)).toBe(true);
  });

  it("keeps session room scope but allows explicit room override", () => {
    const home = createD1DemoHome();
    const conversation = { focusedRooms: [{ id: "study" }] };
    expect(buildD1Candidates({ input: "关闭灯", home, conversation }).devices.every((device) => device.roomId === "study")).toBe(true);
    expect(buildD1Candidates({ input: "打开餐厅灯", home, conversation }).devices.every((device) => device.roomId === "dining")).toBe(true);
  });

  it("follows a single recent target and never an expired session", () => {
    const home = createD1DemoHome();
    let time = 0;
    const store = createConversationContextStore({ now: () => time, ttlMs: 10 });
    store.record("test", { input: "打开客厅电视", plan: { actions: [{ thingId: "living_tv", thingName: "客厅电视", logicalRoomId: "living" }] }, execution: { status: "dry_run" } });
    expect(buildD1Candidates({ input: "把它关了", home, conversation: store.get("test") }).devices.map((device) => device.id)).toEqual(["living_tv"]);
    time = 11;
    expect(buildD1Candidates({ input: "把它关了", home, conversation: store.get("test") }).block).toBeTruthy();
  });

  it("low-confidence choices cause clarification, not actuation", async () => {
    const draft = await decideWithD1({ input: "打开客厅电视", home: createD1DemoHome(), client: fakeClient((candidate) => candidate.actions.length, { probability: 0.5, margin: 0.01 }) });
    expect(draft.actions).toEqual([]);
    expect(draft.intent_frame.decision.mode).toBe("ask_clarification");
  });

  it("query containing 打开 never gains writes from local normalization", async () => {
    const home = createD1DemoHome();
    const input = "客厅电视怎么打开";
    const draft = await decideWithD1({ input, home, client: fakeClient((candidate) => candidate.id === "capabilities") });
    const plan = normalizeHcmPlannerDraft(input, draft, home, { strictSelection: true });
    expect(plan.actions).toEqual([]);
    expect(plan.intentType).not.toBe("device_control");
    expect(plan.stateQuery.thingName).toBe("客厅电视");
    expect(buildD1Candidates({ input, home }).candidates.every((candidate) => candidate.actions.length === 0)).toBe(true);
  });

  it("describes the logical light circuit rather than exposing its entire multi-gang controller", async () => {
    const home = createD1DemoHome();
    const input = "餐厅射灯怎么控制";
    const draft = await decideWithD1({ input, home, client: fakeClient((candidate) => candidate.id === "capabilities") });
    const plan = normalizeHcmPlannerDraft(input, draft, home, { strictSelection: true });
    expect(plan.stateQuery.thingName).toBe("餐厅射灯");
    expect(plan.stateQuery.summary).toContain("控制回路开关");
    expect(plan.stateQuery.items).toHaveLength(1);
    expect(plan.actions).toEqual([]);
  });

  it.each(["电视如何打开", "书房空调能否调到25度", "客厅窗帘支持哪些操作"])("method/capability questions cannot offer executable options: %s", (input) => {
    const pack = buildD1Candidates({ input, home: createD1DemoHome() });
    expect(pack.readOnly).toBe(true);
    expect(pack.candidates.every((candidate) => candidate.actions.length === 0)).toBe(true);
  });

  it("includes selective operations while retaining the explicitly excluded room group", () => {
    const pack = buildD1Candidates({ input: "书房灯不要开，但打开客厅电视", home: createD1DemoHome() });
    expect(pack.devices.map((device) => device.name)).toContain("书房射灯");
    expect(pack.candidates.some((candidate) => candidate.actions.length === 1 && candidate.actions[0].device_id === "living_tv" && candidate.actions[0].value === true && candidate.label.includes("保持不变"))).toBe(true);
    expect(pack.candidates.every((candidate) => candidate.actions.every((action) => action.device_id === "living_tv"))).toBe(true);
  });

  it.each(["别打开客厅电视", "不要关闭书房射灯", "先不动客厅窗帘", "不用开主卧灯"])("never interprets negation as an opposite control: %s", (input) => {
    expect(buildD1Candidates({ input, home: createD1DemoHome() }).candidates.every((candidate) => candidate.actions.length === 0)).toBe(true);
  });

  it("rejects multiple numeric parameters instead of duplicating the first number", () => {
    const pack = buildD1Candidates({ input: "书房空调24度，客厅窗帘30%", home: createD1DemoHome() });
    expect(pack.block).toBeTruthy();
    expect(pack.candidates.every((candidate) => candidate.actions.length === 0)).toBe(true);
  });

  it("reads the selected single light instead of silently broadening to the room", async () => {
    const home = createD1DemoHome();
    const input = "书房射灯现在是什么状态";
    const draft = await decideWithD1({ input, home, client: fakeClient((candidate) => candidate.id.startsWith("state:")) });
    const plan = normalizeHcmPlannerDraft(input, draft, home, { strictSelection: true });
    expect(plan.stateQuery.thingName).toBe("书房射灯");
    expect(plan.stateQuery.items).toBeUndefined();
  });

  it("keeps cancellation and clarification action-free even with residual control wording", () => {
    const home = createD1DemoHome();
    const plan = normalizeHcmPlannerDraft("还有书房射灯没关", { intent_type: "unknown", summary: "先不操作", actions: [], intent_frame: { decision: { mode: "ask_clarification" } } }, home, { strictSelection: true });
    expect(plan.actions).toEqual([]);
  });

  it("does not replace an ambiguous read-only request with a whole-house inventory", async () => {
    const home = createD1DemoHome();
    const input = "这个怎么用";
    const draft = await decideWithD1({ input, home, client: fakeClient((candidate) => candidate.id === "clarify") });
    const plan = normalizeHcmPlannerDraft(input, draft, home, { strictSelection: true });
    expect(plan.stateQuery).toBeNull();
    expect(plan.requiresClarification).toBe(true);
  });

  it("automatically includes a newly discovered HCM device and supports renamed aliases", () => {
    const home = createD1DemoHome();
    const template = structuredClone(home.things.find((thing) => thing.id === "living_tv"));
    template.id = "new_device";
    template.name = "书房显示器";
    template.aliases = ["工作屏"];
    template.spaceId = "study";
    home.things.push(template);
    expect(buildD1Candidates({ input: "打开工作屏", home }).devices.map((device) => device.id)).toEqual(["new_device"]);
  });

  it("runs the existing safety, service simulator and verifier against memory only", async () => {
    const adapter = createD1DemoAdapter();
    const home = await adapter.discoverHcmHome();
    const draft = await decideWithD1({ input: "打开餐厅射灯", home, client: fakeClient((candidate) => candidate.label === "打开餐厅射灯") });
    const plan = normalizeHcmPlannerDraft("打开餐厅射灯", draft, home, { strictSelection: true });
    const execution = buildHcmExecutionPlan(plan.actions, home);
    const simulation = await simulateProviderExecutionPlan({ adapter, home, accepted: execution.accepted });
    expect(simulation.ok).toBe(true);
    const results = await executeSimulatedProviderPlan({ adapter, simulation, commandId: "test-demo" });
    expect(results[0].result.simulated).toBe(true);
    expect((await verifyProviderExecutionResults({ adapter, results }))[0].verification.ok).toBe(true);
    expect((await adapter.discoverHcmHome()).things.find((thing) => thing.id === "entry_panel").capabilities[0].state).toBe(true);
  });

  it("rejects offline endpoints in the HA protocol simulator", async () => {
    const home = createD1DemoHome();
    home.things.find((thing) => thing.id === "entry_panel").online = false;
    const adapter = createD1DemoAdapter({ home });
    const draft = await decideWithD1({ input: "打开餐厅射灯", home, client: fakeClient((candidate) => candidate.label === "打开餐厅射灯") });
    const plan = normalizeHcmPlannerDraft("打开餐厅射灯", draft, home, { strictSelection: true });
    const simulation = await simulateProviderExecutionPlan({ adapter, home, accepted: buildHcmExecutionPlan(plan.actions, home).accepted });
    expect(simulation.ok).toBe(false);
    expect(simulation.rejected.length).toBe(1);
  });

  it("cannot execute memory changes without a matched simulation authorization", async () => {
    const adapter = createD1DemoAdapter();
    await expect(adapter.execute({ operation: "switch.turn_on" }, {})).rejects.toThrow("authorized");
  });

  it("the numeric proposal uses the explicit value and never a device number", () => {
    const home = createD1DemoHome();
    const pack = buildD1Candidates({ input: "书房空调调到24度", home });
    expect(pack.candidates.some((candidate) => candidate.actions[0]?.value === 24)).toBe(true);
    expect(buildD1Candidates({ input: "打开入户1号开关", home }).candidates.flatMap((candidate) => candidate.actions).some((action) => action.value === 1)).toBe(false);
  });

  it("does not replace unsupported brightness with a power switch", () => {
    const pack = buildD1Candidates({ input: "书房射灯亮度调到50%", home: createD1DemoHome() });
    expect(pack.block).toContain("数值调节能力");
    expect(pack.candidates.every((candidate) => candidate.actions.length === 0)).toBe(true);
  });

  it("checks the actual capability temperature step", () => {
    const home = createD1DemoHome();
    home.things.find((thing) => thing.id === "study_ac").capabilities[0].evidence = { constraints: { min: 18, max: 28, step: 0.5 } };
    expect(buildD1Candidates({ input: "书房空调调到24.1度", home }).block).toBeTruthy();
    expect(buildD1Candidates({ input: "书房空调调到24.5度", home }).block).toBeNull();
  });
});
