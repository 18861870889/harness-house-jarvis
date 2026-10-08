import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { createPiRuntime } from "./harnessComparison/piRuntime.js";
import { createLangGraphRuntime } from "./harnessComparison/langgraphRuntime.js";

function client() {
  const result = { calls: 0, async choose({ candidates }) {
    result.calls += 1;
    const candidate = candidates.find((item) => item.actions?.length && item.actions.every((action) => action.value === true)) ?? candidates.find((item) => item.id === "clarify");
    return { candidate, probability: 0.95, margin: 0.9, purpose: { choice: "control", probability: 0.95, margin: 0.9 } };
  } };
  return result;
}
const command = (commandId, extra = {}) => ({ sessionId: "alice", commandId, input: "打开书房射灯", ...extra });

async function killAt(name, directory, phase, scenario) {
  const child = fork("scripts/harness-crash-probe.mjs", [name, directory, phase, scenario ?? "control"], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Crash barrier timeout: ${stderr}`)), 10000);
      child.once("message", (message) => { clearTimeout(timeout); message.phase === phase ? resolve() : reject(new Error("wrong_phase")); });
      child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Unexpected child exit ${code}: ${stderr}`)); });
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    });
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    const [, signal] = await exited;
    expect(signal).toBe("SIGKILL");
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
  }
}

for (const [name, factory] of [["pi", createPiRuntime], ["langgraph", createLangGraphRuntime]]) {
  describe(`${name} durable hardening`, () => {
    async function withRuntime(test, options = {}) {
      const directory = mkdtempSync(join(tmpdir(), `house-hardening-${name}-`));
      const model = client();
      let runtime;
      const open = async (overrides = {}) => { runtime = await factory({ directory, client: model, ...options, ...overrides }); return runtime; };
      try { await test({ directory, model, open, get runtime() { return runtime; } }); }
      finally { await runtime?.close(); rmSync(directory, { recursive: true, force: true }); }
    }

    it.each(["after_prepare", "before_effect", "after_effect", "after_commit", "after_projection"])("recovers safely after actual SIGKILL at %s", async (phase) => {
      await withRuntime(async (test) => {
        await killAt(name, test.directory, phase);
        const runtime = await test.open();
        const result = await runtime.run(command("crash"));
        const committed = ["after_commit", "after_projection"].includes(phase);
        expect(result.status).toBe(committed ? "executed" : "execution_unknown");
        expect(result.replayed).toBe(true);
        expect(test.model.calls).toBe(0);
        expect(runtime.kernel.writes).toBe(["after_prepare", "before_effect"].includes(phase) ? 0 : 1);
        const state = await runtime.getState("alice");
        expect(state.turns.length).toBe(committed ? 1 : 0);
        if (committed) expect(state.turns[0].plan.actions[0].logicalAssetName).toBe("书房射灯");
      });
    });

    it("recovers a committed question even if the framework never finished checkpointing it", async () => {
      await withRuntime(async (test) => {
        await killAt(name, test.directory, "after_commit", "clarification");
        const runtime = await test.open();
        expect((await runtime.getState("alice")).pending.commandId).toBe("crash");
        const result = await runtime.run(command("reply", { input: "主卧", resumeFor: "crash" }));
        expect(result.status).toBe("executed");
        expect(result.actions[0].logicalRoomId).toBe("master");
        expect(test.model.calls).toBe(1);
      });
    });

    it("keeps confirmed outcomes truthful when the completed framework checkpoint fails", async () => {
      let failed = false;
      await withRuntime(async (test) => {
        const runtime = await test.open();
        const result = await runtime.run(command("one"));
        expect(result.status).toBe("executed");
        expect(result.checkpointWarning).toContain("injected_checkpoint_failure");
        expect((await runtime.getState("alice")).turns).toHaveLength(1);
        expect((await runtime.run(command("one"))).status).toBe("executed");
        expect(test.model.calls).toBe(1);
        expect(runtime.kernel.writes).toBe(1);
      }, { beforeCheckpoint: (phase) => { if (phase === "complete" && !failed) { failed = true; throw new Error("injected_checkpoint_failure"); } } });
    });

    it("does not execute when the prepared framework checkpoint cannot be saved", async () => {
      await withRuntime(async (test) => {
        const runtime = await test.open();
        expect((await runtime.run(command("one"))).status).toBe("failed");
        expect(runtime.kernel.writes).toBe(0);
      }, { beforeCheckpoint: (phase) => { if (phase === "prepared") throw Object.assign(new Error("injected_ENOSPC"), { code: "ENOSPC" }); } });
    });

    it("rolls back result and conversation together on a real SQLite transaction failure", async () => {
      await withRuntime(async (test) => {
        const runtime = await test.open();
        const db = new DatabaseSync(join(test.directory, "effects.sqlite"));
        try {
          db.exec("CREATE TRIGGER reject_context BEFORE INSERT ON conversations WHEN json_extract(NEW.state,'$.revision') > 0 BEGIN SELECT RAISE(ABORT,'injected_db_failure'); END");
          expect((await runtime.run(command("one"))).status).toBe("execution_unknown");
          db.exec("DROP TRIGGER reject_context");
          expect((await runtime.getState("alice")).turns).toHaveLength(0);
          expect((await runtime.run(command("one"))).status).toBe("execution_unknown");
          expect(runtime.kernel.writes).toBe(1);
          expect(test.model.calls).toBe(1);
        } finally { db.close(); }
      });
    });

    it("fails closed if the effect-admission write fails, then accepts a fresh request after recovery", async () => {
      await withRuntime(async (test) => {
        const runtime = await test.open();
        const db = new DatabaseSync(join(test.directory, "effects.sqlite"));
        try {
          db.exec("CREATE TRIGGER reject_effect BEFORE UPDATE ON requests WHEN NEW.status='effect_started' BEGIN SELECT RAISE(ABORT,'injected_db_failure'); END");
          expect((await runtime.run(command("one"))).status).toBe("failed");
          expect(runtime.kernel.writes).toBe(0);
          db.exec("DROP TRIGGER reject_effect");
          expect((await runtime.run(command("two"))).status).toBe("executed");
          expect(runtime.kernel.writes).toBe(1);
        } finally { db.close(); }
      });
    });

    it("rejects two writable owners of the same household", async () => {
      await withRuntime(async (test) => {
        await test.open();
        await expect(factory({ directory: test.directory, client: client() })).rejects.toThrow("household_in_use");
        expect((await test.runtime.run(command("one"))).status).toBe("executed");
      });
    });

    it("bounds result retention without losing old command identities", async () => {
      await withRuntime(async (test) => {
        const runtime = await test.open();
        for (let i = 0; i < 5; i += 1) expect((await runtime.run(command(`one-${i}`))).status).toBe("executed");
        expect(runtime.stats().retainedResults).toBe(2);
        expect((await runtime.run(command("one-0"))).status).toBe("completed_result_expired");
        expect(test.model.calls).toBe(5);
        expect(runtime.kernel.writes).toBe(5);
      }, { retainedResults: 2 });
    });

    it("rejects new work at storage capacity but still deduplicates an existing command", async () => {
      await withRuntime(async (test) => {
        const runtime = await test.open();
        await runtime.run(command("one"));
        await runtime.run(command("two"));
        await expect(runtime.run(command("three"))).rejects.toThrow("request_capacity_reached");
        expect((await runtime.run(command("one"))).replayed).toBe(true);
        expect(runtime.kernel.writes).toBe(2);
      }, { maxRequests: 2 });
    });

    it("caps persistent sessions before creating extra framework sessions", async () => {
      await withRuntime(async (test) => {
        const runtime = await test.open();
        await runtime.run(command("one"));
        await runtime.run(command("two", { sessionId: "bob" }));
        expect((await runtime.run(command("three", { sessionId: "charlie" }))).status).toBe("failed");
        expect(runtime.stats().conversations).toBe(2);
        if (name === "pi") expect(readdirSync(join(test.directory, "sessions")).filter((file) => file.endsWith(".sqlite"))).toHaveLength(2);
      }, { maxSessions: 2 });
    });

    it("does not misreport a completed effect as cancelled when cancellation arrives after commit", async () => {
      const controller = new AbortController();
      await withRuntime(async (test) => {
        const runtime = await test.open();
        expect((await runtime.run(command("one"), { signal: controller.signal })).status).toBe("executed");
        expect(runtime.kernel.writes).toBe(1);
      }, { lifecycle: (phase) => { if (phase === "after_commit") controller.abort(); } });
    });

    it("cancels after decision admission without executing or poisoning the next request", async () => {
      const controller = new AbortController();
      let cancelled = false;
      await withRuntime(async (test) => {
        const runtime = await test.open();
        expect((await runtime.run(command("one"), { signal: controller.signal })).status).toBe("cancelled");
        expect(runtime.kernel.writes).toBe(0);
        expect((await runtime.run(command("two"))).status).toBe("executed");
        expect(runtime.kernel.writes).toBe(1);
      }, { lifecycle: (phase) => { if (phase === "after_prepare" && !cancelled) { cancelled = true; controller.abort(); } } });
    });

    it("prevents concurrent state reads from evicting an active session", async () => {
      let ready;
      const started = new Promise((resolve) => { ready = resolve; });
      let release;
      const paused = new Promise((resolve) => { release = resolve; });
      await withRuntime(async (test) => {
        const runtime = await test.open();
        const pending = runtime.run(command("one"));
        await started;
        await expect(runtime.getState("bob")).rejects.toThrow("runtime_busy");
        await expect(runtime.close()).rejects.toThrow("runtime_busy");
        release();
        expect((await pending).status).toBe("executed");
      }, { beforeCheckpoint: async (phase) => { if (phase === "prepared") { ready(); await paused; } } });
    });

    it("migrates the old ledger without discarding confirmed results or framework context", async () => {
      await withRuntime(async (test) => {
        const first = await test.open();
        await first.run(command("one"));
        await first.close();
        const db = new DatabaseSync(join(test.directory, "effects.sqlite"));
        try { db.exec("DROP TABLE conversations; DROP TABLE runtime_owner; ALTER TABLE requests DROP COLUMN checkpoint"); }
        finally { db.close(); }
        const migrated = await test.open();
        expect((await migrated.run(command("one"))).replayed).toBe(true);
        expect((await migrated.getState("alice")).turns).toHaveLength(1);
        expect(migrated.kernel.writes).toBe(1);
        expect(test.model.calls).toBe(1);
      });
    });

    if (name === "pi") it("evicts open session handles without losing durable context", async () => {
      await withRuntime(async (test) => {
        const runtime = await test.open();
        for (let i = 0; i < 12; i += 1) await runtime.run(command(`one-${i}`, { sessionId: `person-${i}` }));
        expect(runtime.stats().peakActiveSessions).toBe(2);
        expect(runtime.stats().activeSessions).toBe(2);
        expect((await runtime.getState("person-0")).turns).toHaveLength(1);
        expect(runtime.stats().activeSessions).toBe(2);
      }, { maxOpenSessions: 2 });
    });
  });
}
