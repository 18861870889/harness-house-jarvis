import { createPiRuntime } from "../src/experiments/harnessComparison/piRuntime.js";
import { createLangGraphRuntime } from "../src/experiments/harnessComparison/langgraphRuntime.js";

const [name, directory, phase, scenario = "control"] = process.argv.slice(2);
const factory = name === "pi" ? createPiRuntime : createLangGraphRuntime;
const runtime = await factory({ directory, client: { async choose({ candidates }) {
  const candidate = candidates.find((item) => item.actions?.length && item.actions.every((action) => action.value === true)) ?? candidates.find((item) => item.id === "clarify");
  return { candidate, probability: 0.95, margin: 0.9, purpose: { choice: "control", probability: 0.95, margin: 0.9 } };
} }, lifecycle: async (current) => {
  if (current === phase) {
    setInterval(() => {}, 1000);
    process.send?.({ phase });
    await new Promise(() => {});
  }
} });
try {
  await runtime.run({ sessionId: "alice", commandId: "crash", input: scenario === "clarification" ? "卧室灯关一下" : "打开书房射灯" });
  throw new Error("Expected crash barrier was not reached");
} finally { await runtime.close(); }
