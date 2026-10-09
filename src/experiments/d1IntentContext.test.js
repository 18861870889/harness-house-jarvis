import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiRuntime } from "./harnessComparison/piRuntime.js";
import { createLangGraphRuntime } from "./harnessComparison/langgraphRuntime.js";
import { createD1DemoHome } from "../adapters/d1DemoAdapter.js";

const request = (commandId, input, extra = {}) => ({ sessionId: "alice", commandId, input, ...extra });
const choice = (candidate) => ({ candidate, probability: 0.95, margin: 0.9 });

for (const [name, factory] of [["pi", createPiRuntime], ["langgraph", createLangGraphRuntime]]) describe(`${name} D1 intent/context v2`, () => {
  async function withRuntime(test, select, options = {}) {
    const directory = mkdtempSync(join(tmpdir(), `house-intent-${name}-`));
    const client = { choose: vi.fn(async (input) => { const result = select(input); return result?.candidate ? result : choice(result); }) };
    let runtime;
    const open = async () => { runtime = await factory({ directory, client, ...options }); return runtime; };
    const restart = async () => { await runtime.close(); return open(); };
    try { await test(await open(), restart, client); }
    finally { await runtime?.close(); rmSync(directory, { recursive: true, force: true }); }
  }

  it("lets fresh voice location override generic old room focus and preserves explicit referents", async () => {
    await withRuntime(async (runtime, _restart, model) => {
      await runtime.run(request("one", "打开书房射灯"));
      const next = await runtime.run(request("two", "开灯", { origin: { terminalId: "mic-living", observedAt: 100000 } }));
      expect(next.actions.every((action) => action.logicalRoomId === "living")).toBe(true);
      const referent = await runtime.run(request("three", "把刚才那个关掉", { origin: { terminalId: "mic-study", observedAt: 100000 } }));
      expect(referent.actions.every((action) => action.logicalRoomId === "living")).toBe(true);
      expect(model.choose.mock.calls[1][0].state).toContain("可信发言房间：客厅");
    }, ({ candidates }) => candidates.find((candidate) => candidate.actions.length), { now: () => 100000, terminalRooms: { "mic-study": "study", "mic-living": "living" } });
  });

  it("does not accept stale, future, unknown-terminal or invalid-room location evidence", async () => {
    await withRuntime(async (runtime) => {
      for (const [index, origin] of [{ terminalId: "mic-study", observedAt: 1 }, { terminalId: "mic-study", observedAt: 100001 }, { terminalId: "fake", roomId: "study", observedAt: 100000 }, { terminalId: "bad-mapping", observedAt: 100000 }].entries()) {
        expect((await runtime.run(request(`unknown-${index}`, "开灯", { origin, selectedRoom: "study" }))).status).toBe("needs_clarification");
      }
      expect(runtime.kernel.writes).toBe(0);
    }, ({ candidates }) => candidates.find((candidate) => candidate.id === "clarify"), { now: () => 100000, terminalRooms: { "mic-study": "study", "bad-mapping": "missing-room" } });
  });

  it("persists goal feedback after verified adjustment and confirms satisfaction without more writes", async () => {
    await withRuntime(async (runtime, restart, model) => {
      await runtime.run(request("one", "打开书房射灯"));
      const result = await runtime.run(request("two", "还是太暗了"));
      expect(result.status).toBe("executed");
      expect(result.actions[0].logicalAssetName).toBe("书房吊灯");
      expect(result.summary).toContain("够亮");
      expect(result.goalProgress).toMatchObject({ status: "awaiting_user_feedback", evidence: "device_readback_only" });
      expect(result.summary).not.toContain("目标已达成");
      runtime = await restart();
      expect((await runtime.getState("alice")).goalTask.status).toBe("awaiting_user_feedback");
      const feedback = await runtime.run(request("three", "现在合适了"));
      expect(feedback.status).toBe("answered");
      expect(feedback.goalProgress.status).toBe("satisfied_by_user");
      expect(runtime.kernel.writes).toBe(2);
      expect(model.choose).toHaveBeenCalledTimes(3);
    }, ({ candidates }) => candidates.find((candidate) => candidate.id === "goal_feedback") ?? candidates.find((candidate) => candidate.goal?.desired_outcome === "brighter") ?? candidates.find((candidate) => candidate.actions.length && candidate.actions[0].value === true));
  });

  it("executes a supported brightness adjustment in memory and reads it back", async () => {
    const home = createD1DemoHome();
    home.things.find((thing) => thing.id === "living_light").capabilities[0].state = true;
    await withRuntime(async (runtime) => {
      const result = await runtime.run(request("one", "客厅再亮一点"));
      expect(result.status).toBe("executed");
      expect(result.actions[0].value).toBe(60);
      expect(result.results[0].verification.ok).toBe(true);
      expect((await runtime.kernel.adapter.discoverHcmHome()).things.find((thing) => thing.id === "living_light").capabilities[1].state).toBe(60);
    }, ({ candidates }) => candidates.find((candidate) => candidate.goal?.desired_outcome === "brighter"), { initialHome: home });
  });

  it("persists a specific proposal across restart and revalidates it after user confirmation", async () => {
    await withRuntime(async (runtime, restart) => {
      await runtime.run(request("one", "打开书房射灯"));
      const proposal = await runtime.run(request("two", "还是太暗"));
      expect(proposal.status).toBe("needs_clarification");
      expect(proposal.summary).toBe("要我补开书房吊灯吗？");
      expect(runtime.kernel.writes).toBe(1);
      runtime = await restart();
      expect((await runtime.getState("alice")).pending.proposal.actions).toHaveLength(1);
      const confirmed = await runtime.run(request("three", "可以", { resumeFor: "two" }));
      expect(confirmed.status).toBe("executed");
      expect(confirmed.actions[0].logicalAssetName).toBe("书房吊灯");
      expect(runtime.kernel.writes).toBe(2);
    }, ({ candidates, state }) => {
      const candidate = candidates.find((item) => item.goal?.desired_outcome === "brighter") ?? candidates.find((item) => item.actions.length && item.actions[0].value === true);
      return { ...choice(candidate), ...(candidate.goal && !state.includes("用户补充：可以") ? { probability: 0.64, margin: 0.4 } : {}) };
    });
  });

  it("does not apply an offered plan when the user rejects it", async () => {
    await withRuntime(async (runtime) => {
      await runtime.run(request("one", "打开书房射灯"));
      await runtime.run(request("two", "还是太暗"));
      const rejected = await runtime.run(request("three", "不要开", { resumeFor: "two" }));
      expect(rejected.status).toBe("answered");
      expect(rejected.actions).toEqual([]);
      expect((await runtime.getState("alice")).pending).toBeNull();
      expect(runtime.kernel.writes).toBe(1);
    }, ({ candidates, state }) => {
      if (state.includes("用户补充：不要开")) return candidates.find((item) => item.id === "no_action");
      const candidate = candidates.find((item) => item.goal?.desired_outcome === "brighter") ?? candidates.find((item) => item.actions.length && item.actions[0].value === true);
      return { ...choice(candidate), ...(candidate.goal ? { probability: 0.64, margin: 0.4 } : {}) };
    });
  });

  it("accepts user satisfaction before execution without claiming an actuator effect", async () => {
    await withRuntime(async (runtime) => {
      await runtime.run(request("one", "打开书房射灯"));
      await runtime.run(request("two", "还是太暗"));
      const feedback = await runtime.run(request("three", "现在合适了"));
      expect(feedback.status).toBe("answered");
      expect(feedback.actions).toEqual([]);
      expect(feedback.goalProgress).toMatchObject({ status: "satisfied_by_user", evidence: "explicit_user_feedback", proposedOnly: true });
      expect((await runtime.getState("alice")).pending).toBeNull();
      expect(runtime.kernel.writes).toBe(1);
    }, ({ candidates, state }) => {
      if (state.includes("当前用户指令：现在合适了")) return candidates.find((item) => item.goalFeedback);
      const candidate = candidates.find((item) => item.goal?.desired_outcome === "brighter") ?? candidates.find((item) => item.actions.length && item.actions[0].value === true);
      return { ...choice(candidate), ...(candidate.goal ? { probability: 0.64, margin: 0.4 } : {}) };
    });
  });

  it("records positive improvement without prematurely completing the comfort goal", async () => {
    await withRuntime(async (runtime) => {
      await runtime.run(request("one", "书房太暗"));
      const feedback = await runtime.run(request("two", "好多了"));
      expect(feedback.status).toBe("answered");
      expect(feedback.goalProgress.status).toBe("improved_by_user");
      expect((await runtime.getState("alice")).goalTask.status).toBe("awaiting_user_feedback");
      expect(runtime.kernel.writes).toBe(1);
    }, ({ candidates }) => candidates.find((candidate) => candidate.id === "goal_feedback_improved") ?? candidates.find((candidate) => candidate.goal?.desired_outcome === "brighter"));
  });

  it("does not report a simulated goal adjustment as physical success", async () => {
    await withRuntime(async (runtime) => {
      const result = await runtime.run(request("one", "书房太暗了", { preview: true }));
      expect(result.status).toBe("dry_run");
      expect(result.goalProgress).toBeUndefined();
      expect((await runtime.getState("alice")).goalTask).toBeNull();
      expect(result.summary).toContain("模拟");
      expect(runtime.kernel.writes).toBe(0);
    }, ({ candidates }) => candidates.find((candidate) => candidate.goal?.desired_outcome === "brighter"));
  });

  it("answers a sensor question using actual read-only facts rather than an execution label", async () => {
    await withRuntime(async (runtime) => {
      const result = await runtime.run(request("one", "玄关人体目前是什么状态"));
      expect(result.status).toBe("answered");
      expect(result.summary).toContain("玄关人体");
      expect(result.summary).not.toBe("读取玄关人体传感器的状态。");
      expect(runtime.kernel.writes).toBe(0);
    }, ({ candidates }) => candidates.find((candidate) => candidate.query));
  });

  it("expires a pending comfort goal instead of attributing unrelated feedback to it", async () => {
    let now = 100000;
    await withRuntime(async (runtime) => {
      await runtime.run(request("one", "书房太暗"));
      now += 31 * 60 * 1000;
      const result = await runtime.run(request("two", "好多了"));
      expect(result.goalProgress).toBeUndefined();
      expect((await runtime.getState("alice")).goalTask).toBeNull();
      expect(runtime.kernel.writes).toBe(1);
    }, ({ candidates }) => candidates.find((candidate) => candidate.goal?.desired_outcome === "brighter") ?? candidates.find((candidate) => candidate.id === "no_action"), { now: () => now });
  });
});
