import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiRuntime } from "./harnessComparison/piRuntime.js";
import { createD1DemoHome } from "../adapters/d1DemoAdapter.js";

const score = choice => ({ choice, probability: 0.99, margin: 0.98 });
const origin = room => ({ terminalId: `terminal-${room}`, observedAt: Date.now() });
const request = (id, input, room = "study", extra = {}) => ({ sessionId: "resident", commandId: id, input, origin: origin(room), ...extra });
const model = decisions => ({ classify: vi.fn(async ({ questions }) => {
  const next = decisions.shift();
  if (!next) throw new Error("unexpected_model_call");
  return { answers: Object.fromEntries(Object.keys(questions).map(id => [id, score(next[id] ?? { extent: "default", feedback: "none", target_form: "generic" }[id])])), latencyMs: 1 };
}) });
async function fixture(test, decisions, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "semantic-context-"));
  const client = model(decisions);
  let runtime;
  const open = async extra => { runtime = await createPiRuntime({ directory, client, decisionVersion: "v3", terminalRooms: { "terminal-study": "study", "terminal-living": "living", "terminal-second": "second", "doorway": null }, ...options, ...extra }); return runtime; };
  try { await test(await open(), client, open); }
  finally { await runtime?.close(); rmSync(directory, { recursive: true, force: true }); }
}

describe("semantic v3 Pi context and effect boundary", () => {
  it("binds a partial load name to one logical gang, never the panel", async () => {
    await fixture(async runtime => {
      const r = await runtime.run(request("one", "开射灯"));
      expect(r.status).toBe("executed");
      expect(r.actions.map(a => a.logicalAssetName)).toEqual(["书房射灯"]);
      const home = await runtime.kernel.adapter.discoverHcmHome();
      expect(home.things.find(t => t.id === "study_panel").capabilities.map(c => c.state)).toEqual([true, false, false]);
    }, [{ task: "power_on", extent: "matching" }]);
  });

  it("repeated default-on commands do not successively light up the room", async () => {
    await fixture(async runtime => {
      expect((await runtime.run(request("one", "开下灯"))).actions).toHaveLength(1);
      const r = await runtime.run(request("two", "开下灯"));
      expect(r.status).toBe("answered"); expect(r.actions).toEqual([]); expect(runtime.kernel.writes).toBe(1);
    }, [{ task: "power_on" }, { task: "power_on" }]);
  });

  it("keeps a capability query's exact target available for a pronoun follow-up", async () => {
    await fixture(async runtime => {
      const query = await runtime.run(request("one", "书房吊灯支持调光吗"));
      expect(query.status).toBe("answered"); expect(query.summary).toContain("不能调光");
      expect(query.context.focusedTargets.map(t => t.name)).toEqual(["书房吊灯"]);
      const r = await runtime.run(request("two", "把它打开", "living"));
      expect(r.status).toBe("executed");
      expect(r.actions.map(a => a.logicalAssetName)).toEqual(["书房吊灯"]);
    }, [{ task: "capability_query", extent: "matching" }, { task: "power_on" }]);
  });

  it("does not carry a dimming goal into another speaker room", async () => {
    const home = createD1DemoHome(); home.things.find(t => t.id === "study_panel").capabilities[0].state = true;
    await fixture(async (runtime, client) => {
      await runtime.run(request("one", "太亮了"));
      const r = await runtime.run(request("two", "开下灯", "second"));
      expect(r.status).toBe("executed");
      expect(r.actions.every(a => a.logicalRoomId === "second" && a.value === true)).toBe(true);
      expect(client.classify.mock.calls[1][0].state).not.toContain("未完成的目标");
    }, [{ task: "dimmer" }, { task: "power_on" }], { initialHome: home });
  });

  it("treats a revised pending reply as new intent, not confirmation of old actions", async () => {
    const home = createD1DemoHome(); home.things.find(t => t.id === "study_panel").capabilities[1].state = true;
    await fixture(async (runtime, client) => {
      const q = await runtime.run(request("one", "不要开吊灯")); expect(q.status).toBe("needs_clarification");
      const r = await runtime.run(request("two", "开射灯", "study", { resumeFor: "one" }));
      expect(r.actions.map(a => a.logicalAssetName)).toEqual(["书房射灯"]);
      expect(r.actions.every(a => a.value === true)).toBe(true);
      expect(client.classify.mock.calls[1][0].state).toContain('本轮用户原话："开射灯"');
      expect(client.classify.mock.calls[1][0].state).not.toContain("用户补充");
    }, [{ task: "no_action" }, { task: "power_on", extent: "matching" }], { initialHome: home });
  });

  it("a confirmation executes only the stored proposal, reusing the normal executor", async () => {
    const home = createD1DemoHome(); home.things.find(t => t.id === "study_panel").capabilities[1].state = true;
    await fixture(async runtime => {
      await runtime.run(request("one", "不要开吊灯"));
      const r = await runtime.run(request("two", "可以", "study", { resumeFor: "one" }));
      expect(r.status).toBe("executed"); expect(r.actions).toHaveLength(1);
      expect(r.actions[0].logicalAssetName).toBe("书房吊灯"); expect(r.actions[0].value).toBe(false);
      expect(r.results[0].verification.ok).toBe(true);
    }, [{ task: "no_action" }, { task: "confirm" }], { initialHome: home });
  });

  it("does not confirm another room's pending proposal", async () => {
    const home = createD1DemoHome(); home.things.find(t => t.id === "study_panel").capabilities[1].state = true;
    await fixture(async runtime => {
      await runtime.run(request("one", "不要开吊灯"));
      const r = await runtime.run(request("two", "可以", "living", { resumeFor: "one" }));
      expect(r.status).toBe("needs_clarification"); expect(runtime.kernel.writes).toBe(0);
    }, [{ task: "no_action" }, { task: "confirm" }], { initialHome: home });
  });

  it("rejects a stale proposal reference without calling D1", async () => {
    await fixture(async (runtime, client) => {
      const r = await runtime.run(request("one", "可以", "study", { resumeFor: "unknown" }));
      expect(r.status).toBe("failed"); expect(r.summary).toBe("stale_clarification"); expect(client.classify).not.toHaveBeenCalled();
    }, []);
  });

  it("does not treat a stale terminal as permission to reuse a discussion room", async () => {
    await fixture(async runtime => {
      await runtime.run(request("one", "开射灯"));
      const r = await runtime.run(request("two", "开灯", "study", { origin: { terminalId: "terminal-study", observedAt: Date.now() - 20000 } }));
      expect(r.status).toBe("needs_clarification"); expect(runtime.kernel.writes).toBe(1);
    }, [{ task: "power_on", extent: "matching" }, { task: "power_on" }]);
  });

  it("deduplicates and recovers v3 effects across a runtime restart", async () => {
    await fixture(async (runtime, client, open) => {
      const command = request("one", "开射灯");
      await runtime.run(command); await runtime.close();
      const recovered = await open(); const r = await recovered.run(command);
      expect(r.replayed).toBe(true); expect(r.status).toBe("executed"); expect(recovered.kernel.writes).toBe(1);
      expect(client.classify).toHaveBeenCalledTimes(1);
    }, [{ task: "power_on", extent: "matching" }]);
  });

  it("preview leaves device state untouched and is not an executed outcome", async () => {
    await fixture(async runtime => {
      const r = await runtime.run(request("one", "开一个灯", "study", { preview: true }));
      expect(r.status).toBe("dry_run"); expect(runtime.kernel.writes).toBe(0); expect(r.context.recentTurns[0].status).toBe("dry_run");
    }, [{ task: "power_on", extent: "one" }]);
  });

  it("a closed-too-many correction proposes the exact previous change and waits for agreement", async () => {
    const home = createD1DemoHome(); home.things.find(t => t.id === "study_panel").capabilities.slice(0, 2).forEach(c => { c.state = true; });
    await fixture(async runtime => {
      const closed = await runtime.run(request("one", "关一个灯")); expect(closed.actions).toHaveLength(1);
      const feedback = await runtime.run(request("two", "关闭的太多了"));
      expect(feedback.status).toBe("needs_clarification"); expect(feedback.actions).toEqual([]); expect(runtime.kernel.writes).toBe(1);
      expect(feedback.proposal.actions).toHaveLength(1); expect(feedback.summary).toContain(closed.actions[0].logicalAssetName);
      const confirmed = await runtime.run(request("three", "可以", "study", { resumeFor: "two" }));
      expect(confirmed.status).toBe("executed"); expect(confirmed.actions[0].logicalAssetId).toBe(closed.actions[0].logicalAssetId);
      expect(confirmed.actions[0].value).toBe(true);
    }, [{ task: "power_off", extent: "one" }, { task: "feedback", feedback: "dissatisfied" }, { task: "confirm" }], { initialHome: home });
  });

  it("past changes from another room do not become a restoration proposal", async () => {
    const home = createD1DemoHome(); home.things.find(t => t.id === "study_panel").capabilities[1].state = true;
    await fixture(async runtime => {
      await runtime.run(request("one", "关吊灯"));
      const feedback = await runtime.run(request("two", "关闭的太多了", "second"));
      expect(feedback.proposal).toBeUndefined(); expect(feedback.actions).toEqual([]); expect(runtime.kernel.writes).toBe(1);
    }, [{ task: "power_off", extent: "matching" }, { task: "feedback", feedback: "dissatisfied" }], { initialHome: home });
  });

  it("keeps a logical light query concise without claiming independent light detection", async () => {
    await fixture(async runtime => {
      const r = await runtime.run(request("one", "书房射灯打开了吗"));
      expect(r.status).toBe("answered"); expect(r.summary).toBe("书房射灯的控制回路已关闭。"); expect(runtime.kernel.writes).toBe(0);
    }, [{ task: "state_query", extent: "matching" }]);
  });

  it("cancellation after classification cannot reach the effect boundary", async () => {
    const controller = new AbortController();
    await fixture(async (runtime, client) => {
      const classify = client.classify.getMockImplementation();
      client.classify.mockImplementation(async options => { const r = await classify(options); controller.abort(); return r; });
      const r = await runtime.run(request("one", "开射灯"), { signal: controller.signal });
      expect(r.status).toBe("cancelled"); expect(runtime.kernel.writes).toBe(0);
    }, [{ task: "power_on", extent: "matching" }]);
  });
});
