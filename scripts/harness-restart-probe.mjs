import { createPiRuntime } from "../src/experiments/harnessComparison/piRuntime.js";
import { createLangGraphRuntime } from "../src/experiments/harnessComparison/langgraphRuntime.js";

const [name, directory] = process.argv.slice(2);
const factory = name === "pi" ? createPiRuntime : createLangGraphRuntime;
const runtime = await factory({ directory, client: { choose() { throw new Error("Restart replay must not infer"); } } });
try {
  const state = await runtime.getState("alice");
  const result = await runtime.run({ sessionId: "alice", commandId: "one", input: "打开书房射灯" });
  console.log(JSON.stringify({ focus: state.turns[0].plan.actions[0].logicalAssetId, replayed: result.replayed, writes: runtime.kernel.writes }));
} finally { await runtime.close(); }
