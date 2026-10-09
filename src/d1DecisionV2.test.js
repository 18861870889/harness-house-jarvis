import { describe, expect, it, vi } from "vitest";
import { buildD1DecisionPack, decideWithD1V2 } from "./d1DecisionV2.js";
import { createD1DemoHome } from "./adapters/d1DemoAdapter.js";
import { compileHcmForPlanner } from "./hcmPlanner.js";

const client = (select, scores = {}) => ({ choose: vi.fn(async ({ candidates }) => ({
  candidate: candidates.find(select), probability: 0.95, margin: 0.9, ...scores,
})) });
const focus = (home) => {
  const light = compileHcmForPlanner(home).find((device) => device.name === "书房射灯");
  return { focusedTargets: [{ id: light.id, name: light.name }], focusedRooms: [{ id: "study" }] };
};

describe("D1 joint decision contract", () => {
  it("makes one coherent choice without a contradictory independent purpose gate", async () => {
    const home = createD1DemoHome();
    const model = client((candidate) => candidate.actions[0]?.value === false, { purpose: { choice: "control", probability: 0.578, margin: 0.187 } });
    const draft = await decideWithD1V2({ input: "关一下", home, conversation: focus(home), client: model });
    expect(draft.actions[0].value).toBe(false);
    expect(draft.intent_frame.decision.mode).toBe("execute");
    expect(model.choose).toHaveBeenCalledTimes(1);
    expect(model.choose.mock.calls[0][0].purposeCandidates).toBeUndefined();
    expect(model.choose.mock.calls[0][0].instructions).toContain("当前这一轮");
    expect(draft.d1.contractVersion).toBe("2.0");
  });

  it.each([{ probability: 0.64, margin: 0.3 }, { probability: 0.95, margin: 0.19 }])("preserves the existing confidence thresholds: %j", async (scores) => {
    const draft = await decideWithD1V2({ input: "打开客厅灯", home: createD1DemoHome(), client: client((candidate) => candidate.actions.length, scores) });
    expect(draft.actions).toEqual([]);
    expect(draft.intent_frame.decision.mode).toBe("ask_clarification");
  });

  it("offers both capability answers and actual commands for polite requests", () => {
    const pack = buildD1DecisionPack({ input: "能否帮我把书房射灯打开一下", home: createD1DemoHome() });
    expect(pack.candidates.some((candidate) => candidate.decision.mode === "execute")).toBe(true);
    expect(pack.candidates.some((candidate) => candidate.decision.mode === "answer")).toBe(true);
    expect(pack.candidates.every((candidate) => candidate.decision && candidate.scope && candidate.actions)).toBe(true);
  });

  it.each(["不要打开书房射灯", "不用开主卧灯", "别关闭客厅灯"])("retains negative instructions as write boundaries: %s", (input) => {
    expect(buildD1DecisionPack({ input, home: createD1DemoHome() }).candidates.every((candidate) => candidate.actions.length === 0)).toBe(true);
  });

  it("uses fresh terminal location for generic room control, not stale discussion focus", () => {
    const home = createD1DemoHome();
    const pack = buildD1DecisionPack({ input: "开灯", home, conversation: { ...focus(home), currentRoom: { id: "living", source: "configured_terminal" } } });
    expect(pack.devices.every((device) => device.roomId === "living")).toBe(true);
    expect(pack.scope.source).toBe("terminal");
  });

  it("keeps an explicit referent in the conversation even after the speaker moves", () => {
    const home = createD1DemoHome();
    const pack = buildD1DecisionPack({ input: "把刚才那个关掉", home, conversation: { ...focus(home), currentRoom: { id: "living", source: "configured_terminal" } } });
    expect(pack.devices.map((device) => device.name)).toEqual(["书房射灯"]);
    expect(pack.scope.source).toBe("conversation_target");
  });

  it("an explicit room overrides both location and previous discussion", () => {
    const home = createD1DemoHome();
    const pack = buildD1DecisionPack({ input: "打开主卧灯", home, conversation: { ...focus(home), currentRoom: { id: "living", source: "configured_terminal" } } });
    expect(pack.devices.every((device) => device.roomId === "master")).toBe(true);
    expect(pack.scope.source).toBe("explicit_room");
  });

  it("does not treat a selected UI room or occupancy as voice-origin evidence", () => {
    const pack = buildD1DecisionPack({ input: "开灯", home: createD1DemoHome(), selectedRoomId: "study", occupancy: { roomId: "study" } });
    expect(pack.block).toBeTruthy();
    expect(pack.candidates.every((candidate) => candidate.actions.length === 0)).toBe(true);
  });

  it("does not attribute feedback from a different known room to the old lighting task", () => {
    const pack = buildD1DecisionPack({ input: "现在合适了", home: createD1DemoHome(), conversation: {
      currentRoom: { id: "living", source: "configured_terminal" }, activeGoalTask: { roomId: "study", status: "awaiting_confirmation" },
    } });
    expect(pack.candidates.some((candidate) => candidate.goalFeedback)).toBe(false);
  });

  it("offers a currently-off extra study light for a brighter-room goal", () => {
    const home = createD1DemoHome();
    home.things.find((thing) => thing.id === "study_panel").capabilities[0].state = true;
    const pack = buildD1DecisionPack({ input: "还是太暗了", home, conversation: focus(home) });
    const goals = pack.candidates.filter((candidate) => candidate.goal?.desired_outcome === "brighter");
    expect(goals).toHaveLength(1);
    expect(goals[0].label).toContain("书房吊灯");
    expect(goals[0].actions).toHaveLength(1);
    expect(goals[0].actions[0].value).toBe(true);
    expect(pack.devices.every((device) => device.roomId === "study")).toBe(true);
  });

  it("adds a bounded brightness adjustment only when the device actually supports it", () => {
    const home = createD1DemoHome();
    home.things.find((thing) => thing.id === "living_light").capabilities[0].state = true;
    const pack = buildD1DecisionPack({ input: "客厅再亮一点", home });
    const increase = pack.candidates.find((candidate) => candidate.goal?.desired_outcome === "brighter");
    expect(increase.actions[0]).toMatchObject({ device_id: "living_light", capability: "living_brightness", value: 60 });
    expect(increase.goal.evidence).toBe("device_state_only");
  });

  it("honors brightness range and step instead of assuming every light accepts percentages", () => {
    const home = createD1DemoHome();
    const light = home.things.find((thing) => thing.id === "living_light");
    light.capabilities[0].state = true;
    light.capabilities[1].state = 70;
    light.capabilities[1].evidence = { constraints: { min: 10, max: 80, step: 10 } };
    const pack = buildD1DecisionPack({ input: "客厅再亮一点", home });
    expect(pack.candidates.find((candidate) => candidate.goal?.desired_outcome === "brighter").actions[0].value).toBe(80);
  });

  it("does not confuse numeric color temperature with brightness", () => {
    const home = createD1DemoHome();
    const light = home.things.find((thing) => thing.id === "living_light");
    light.capabilities[0].state = true;
    light.capabilities[1].id = "color_temperature";
    light.capabilities[1].name = "色温";
    const pack = buildD1DecisionPack({ input: "客厅再亮一点", home });
    expect(pack.candidates.some((candidate) => candidate.goal?.desired_outcome === "brighter")).toBe(false);
  });

  it("turns a plausible low-confidence plan into a specific question, never an executable action", async () => {
    const home = createD1DemoHome();
    home.things.find((thing) => thing.id === "study_panel").capabilities[0].state = true;
    const draft = await decideWithD1V2({ input: "还是太暗了", home, conversation: focus(home), client: client((candidate) => candidate.goal?.desired_outcome === "brighter", { probability: 0.64, margin: 0.4 }) });
    expect(draft.actions).toEqual([]);
    expect(draft.summary).toBe("要我补开书房吊灯吗？");
    expect(draft.proposal.actions).toHaveLength(1);
    expect(draft.intent_frame.decision.mode).toBe("ask_clarification");
  });

  it.each(["客厅电视怎么打开", "书房空调能否调到25度", "主卧灯怎么调亮", "主卧灯能否调亮", "书房能否更亮一点"])("maintains a hard read-only boundary for capability queries: %s", (input) => {
    expect(buildD1DecisionPack({ input, home: createD1DemoHome() }).candidates.every((candidate) => candidate.actions.length === 0)).toBe(true);
  });

  it("asks rather than claiming brightness success when no safe brighter adjustment remains", async () => {
    const home = createD1DemoHome();
    home.things.find((thing) => thing.id === "study_panel").capabilities.slice(0, 2).forEach((capability) => { capability.state = true; });
    const pack = buildD1DecisionPack({ input: "书房还是太暗", home });
    expect(pack.candidates.some((candidate) => candidate.goal?.desired_outcome === "brighter")).toBe(false);
    const draft = await decideWithD1V2({ input: "书房还是太暗", home, client: client((candidate) => candidate.id === "goal_limit:brighter") });
    expect(draft.actions).toEqual([]);
    expect(draft.summary).toContain("调亮");
    expect(draft.intent_frame.decision.mode).toBe("ask_clarification");
  });

  it("keeps both unavailable lighting directions non-executable after a negative instruction", () => {
    const pack = buildD1DecisionPack({ input: "书房还是太暗；不要开", home: createD1DemoHome() });
    expect(pack.candidates.filter((candidate) => candidate.id.startsWith("goal_limit:")).map((candidate) => candidate.id)).toEqual(["goal_limit:brighter", "goal_limit:dimmer"]);
    expect(pack.candidates.every((candidate) => candidate.actions.length === 0)).toBe(true);
  });

  it("does not invent a lighting adjustment when all light states are unknown", () => {
    const home = createD1DemoHome();
    home.things.find((thing) => thing.id === "study_panel").capabilities.slice(0, 2).forEach((capability) => { capability.state = null; });
    const pack = buildD1DecisionPack({ input: "书房还是太暗", home });
    expect(pack.candidates.filter((candidate) => candidate.id.startsWith("goal_limit:"))).toHaveLength(2);
    expect(pack.candidates.every((candidate) => candidate.actions.length === 0)).toBe(true);
  });

  it.each(["玄关人体传感器太暗了", "把书房射灯亮度调到50%"])("never substitutes a different capability for an unsupported goal: %s", (input) => {
    expect(buildD1DecisionPack({ input, home: createD1DemoHome() }).candidates.every((candidate) => candidate.actions.length === 0)).toBe(true);
  });

  it("does not add writes to a brightness status question", () => {
    const pack = buildD1DecisionPack({ input: "客厅灯亮度现在是多少", home: createD1DemoHome() });
    expect(pack.candidates.some((candidate) => candidate.query)).toBe(true);
    expect(pack.candidates.some((candidate) => candidate.goal)).toBe(false);
  });

  it.each([NaN, -0.1, 1.1])("rejects invalid model confidence instead of authorizing actions: %s", async (probability) => {
    await expect(decideWithD1V2({ input: "开客厅灯", home: createD1DemoHome(), client: client((candidate) => candidate.actions.length, { probability }) })).rejects.toThrow("invalid_decision");
  });

  it("rejects a fabricated candidate outside the compiled decision set", async () => {
    await expect(decideWithD1V2({ input: "开客厅灯", home: createD1DemoHome(), client: { choose: async () => ({ candidate: { id: "fake", actions: [] }, probability: 1, margin: 1 }) } })).rejects.toThrow("invalid_decision");
  });
});
