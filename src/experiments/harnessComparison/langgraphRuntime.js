import { Annotation, StateGraph, START, END, interrupt, Command } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { join } from "node:path";
import { createKernel, emptyState, guardedRuntime } from "./kernel.js";

export async function createLangGraphRuntime(options) {
  const kernel = createKernel(options);
  const saver = SqliteSaver.fromConnString(join(options.directory, "graph.sqlite"));
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
  const config = (id, signal) => ({ configurable: { thread_id: id }, ...(signal ? { signal } : {}) });
  const driver = {
    async getState(id) { return (await graph.getState(config(id))).values.conversation ?? emptyState(); },
    async run(request, signal) {
      const snapshot = await graph.getState(config(request.sessionId));
      if (request.resumeFor && snapshot.values.conversation?.pending?.commandId !== request.resumeFor) throw new Error("stale_clarification");
      const paused = snapshot.next.includes("clarify");
      const input = paused ? new Command({ resume: request }) : { request, conversation: snapshot.values.conversation ?? emptyState(), result: null, decision: null };
      const output = await graph.invoke(input, config(request.sessionId, signal));
      return output.result;
    },
    close: async () => saver.db.close(),
  };
  return guardedRuntime(kernel, driver);
}
