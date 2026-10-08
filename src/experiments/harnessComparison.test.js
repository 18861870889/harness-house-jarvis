import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createPiRuntime } from "./harnessComparison/piRuntime.js";
import { createLangGraphRuntime } from "./harnessComparison/langgraphRuntime.js";
import { createD1DemoHome } from "../adapters/d1DemoAdapter.js";

// Deterministic choice fixtures test SDK mechanics, not language-model intelligence.
export function fixtureClient(select = "on") {
  return { choose: vi.fn(async ({ candidates, signal }) => {
    signal?.throwIfAborted();
    const candidate = candidates.find((item) => item.actions?.length && item.actions.every((action) => action.value === (select !== "off"))) ?? candidates.find((item) => item.id === "clarify");
    return { candidate, probability: 0.95, margin: 0.9, purpose: { choice: "control", probability: 0.95, margin: 0.9 } };
  }) };
}

for (const [name, factory] of [["pi", createPiRuntime], ["langgraph", createLangGraphRuntime]]) {
  describe(`${name} isolated harness`, () => {
    async function withRuntime(test, options = {}) {
      const directory = mkdtempSync(join(tmpdir(), `house-${name}-`));
      let runtime = await factory({ directory, client: fixtureClient(), ...options });
      const restart = async () => { await runtime.close(); runtime = await factory({ directory, client: fixtureClient(), ...options }); return runtime; };
      try { await test(runtime, restart, directory); }
      finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
    }
    const request = (commandId, input, extra = {}) => ({ sessionId: "alice", commandId, input, ...extra });

    it("executes through HCM once, verifies memory state, and deduplicates", async () => {
      const client = fixtureClient();
      await withRuntime(async (runtime) => {
        const command = request("one", "打开书房射灯");
        const result = await runtime.run(command);
        expect(result.status).toBe("executed");
        expect(result.results.every((item) => item.verification.code === "state_converged")).toBe(true);
        expect(runtime.kernel.writes).toBe(1);
        expect((await runtime.run(command)).replayed).toBe(true);
        expect(client.choose).toHaveBeenCalledTimes(1);
        expect(runtime.kernel.writes).toBe(1);
        await expect(runtime.run({ ...command, input: "打开主卧灯" })).rejects.toThrow("command_id_conflict");
      }, { client });
    });

    it("supplies focused target and truthful recent turns to the next decision", async () => {
      const client = fixtureClient();
      await withRuntime(async (runtime) => {
        const first = await runtime.run(request("one", "打开书房射灯"));
        const result = await runtime.run(request("two", "关一下"));
        expect(result.status).toBe("executed");
        const input = client.choose.mock.calls[1][0];
        expect(input.state).toContain("上一轮目标：书房射灯");
        expect(input.state).toContain("用户：打开书房射灯；结果：executed");
        expect(input.candidates.filter((item) => item.actions?.length).every((item) => item.actions.every((action) => action.device_id === first.actions[0].logicalAssetId))).toBe(true);
      }, { client });
    });

    it("stores dry-run separately from actual device facts", async () => {
      await withRuntime(async (runtime) => {
        const result = await runtime.run(request("preview", "打开书房射灯", { preview: true }));
        expect(result.status).toBe("dry_run");
        expect(runtime.kernel.writes).toBe(0);
        const home = await runtime.kernel.adapter.discoverHcmHome();
        expect(home.things.find((item) => item.id === "study_panel").capabilities[0].state).toBe(false);
        expect(result.context.recentTurns[0].status).toBe("dry_run");
      });
    });

    it("persists clarification, resumes it after restart, and refuses wrong question IDs", async () => {
      await withRuntime(async (runtime, restart) => {
        expect((await runtime.run(request("question", "卧室灯关一下"))).status).toBe("needs_clarification");
        runtime = await restart();
        expect((await runtime.getState("alice")).pending.commandId).toBe("question");
        const wrong = await runtime.run(request("wrong", "主卧", { resumeFor: "other" }));
        expect(wrong.status).toBe("failed");
        const resumed = await runtime.run(request("reply", "主卧", { resumeFor: "question" }));
        expect(resumed.status).toBe("executed");
        expect(resumed.actions[0].logicalRoomId).toBe("master");
        expect((await runtime.getState("alice")).pending).toBeNull();
      }, { client: fixtureClient("off") });
    });

    it("allows a new unrelated request to replace a pending clarification", async () => {
      await withRuntime(async (runtime) => {
        await runtime.run(request("question", "卧室灯关一下"));
        const result = await runtime.run(request("new", "打开客厅风扇"));
        expect(result.status).toBe("executed");
        expect(result.actions[0].thingId).toBe("living_fan");
        expect((await runtime.run(request("stale", "主卧", { resumeFor: "question" }))).status).toBe("failed");
      });
    });

    it("isolates sessions and lets explicit room override conversation focus", async () => {
      await withRuntime(async (runtime) => {
        await runtime.run(request("one", "打开书房射灯"));
        expect((await runtime.run(request("two", "开灯", { sessionId: "bob" }))).status).toBe("needs_clarification");
        const explicit = await runtime.run(request("three", "打开主卧灯"));
        expect(explicit.actions[0].logicalRoomId).toBe("master");
      });
    });

    it("uses only configured fresh microphone origin, never UI room or guessed occupancy", async () => {
      await withRuntime(async (runtime) => {
        const untrusted = await runtime.run(request("one", "开灯", { selectedRoom: "study", origin: { terminalId: "fake", roomId: "study", observedAt: 100000 } }));
        expect(untrusted.status).toBe("needs_clarification");
        const stale = await runtime.run(request("two", "开灯", { origin: { terminalId: "mic-study", observedAt: 1 } }));
        expect(stale.status).toBe("needs_clarification");
        const valid = await runtime.run(request("three", "开灯", { origin: { terminalId: "mic-study", observedAt: 100000 } }));
        expect(valid.status).toBe("executed");
        expect(valid.actions.every((action) => action.logicalRoomId === "study")).toBe(true);
      }, { now: () => 100000, terminalRooms: { "mic-study": "study" } });
    });

    it("expires pending questions and context", async () => {
      let now = 100000;
      await withRuntime(async (runtime) => {
        await runtime.run(request("question", "卧室灯关一下"));
        now += 31 * 60 * 1000;
        expect((await runtime.run(request("reply", "主卧", { resumeFor: "question" }))).status).toBe("failed");
        expect(runtime.kernel.writes).toBe(0);
      }, { now: () => now });
    });

    it("fails closed on low confidence and malformed model selection", async () => {
      const client = fixtureClient();
      const choose = client.choose;
      client.choose = vi.fn(async (options) => ({ ...await choose(options), probability: 0.4, margin: 0.01 }));
      await withRuntime(async (runtime) => {
        expect((await runtime.run(request("one", "打开书房射灯"))).status).toBe("needs_clarification");
        client.choose.mockImplementation(async () => { throw new Error("invalid distribution"); });
        expect((await runtime.run(request("two", "打开书房射灯"))).status).toBe("failed");
        expect(runtime.kernel.writes).toBe(0);
      }, { client });
    });

    it("refuses a capability protected after discovery and never writes sensor state", async () => {
      const home = createD1DemoHome();
      home.things.find((item) => item.id === "living_light").capabilities[0].policy.autoExecutable = false;
      await withRuntime(async (runtime) => {
        await runtime.run(request("one", "打开客厅灯"));
        await runtime.run(request("two", "打开玄关人体传感器"));
        expect(runtime.kernel.writes).toBe(0);
      }, { initialHome: home });
    });

    it("does not write offline devices or guess a referent among multiple focused lights", async () => {
      const home = createD1DemoHome();
      home.things.find((item) => item.id === "living_light").online = false;
      await withRuntime(async (runtime) => {
        expect((await runtime.run(request("offline", "打开客厅灯"))).status).toBe("failed");
        expect(runtime.kernel.writes).toBe(0);
        expect((await runtime.run(request("group", "打开书房所有灯"))).status).toBe("executed");
        expect(runtime.kernel.writes).toBe(2);
        expect((await runtime.run(request("ambiguous", "关一下"))).status).toBe("needs_clarification");
        expect(runtime.kernel.writes).toBe(2);
      }, { initialHome: home });
    });

    it("rechecks the household snapshot after model selection", async () => {
      await withRuntime(async (runtime) => {
        expect((await runtime.run(request("one", "打开书房射灯"))).status).toBe("failed");
        expect(runtime.kernel.writes).toBe(0);
      }, { beforeExecute: async (adapter) => {
        const discover = adapter.discoverHcmHome;
        adapter.discoverHcmHome = async () => { const home = await discover(); home.things[0].name = "changed"; return home; };
      } });
    });

    it("rejects forged choices outside the compiled action pool", async () => {
      await withRuntime(async (runtime) => {
        const result = await runtime.run(request("one", "打开书房射灯"));
        expect(result.status).toBe("failed");
        expect(runtime.kernel.writes).toBe(0);
      }, { client: { choose: async () => ({ candidate: { id: "forged", actions: [] }, probability: 1, margin: 1 }) } });
    });

    it("stops the remaining batch after cancellation between simulated effects", async () => {
      const controller = new AbortController();
      await withRuntime(async (runtime) => {
        const result = await runtime.run(request("one", "打开书房所有灯"), { signal: controller.signal });
        expect(result.status).toBe("execution_unknown");
        expect(runtime.kernel.writes).toBe(1);
      }, { afterEffect: () => controller.abort() });
    });

    it("cancels during inference and rejects concurrency without queued stale actions", async () => {
      let started;
      const ready = new Promise((resolve) => { started = resolve; });
      const client = { choose: vi.fn(({ signal }) => new Promise((_resolve, reject) => {
        started(); signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      })) };
      await withRuntime(async (runtime) => {
        const controller = new AbortController();
        const pending = runtime.run(request("one", "打开书房射灯"), { signal: controller.signal });
        await ready;
        await expect(runtime.run(request("two", "打开主卧灯"))).rejects.toThrow("runtime_busy");
        controller.abort();
        expect((await pending).status).toBe("cancelled");
        expect(runtime.kernel.writes).toBe(0);
      }, { client });
    });

    it("does not replay an unconfirmed effect after a crash-window restart", async () => {
      await withRuntime(async (runtime, restart) => {
        const command = request("one", "打开书房射灯");
        expect((await runtime.run(command)).status).toBe("execution_unknown");
        expect(runtime.kernel.writes).toBe(1);
        runtime = await restart();
        expect((await runtime.run(command)).status).toBe("execution_unknown");
        expect(runtime.kernel.writes).toBe(1);
      }, { afterEffect: () => { throw new Error("injected crash window"); } });
    });

    it("recovers context and deduplication in a separate Node process", async () => {
      await withRuntime(async (runtime, restart, directory) => {
        await runtime.run(request("one", "打开书房射灯"));
        await runtime.close();
        const child = spawnSync(process.execPath, ["scripts/harness-restart-probe.mjs", name, directory], { cwd: process.cwd(), encoding: "utf8", timeout: 20000 });
        expect(child.status, child.stderr).toBe(0);
        const result = JSON.parse(child.stdout.trim());
        expect(result.focus).toBe("asset_study_书房射灯");
        expect(result.replayed).toBe(true);
        expect(result.writes).toBe(1);
        // Re-open for the shared cleanup; close is idempotent below.
        runtime = await restart();
      });
    });
  });
}
