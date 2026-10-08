import { createHash } from "node:crypto";
import { createExecutionJournal } from "./executionJournal.js";
import { decideWithD1 } from "../../d1Decision.js";
import { createConversationContextStore } from "../../conversationContext.js";
import { normalizeHcmPlannerDraft } from "../../hcmPlanner.js";
import { buildHcmExecutionPlan } from "../../hcmExecutor.js";
import { createD1DemoAdapter, createD1DemoHome } from "../../adapters/d1DemoAdapter.js";
import { simulateProviderExecutionPlan, executeSimulatedProviderPlan, verifyProviderExecutionResults } from "../../providerExecutionRuntime.js";

const TTL = 30 * 60 * 1000;
const validId = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id);
export const emptyState = () => ({ turns: [], pending: null, updatedAt: 0, revision: 0 });

// Business-side admission and effect tracking are deliberately identical for both SDKs.
export function createKernel({ directory, client, now = Date.now, terminalRooms = {}, afterEffect, beforeExecute, initialHome, lifecycle, ...storageLimits }) {
  const journal = createExecutionJournal({ directory, ...storageLimits });
  const persisted = journal.getWorld();
  const adapter = createD1DemoAdapter({ home: persisted ? JSON.parse(persisted.home) : initialHome ?? createD1DemoHome() });
  let writes = persisted?.writes ?? 0;
  let effectSignal;
  const execute = adapter.execute;
  adapter.execute = async (...args) => {
    effectSignal?.throwIfAborted();
    const result = await execute(...args);
    writes += 1;
    const home = await adapter.discoverHcmHome();
    journal.saveWorld(home, writes);
    await afterEffect?.();
    await lifecycle?.("after_effect");
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
    journal,
    get writes() { return writes; },
    close: () => journal.close(),
    state: (id, fallback = emptyState()) => journal.initializeState(id, fallback),
    admit(request) {
      if (![request.sessionId, request.commandId].every(validId) || typeof request.input !== "string" || !request.input.trim() || request.input.length > 500) throw new Error("invalid_request");
      const payload = { sessionId: request.sessionId, input: request.input, preview: Boolean(request.preview), resumeFor: request.resumeFor ?? null, origin: request.origin ?? null };
      const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      const old = journal.getRequest(request.commandId);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new Error("command_id_conflict");
        return old.status === "complete" ? JSON.parse(old.result) : old.status === "compacted" ? { status: "completed_result_expired", summary: "该请求已经处理，详细结果已归档，不会重复执行。" } : { status: "execution_unknown", summary: "上次请求的结果未确认，不能自动重放。" };
      }
      journal.admit(request.commandId, fingerprint);
      return null;
    },
    finish(request, result) {
      journal.complete(request, result);
    },
    fail(request, error, signal) {
      const row = journal.getRequest(request.commandId);
      if (row?.status === "complete") return { ...JSON.parse(row.result), checkpointWarning: error.message };
      const result = { status: row?.status === "effect_started" ? "execution_unknown" : signal?.aborted ? "cancelled" : "failed", summary: error.message };
      // Never retry automatically after an effect might have happened.
      if (row?.status !== "effect_started") {
        try { this.finish(request, result); }
        catch { result.persistenceWarning = "journal_unavailable"; }
      }
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
      const decision = { draft, home, input };
      journal.prepare(request.commandId, decision);
      await lifecycle?.("after_prepare");
      return decision;
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
          journal.beginEffect(request.commandId);
          await lifecycle?.("before_effect");
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
      const next = { turns: [...turns, turn].slice(-6), updatedAt: now(), revision: state.revision ?? 0, pending: status === "needs_clarification" ? { commandId: request.commandId, input: decision.input, createdAt: now() } : null };
      const result = { status, summary: decision.draft.summary, actions: plan.actions, selectedId: decision.draft.d1.selectedId, d1: decision.draft.d1, results, simulated: true, context: context(next) };
      const committed = journal.complete(request, result, next);
      await lifecycle?.("after_commit");
      return { state: committed, result };
    },
  };
}

export function guardedRuntime(kernel, driver) {
  let busy = false;
  let closed = false;
  return {
    kernel,
    stats: () => ({ ...kernel.journal.stats(), ...(driver.stats?.() ?? {}) }),
    async getState(sessionId) {
      if (closed) throw new Error("runtime_closed");
      if (busy) throw new Error("runtime_busy");
      if (!validId(sessionId)) throw new Error("invalid_session_id");
      busy = true;
      try { return await driver.getState(sessionId); }
      finally { busy = false; }
    },
    async run(request, { signal } = {}) {
      if (closed) throw new Error("runtime_closed");
      if (busy) throw new Error("runtime_busy");
      signal?.throwIfAborted();
      const cached = kernel.admit(request);
      if (cached) return { ...cached, replayed: true };
      busy = true;
      try {
        const result = await driver.run(request, signal);
        return result;
      } catch (error) {
        return kernel.fail(request, error, signal);
      } finally { busy = false; }
    },
    async close() {
      if (closed) return;
      if (busy) throw new Error("runtime_busy");
      try { await driver.close(); }
      finally { kernel.close(); closed = true; }
    },
  };
}
