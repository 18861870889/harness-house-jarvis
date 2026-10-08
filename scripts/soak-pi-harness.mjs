import { mkdtempSync, rmSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPiRuntime } from "../src/experiments/harnessComparison/piRuntime.js";

const option = (name, fallback) => Number(process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const iterations = option("iterations", 2000);
const durationMs = option("duration-ms", 60000);
const people = option("sessions", 20);
const output = process.argv.find((arg) => arg.startsWith("--output="))?.slice(9);
if (![iterations, durationMs, people].every(Number.isSafeInteger) || iterations < 100 || iterations > 10000 || durationMs < 0 || durationMs > 600000 || people < 1 || people > 64) throw new Error("invalid_soak_options");
if (typeof global.gc !== "function") throw new Error("Use node --expose-gc for comparable heap samples");
const directory = mkdtempSync(join(tmpdir(), "house-pi-soak-"));
let desired = true;
let calls = 0;
let runtime;
const samples = [];
const latencies = [];
let writesExpected = 0;
const report = { mode: "deterministic_fixture_not_language_accuracy", node: process.version, simulatedDevices: true, iterations, people, requestedDurationMs: durationMs, cacheLimit: 4, retainedResultLimit: 64 };
function sample(i) {
  global.gc();
  const memory = process.memoryUsage();
  samples.push({ iteration: i, heapUsed: memory.heapUsed, rss: memory.rss, ...runtime.stats() });
}
function bytes(path) {
  const stat = statSync(path);
  return stat.isDirectory() ? readdirSync(path).reduce((total, name) => total + bytes(join(path, name)), 0) : stat.size;
}
try {
  runtime = await createPiRuntime({ directory, maxOpenSessions: 4, retainedResults: 64, maxSessions: 64, maxRequests: 20000, client: { async choose({ candidates }) {
    calls += 1;
    const candidate = candidates.find((item) => item.actions?.length && item.actions.every((action) => action.value === desired));
    if (!candidate) throw new Error("fixture_candidate_missing");
    return { candidate, probability: 0.95, margin: 0.9, purpose: { choice: "control", probability: 0.95, margin: 0.9 } };
  } } });
  for (let i = 0; i < 100; i += 1) {
    await runtime.run({ sessionId: `person-${i % people}`, commandId: `warm-${i}`, input: "打开书房射灯" });
    writesExpected += 1;
  }
  sample(0);
  const startedAt = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    const remaining = startedAt + i * durationMs / iterations - performance.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    desired = i % 2 === 0;
    const preview = i % 10 === 0;
    const request = { sessionId: `person-${i % people}`, commandId: `soak-${i}`, input: desired ? "打开书房射灯" : "关闭书房射灯", preview };
    const start = performance.now();
    const result = await runtime.run(request);
    latencies.push(performance.now() - start);
    if (result.status !== (preview ? "dry_run" : "executed") || result.checkpointWarning) throw new Error(`Unexpected result ${JSON.stringify(result)}`);
    if (!preview) writesExpected += 1;
    const before = calls;
    const replay = await runtime.run(request);
    if (!replay.replayed || calls !== before || runtime.kernel.writes !== writesExpected) throw new Error("duplicate_effect_or_inference");
    if ((i + 1) % 100 === 0) sample(i + 1);
    if ((i + 1) % 500 === 0) console.error(JSON.stringify({ progress: i + 1, total: iterations, elapsedMs: performance.now() - startedAt }));
  }
  report.elapsedMs = performance.now() - startedAt;
  report.inferenceCalls = calls;
  report.writes = runtime.kernel.writes;
  report.samples = samples;
  report.storageBytes = bytes(directory);
  const sorted = latencies.toSorted((a, b) => a - b);
  report.p50Ms = sorted[Math.ceil(sorted.length * 0.5) - 1];
  report.p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1];
  report.postGcHeapGrowthBytes = samples.at(-1).heapUsed - samples[0].heapUsed;
  report.passed = samples.every((entry) => entry.activeSessions <= 4 && entry.retainedResults <= 64 && entry.conversations <= people) && writesExpected === runtime.kernel.writes && report.postGcHeapGrowthBytes < 64 * 1024 * 1024;
  if (!report.passed) throw new Error("Soak guard failed");
  if (output) { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`); }
  console.log(JSON.stringify({ ...report, samples: `${samples.length} samples saved in report` }, null, 2));
} finally {
  await runtime?.close();
  rmSync(directory, { recursive: true, force: true });
}
