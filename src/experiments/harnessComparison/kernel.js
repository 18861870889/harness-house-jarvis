import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { decideWithD1 } from "../../d1Decision.js";
import { createConversationContextStore } from "../../conversationContext.js";
import { normalizeHcmPlannerDraft } from "../../hcmPlanner.js";
import { buildHcmExecutionPlan } from "../../hcmExecutor.js";
import { createD1DemoAdapter, createD1DemoHome } from "../../adapters/d1DemoAdapter.js";
import { simulateProviderExecutionPlan, executeSimulatedProviderPlan, verifyProviderExecutionResults } from "../../providerExecutionRuntime.js";

const TTL = 30 * 60 * 1000;
export const emptyState = () => ({ turns: [], pending: null, updatedAt: 0 });

// Business-side admission and effect tracking are deliberately identical for both SDKs.
export function createKernel({ directory, client, now = Date.now, terminalRooms = {}, afterEffect, beforeExecute, initialHome }) {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, "effects.sqlite"));
  db.exec("CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL, result TEXT); CREATE TABLE IF NOT EXISTS world (id INTEGER PRIMARY KEY, home TEXT NOT NULL, writes INTEGER NOT NULL)");
  const persisted = db.prepare("SELECT * FROM world WHERE id=1").get();
  const adapter = createD1DemoAdapter({ home: persisted ? JSON.parse(persisted.home) : initialHome ?? createD1DemoHome() });
  let writes = persisted?.writes ?? 0;
  let effectSignal;
  const execute = adapter.execute;
  adapter.execute = async (...args) => {
    effectSignal?.throwIfAborted();
    const result = await execute(...args);
    writes += 1;
    const home = await adapter.discoverHcmHome();
    db.prepare("INSERT OR REPLACE INTO world VALUES (1,?,?)").run(JSON.stringify(home), writes);
    await afterEffect?.();
    return result;
  };

  function context(state) {
    const store = createConversationContextStore({ now });
    if (now() - state.updatedAt <= TTL) {
      for (const turn of state.turns) store.record("session", turn);
    }
    return store.get("session");
  }

  return {
    adapter,
    get writes() { return writes; },
    close: () => db.close(),
    admit(request) {
      if (!request.sessionId || !request.commandId || typeof request.input !== "string" || !request.input.trim() || request.input.length > 500) throw new Error("invalid_request");
      const payload = { sessionId: request.sessionId, input: request.input, preview: Boolean(request.preview), resumeFor: request.resumeFor ?? null, origin: request.origin ?? null };
      const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      const old = db.prepare("SELECT * FROM requests WHERE id=?").get(request.commandId);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new Error("command_id_conflict");
        return old.status === "complete" ? JSON.parse(old.result) : { status: "execution_unknown", summary: "上次请求的结果未确认，不能自动重放。" };
      }
      db.prepare("INSERT INTO requests VALUES (?,?,'admitted',NULL)").run(request.commandId, fingerprint);
      return null;
    },
    finish(request, result) {
      db.prepare("UPDATE requests SET status='complete', result=? WHERE id=?").run(JSON.stringify(result), request.commandId);
    },
    fail(request, error, signal) {
      const row = db.prepare("SELECT status FROM requests WHERE id=?").get(request.commandId);
      const result = { status: row?.status === "effect_started" ? "execution_unknown" : signal?.aborted ? "cancelled" : "failed", summary: error.message };
      // Never retry automatically after an effect might have happened.
      if (row?.status !== "effect_started") this.finish(request, result);
      return result;
    },
    async decide(request, state, signal) {
      signal?.throwIfAborted();
      const conversation = context(state);
      const pending = state.pending && now() - state.pending.createdAt <= TTL ? state.pending : null;
      if (request.resumeFor && (!pending || pending.commandId !== request.resumeFor)) throw new Error("stale_clarification");
      const input = request.resumeFor ? `${pending.input}；用户补充：${request.input}` : request.input;
      // A configured microphone terminal is evidence; a selected UI room is not.
      const origin = request.origin;
      const roomId = terminalRooms[origin?.terminalId];
      if (!conversation.focusedRooms.length && roomId && Number.isFinite(origin?.observedAt) && now() >= origin.observedAt && now() - origin.observedAt <= 10000) {
        conversation.focusedRooms = [{ id: roomId }];
      }
      const home = await adapter.discoverHcmHome();
      const enriched = { choose: async (options) => {
        const history = conversation.recentTurns.slice(-3).map((turn) => `用户：${turn.input.slice(0, 120)}；结果：${turn.status}；目标：${turn.targetNames.join("、")}`).join("\n");
        const result = await client.choose({ ...options, state: `${history ? `最近对话（dry_run仅预演，不代表设备变化）：\n${history}\n` : ""}${options.state}`, signal });
        if (!options.candidates.some((candidate) => JSON.stringify(candidate) === JSON.stringify(result.candidate)) || !Number.isFinite(result.probability) || !Number.isFinite(result.margin)) throw new Error("invalid_choice_outside_candidate_set");
        return result;
      } };
      const draft = await decideWithD1({ input, home, conversation, client: enriched });
      signal?.throwIfAborted();
      return { draft, home, input };
    },
    async settle(request, state, decision, signal) {
      signal?.throwIfAborted();
      await beforeExecute?.(adapter);
      const home = await adapter.discoverHcmHome();
      if (JSON.stringify(home) !== JSON.stringify(decision.home)) throw new Error("home_changed_replan_required");
      const plan = normalizeHcmPlannerDraft(decision.input, decision.draft, home, { strictSelection: true });
      let status = decision.draft.intent_frame.decision.mode === "ask_clarification" ? "needs_clarification" : "answered";
      let results = [];
      if (plan.actions.length) {
        const execution = buildHcmExecutionPlan(plan.actions, home);
        if (execution.rejected.length || execution.accepted.length !== plan.actions.length) throw new Error("hcm_execution_rejected");
        const simulation = await simulateProviderExecutionPlan({ adapter, accepted: execution.accepted, home });
        if (!simulation.ok) throw new Error("simulation_rejected");
        signal?.throwIfAborted();
        if (request.preview) status = "dry_run";
        else {
          db.prepare("UPDATE requests SET status='effect_started' WHERE id=?").run(request.commandId);
          effectSignal = signal;
          try { results = await executeSimulatedProviderPlan({ adapter, simulation, commandId: request.commandId }); }
          finally { effectSignal = undefined; }
          results = await verifyProviderExecutionResults({ adapter, results, wait: async () => {} });
          if (results.some((result) => !result.ok || !result.verification.ok)) throw new Error("effect_or_readback_unconfirmed");
          status = "executed";
        }
      }
      const turn = { input: request.input, plan, execution: { status } };
      const turns = now() - state.updatedAt <= TTL ? state.turns : [];
      const next = { turns: [...turns, turn].slice(-6), updatedAt: now(), pending: status === "needs_clarification" ? { commandId: request.commandId, input: decision.input, createdAt: now() } : null };
      const result = { status, summary: decision.draft.summary, actions: plan.actions, selectedId: decision.draft.d1.selectedId, d1: decision.draft.d1, results, simulated: true, context: context(next) };
      return { state: next, result };
    },
  };
}

export function guardedRuntime(kernel, driver) {
  let busy = false;
  let closed = false;
  return {
    kernel,
    getState: (sessionId) => driver.getState(sessionId),
    async run(request, { signal } = {}) {
      if (closed) throw new Error("runtime_closed");
      if (busy) throw new Error("runtime_busy");
      signal?.throwIfAborted();
      const cached = kernel.admit(request);
      if (cached) return { ...cached, replayed: true };
      busy = true;
      try {
        const result = await driver.run(request, signal);
        kernel.finish(request, result);
        return result;
      } catch (error) {
        return kernel.fail(request, error, signal);
      } finally { busy = false; }
    },
    async close() {
      if (closed) return;
      if (busy) throw new Error("runtime_busy");
      await driver.close();
      kernel.close();
      closed = true;
    },
  };
}
