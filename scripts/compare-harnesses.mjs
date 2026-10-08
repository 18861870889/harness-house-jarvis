import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPiRuntime } from "../src/experiments/harnessComparison/piRuntime.js";
import { createLangGraphRuntime } from "../src/experiments/harnessComparison/langgraphRuntime.js";
import { createD1Client } from "../src/d1Client.js";

const live = process.argv.includes("--live");
const output = process.argv.find((arg) => arg.startsWith("--output="))?.slice(9);
const root = mkdtempSync(join(tmpdir(), "house-harness-compare-"));
const runtimes = {};
const calls = { pi: 0, langgraph: 0 };
const native = live ? createD1Client({ endpoint: process.env.D1_ENDPOINT ?? "http://192.168.1.154:8080/v1/systemone", timeoutMs: 5000 }) : null;
const report = { mode: live ? "native_local_d1" : "deterministic_fixture_not_language_accuracy", node: process.version, simulatedDevices: true, frameworkVersions: { pi: "0.99.2", langgraph: "1.4.21" }, samples: {}, semantics: {} };
const factories = { pi: createPiRuntime, langgraph: createLangGraphRuntime };
try {
  for (const [name, factory] of Object.entries(factories)) {
    runtimes[name] = await factory({ directory: join(root, name), client: { async choose(options) {
      calls[name] += 1;
      if (native) return native.choose(options);
      const candidate = options.candidates.find((item) => item.actions?.length && item.actions.every((action) => action.value === true)) ?? options.candidates.find((item) => item.id === "clarify");
      return { candidate, probability: 0.95, margin: 0.9, purpose: { choice: "control", probability: 0.95, margin: 0.9 } };
    } } });
    report.samples[name] = [];
    report.semantics[name] = [];
  }
  if (!live) {
    // Warm-up is excluded; order alternates to limit systematic run-order bias.
    for (let i = -3; i < 30; i += 1) {
      for (const name of i % 2 ? ["pi", "langgraph"] : ["langgraph", "pi"]) {
        const start = performance.now();
        const result = await runtimes[name].run({ sessionId: "bench", commandId: `bench-${i}`, input: "打开书房射灯" });
        if (result.status !== "executed") throw new Error(`${name}: ${JSON.stringify(result)}`);
        if (i >= 0) report.samples[name].push(performance.now() - start);
      }
    }
  } else {
    const cases = [
      { id: "open", input: "打开书房射灯", expect: ["executed", "study", true] },
      { id: "follow", input: "关一下", expect: ["executed", "study", false] },
      { id: "explicit", input: "打开主卧灯", expect: ["executed", "master", true] },
      { id: "ambiguous", input: "卧室灯关一下", expect: ["needs_clarification"] },
      { id: "resume", input: "主卧", resumeFor: "ambiguous", expect: ["executed", "master", false] },
      { id: "negative", input: "不要打开客厅灯", expect: ["answered"] },
      { id: "query", input: "玄关人体传感器目前什么状态", expect: ["answered"] },
    ];
    for (const [index, test] of cases.entries()) {
      for (const name of index % 2 ? ["pi", "langgraph"] : ["langgraph", "pi"]) {
        const start = performance.now();
        const result = await runtimes[name].run({ sessionId: "live", commandId: test.id, input: test.input, ...(test.resumeFor ? { resumeFor: test.resumeFor } : {}) });
        const elapsedMs = performance.now() - start;
        const [status, roomId, value] = test.expect;
        const passed = result.status === status && (!roomId || result.actions?.length > 0 && result.actions.every((action) => action.logicalRoomId === roomId && action.value === value)) && (status !== "answered" || !result.actions?.length);
        report.samples[name].push(elapsedMs);
        const winner = result.d1?.candidates?.[Number(result.d1?.choice?.slice(1))];
        report.semantics[name].push({ input: test.input, passed, status: result.status, selectedId: result.selectedId, providerWinnerId: winner?.id, purpose: result.d1?.purpose, scopeBlock: result.d1?.scopeBlock, probability: result.d1?.probability, margin: result.d1?.margin, elapsedMs });
      }
    }
  }
  report.summary = Object.fromEntries(Object.keys(factories).map((name) => {
    const sorted = report.samples[name].toSorted((a, b) => a - b);
    return [name, { count: sorted.length, p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], inferenceCalls: calls[name], adapterLines: readFileSync(`src/experiments/harnessComparison/${name === "pi" ? "piRuntime" : "langgraphRuntime"}.js`, "utf8").split("\n").length - 1 }];
  }));
  report.sharedBusinessLines = readFileSync("src/experiments/harnessComparison/kernel.js", "utf8").split("\n").length - 1;
  if (output) { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`); }
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const runtime of Object.values(runtimes)) await runtime.close();
  rmSync(root, { recursive: true, force: true });
}
