import { Agent, BACKGROUND_CONTEXT, value } from "@earendil-works/pi-agent-core";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createNodeSqliteFactory, SqliteSessionRepo } from "@earendil-works/pi-session-backend-sqlite-node";
import { join } from "node:path";
import { createKernel, emptyState, guardedRuntime } from "./kernel.js";

export async function createPiRuntime(options) {
  const kernel = createKernel(options);
  const sqlite = createNodeSqliteFactory();
  const databaseFactory = Object.fromEntries(["open", "openExisting", "openReadOnly"].map((method) => [method, async (path) => {
    const db = await sqlite[method](path);
    try { db.exec("PRAGMA synchronous=FULL"); return db; }
    catch (error) { db.close(); throw error; }
  }]));
  const repo = new SqliteSessionRepo({ directory: join(options.directory, "sessions"), databaseFactory });
  const sessions = new Map();
  const metadata = new Map();
  let listed = false;
  let checkpointWrites = 0;
  let repairs = 0;
  let peakActiveSessions = 0;
  const maxOpenSessions = options.maxOpenSessions ?? 8;
  if (!Number.isSafeInteger(maxOpenSessions) || maxOpenSessions < 1) { await repo.close(BACKGROUND_CONTEXT); kernel.close(); throw new Error("invalid_session_cache_limit"); }
  const address = value("harness-house", "conversation");
  async function listMetadata() {
    if (!listed) {
      for (const item of await repo.list(undefined, BACKGROUND_CONTEXT)) metadata.set(item.id, item);
      listed = true;
    }
  }
  async function getSession(id) {
    await listMetadata();
    if (!sessions.has(id)) {
      if (sessions.size >= maxOpenSessions) {
        const oldest = sessions.keys().next().value;
        await sessions.get(oldest).close(BACKGROUND_CONTEXT);
        sessions.delete(oldest);
      }
      const existing = metadata.get(id);
      const session = existing ? await repo.open(existing, BACKGROUND_CONTEXT) : await repo.create({ id }, BACKGROUND_CONTEXT);
      metadata.set(id, session.metadata);
      sessions.set(id, session);
      peakActiveSessions = Math.max(peakActiveSessions, sessions.size);
    }
    const session = sessions.get(id);
    sessions.delete(id);
    sessions.set(id, session);
    return session;
  }
  async function checkpoint(id, state, phase) {
    await options.beforeCheckpoint?.(phase);
    await (await getSession(id)).setValue(address, state, BACKGROUND_CONTEXT);
    checkpointWrites += 1;
  }
  const driver = {
    stats: () => ({ activeSessions: sessions.size, peakActiveSessions, checkpointWrites, repairs }),
    async getState(id) {
      const authoritative = kernel.journal.getState(id);
      if (!authoritative) {
        await listMetadata();
        const legacy = metadata.has(id) ? (await (await getSession(id)).getValue(address, BACKGROUND_CONTEXT))?.value : undefined;
        return kernel.state(id, legacy ?? emptyState());
      }
      const projected = (await (await getSession(id)).getValue(address, BACKGROUND_CONTEXT))?.value;
      if (JSON.stringify(projected) !== JSON.stringify(authoritative)) { await checkpoint(id, authoritative, "repair"); repairs += 1; }
      return authoritative;
    },
    async run(request, signal) {
      const state = await driver.getState(request.sessionId);
      let decision;
      let settled;
      let failure;
      // D1 chooses a bounded compiled plan; it does not generate chat tool calls.
      const agent = new Agent({
        initialState: { systemPrompt: "Local D1 decision bridge; memory devices only.", model: { id: "d1-3b-q4", api: "local-d1", provider: "local-d1" }, tools: [{
          name: "apply_selected_plan", description: "Apply the validated in-memory plan once",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          async execute(_id, _args, toolSignal) {
            try {
              settled = await kernel.settle(request, state, decision, toolSignal);
              return { content: [{ type: "text", text: settled.result.summary }], details: settled.result, terminate: true };
            } catch (error) { failure = error; throw error; }
          },
        }] },
        toolExecution: "sequential",
        finishTurn: () => ({ action: "end" }),
        streamFn(_model, _context, streamOptions) {
          const stream = new AssistantMessageEventStream();
          const message = { role: "assistant", api: "local-d1", provider: "local-d1", model: "d1-3b-q4", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now(), content: [], stopReason: "toolUse" };
          void (async () => {
            try {
              decision = await kernel.decide(request, state, streamOptions.signal);
              await checkpoint(request.sessionId, { ...state, prepared: { commandId: request.commandId, decision } }, "prepared");
              message.content = [{ type: "toolCall", id: request.commandId, name: "apply_selected_plan", arguments: {} }];
              stream.push({ type: "start", partial: message });
              stream.push({ type: "done", reason: "toolUse", message });
            } catch (error) {
              failure = error;
              stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: error.message } });
            }
          })();
          return stream;
        },
      });
      const abort = () => agent.abort();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        signal?.throwIfAborted();
        await agent.prompt(request.input);
        if (failure) throw failure;
        if (!settled) throw new Error("pi_run_did_not_settle");
        await checkpoint(request.sessionId, settled.state, "complete");
        await options.lifecycle?.("after_projection");
        return settled.result;
      } finally { signal?.removeEventListener("abort", abort); }
    },
    async close() {
      for (const session of sessions.values()) await session.close(BACKGROUND_CONTEXT);
      await repo.close(BACKGROUND_CONTEXT);
    },
  };
  return guardedRuntime(kernel, driver);
}
