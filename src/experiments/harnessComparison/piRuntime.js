import { Agent, BACKGROUND_CONTEXT, value } from "@earendil-works/pi-agent-core";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createNodeSqliteFactory, SqliteSessionRepo } from "@earendil-works/pi-session-backend-sqlite-node";
import { join } from "node:path";
import { createKernel, emptyState, guardedRuntime } from "./kernel.js";

export async function createPiRuntime(options) {
  const kernel = createKernel(options);
  const repo = new SqliteSessionRepo({ directory: join(options.directory, "sessions"), databaseFactory: createNodeSqliteFactory() });
  const sessions = new Map();
  const address = value("harness-house", "conversation");
  async function getSession(id) {
    if (!sessions.has(id)) {
      const existing = (await repo.list(undefined, BACKGROUND_CONTEXT)).find((metadata) => metadata.id === id);
      sessions.set(id, existing ? await repo.open(existing, BACKGROUND_CONTEXT) : await repo.create({ id }, BACKGROUND_CONTEXT));
    }
    return sessions.get(id);
  }
  const driver = {
    async getState(id) {
      return (await (await getSession(id)).getValue(address, BACKGROUND_CONTEXT))?.value ?? emptyState();
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
        await (await getSession(request.sessionId)).setValue(address, settled.state, BACKGROUND_CONTEXT);
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
