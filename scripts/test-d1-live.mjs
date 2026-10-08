import { writeFileSync } from "node:fs";

const baseUrl = process.env.HARNESS_TEST_URL || "http://localhost:5173";
const runtime = await (await fetch(`${baseUrl}/api/runtime/status`)).json();
if (runtime.simulated !== true) throw new Error("Live D1 evaluation requires the memory-only demo. Refusing to contact real devices.");
const model = await (await fetch(`${baseUrl}/api/llm/status`)).json();
if (model.provider !== "local-d1" || model.cloudFallback !== false) throw new Error("D1-only mode is required");

// Expectations are evaluation-only; requests contain no oracle plans or candidate labels.
const regressionCases = [
  { input: "打开书房射灯", names: ["书房射灯"], values: [true] },
  { input: "关闭书房射灯", names: ["书房射灯"], values: [false] },
  { input: "不要打开书房射灯", noWrite: true },
  { input: "以后书房开灯优先射灯", noWrite: true },
  { input: "书房射灯现在是什么状态", noWrite: true, answered: true },
  { input: "客厅电视怎么打开", noWrite: true, answered: true },
  { input: "打开书房射灯，关闭书房吊灯", names: ["书房射灯", "书房吊灯"], values: [true, false] },
  { input: "打开书房射灯和书房吊灯", names: ["书房射灯", "书房吊灯"], values: [true, true], session: "multi" },
  { input: "把它关了", noWrite: true, clarify: true, session: "multi" },
  { input: "打开餐厅射灯", names: ["餐厅射灯"], values: [true] },
  { input: "把书房空调调到24度", names: ["书房空调"], values: [24] },
  { input: "把书房空调调到99度", noWrite: true, clarify: true },
  { input: "客厅窗帘调到30%", names: ["客厅窗帘"], values: [30] },
  { input: "玄关人体传感器现在是什么状态", noWrite: true, answered: true },
  { input: "卧室灯关一下", noWrite: true, clarify: true },
  { input: "开灯", noWrite: true, clarify: true, selectedRoomId: "study" },
  { input: "打开客厅电视", names: ["客厅电视"], values: [true], session: "tv" },
  { input: "把它关了", names: ["客厅电视"], values: [false], session: "tv", selectedRoomId: "study" },
  { input: "打开书房所有灯", names: ["书房射灯", "书房吊灯"], values: [true, true], session: "study" },
  { input: "关灯", names: ["书房射灯", "书房吊灯"], values: [false, false], session: "study", selectedRoomId: "living" },
  { input: "打开空气净化器", noWrite: true, clarify: true },
  { input: "书房灯不要开，但打开客厅电视", names: ["客厅电视"], values: [true] },
];
const holdoutCases = [
  { input: "麻烦把餐厅吊灯打开", names: ["餐厅吊灯"], values: [true] },
  { input: "关掉餐厅吊灯", names: ["餐厅吊灯"], values: [false] },
  { input: "别关客厅电视", noWrite: true },
  { input: "先不动主卧灯，帮我开客厅电视", names: ["客厅电视"], values: [true] },
  { input: "主卧灯亮度调到70%", names: ["主卧灯"], values: [70] },
  { input: "把客厅窗帘设为75%", names: ["客厅窗帘"], values: [75] },
  { input: "关闭主卧灯", names: ["主卧灯"], values: [false] },
  { input: "入户人体传感器目前有没有人", noWrite: true, answered: true },
  { input: "客厅电视有哪些功能", noWrite: true, answered: true },
  { input: "这个怎么用", noWrite: true, clarify: true },
  { input: "书房空调调到18度", names: ["书房空调"], values: [18] },
  { input: "把主卧灯开到200%", noWrite: true, clarify: true },
  { input: "打开主卧灯和次卧灯", names: ["主卧灯", "次卧灯"], values: [true, true] },
  { input: "关闭客厅风扇", names: ["客厅风扇"], values: [false] },
  { input: "请把客厅窗帘打开", names: ["客厅窗帘"], values: [true] },
  { input: "取消", noWrite: true },
  { input: "书房空调22度，客厅窗帘40%", noWrite: true, clarify: true },
  { input: "客厅风扇打开，餐厅吊灯别开", names: ["客厅风扇"], values: [true] },
  { input: "把书房射灯打开", names: ["书房射灯"], values: [true], session: "short" },
  { input: "关一下", names: ["书房射灯"], values: [false], session: "short" },
];
const suite = process.argv.includes("--holdout") ? "holdout" : "regression";
const cases = suite === "holdout" ? holdoutCases : regressionCases;
const results = [];
for (const [index, test] of cases.entries()) {
  const response = await fetch(`${baseUrl}/api/hcm/command`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: test.input, sessionId: `d1-eval-${suite}-${test.session || index}`, selectedRoomId: test.selectedRoomId || "living", dryRun: true }),
  });
  const result = await response.json();
  const actions = result.plan?.actions ?? [];
  const actual = actions.map((action) => [action.logicalAssetName ?? action.thingName, action.value]).sort((a, b) => a[0].localeCompare(b[0]));
  const expected = (test.names ?? []).map((name, item) => [name, test.values[item]]).sort((a, b) => a[0].localeCompare(b[0]));
  const pass = response.ok && (test.noWrite ? actions.length === 0 : JSON.stringify(actual) === JSON.stringify(expected))
    && (!test.answered || result.status === "answered") && (!test.clarify || result.status === "needs_clarification");
  results.push({ input: test.input, pass, status: result.status, actual, expected, latencyMs: result.latencyMs, d1LatencyMs: result.planner?.decision?.latencyMs, choice: result.planner?.decision?.selectedId, probability: result.planner?.decision?.probability, margin: result.planner?.decision?.margin, message: result.explanation?.userMessage, error: result.error });
  console.log(`${pass ? "PASS" : "FAIL"} ${test.input} -> ${result.status} ${JSON.stringify(actual)} ${result.latencyMs ?? "?"}ms`);
}
const times = results.map((result) => result.latencyMs).filter(Number.isFinite).sort((a, b) => a - b);
const report = { model: model.model, passed: results.filter((result) => result.pass).length, total: results.length, p50Ms: times[Math.floor(times.length * 0.5)], p95Ms: times[Math.min(times.length - 1, Math.floor(times.length * 0.95))], results };
writeFileSync(`data/d1-${suite}.local.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, results: undefined }));
if (report.passed !== report.total) process.exitCode = 1;
