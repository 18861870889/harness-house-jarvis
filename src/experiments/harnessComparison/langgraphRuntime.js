import { Annotation, StateGraph, START, END, interrupt, Command } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { join } from "node:path";
import { createKernel, emptyState, guardedRuntime } from "./kernel.js";

export async function createLangGraphRuntime(options) {
  const kernel = createKernel(options);
  let saver;
  try { saver = SqliteSaver.fromConnString(join(options.directory, "graph.sqlite")); }
  catch (error) { kernel.close(); throw error; }
  saver.db.pragma("journal_mode = WAL");
  saver.db.pragma("synchronous = FULL");
  let checkpointWrites = 0;
  let repairs = 0;
  const put = saver.put.bind(saver);
  saver.put = async (config, checkpoint, metadata) => {
    const values = checkpoint.channel_values;
    await options.beforeCheckpoint?.(values.decision ? "prepared" : values.result ? "complete" : "admitted");
    const result = await put(config, checkpoint, metadata);
    checkpointWrites += 1;
    return result;
  };
  const schema = Annotation.Root({ request: Annotation(), conversation: Annotation(), decision: Annotation(), result: Annotation() });
  const graph = new StateGraph(schema)
    .addNode("decide", async (state, config) => ({ decision: await kernel.decide(state.request, state.conversation ?? emptyState(), config.signal) }))
    .addNode("settle", async (state, config) => {
      const settled = await kernel.settle(state.request, state.conversation ?? emptyState(), state.decision, config.signal);
      return { conversation: settled.state, result: settled.result, decision: null };
    })
    .addNode("clarify", (state) => ({ request: interrupt({ commandId: state.request.commandId, question: state.result.summary }) }))
    .addEdge(START, "decide").addEdge("decide", "settle")
    .addConditionalEdges("settle", (state) => state.result.status === "needs_clarification" ? "clarify" : END)
    .addEdge("clarify", "decide")
    .compile({ checkpointer: saver });
  const config = (id, signal) => ({ configurable: { thread_id: id }, durability: "sync", ...(signal ? { signal } : {}) });
  const driver = {
    stats: () => ({ checkpointWrites, repairs }),
    async getState(id) {
      const snapshot = await graph.getState(config(id));
      const authoritative = kernel.state(id, snapshot.values.conversation ?? emptyState());
      if (snapshot.values.conversation && JSON.stringify(snapshot.values.conversation) !== JSON.stringify(authoritative)) {
        await graph.updateState(config(id), { conversation: authoritative, decision: null, result: null }, START);
        repairs += 1;
      }
      return authoritative;
    },
    async run(request, signal) {
      const state = await driver.getState(request.sessionId);
      const snapshot = await graph.getState(config(request.sessionId));
      if (request.resumeFor && state.pending?.commandId !== request.resumeFor) throw new Error("stale_clarification");
      const paused = snapshot.next.includes("clarify") && snapshot.values.conversation?.pending?.commandId === state.pending?.commandId;
      const input = paused ? new Command({ resume: request }) : { request, conversation: state, result: null, decision: null };
      const output = await graph.invoke(input, config(request.sessionId, signal));
      await options.lifecycle?.("after_projection");
      return output.result;
    },
    close: async () => saver.db.close(),
  };
  return guardedRuntime(kernel, driver);
}
