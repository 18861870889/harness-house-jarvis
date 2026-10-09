import { describe, expect, it, vi } from "vitest";
import { createD1Client } from "./d1Client.js";

const candidates = [{ id: "on", label: "打开书房灯" }, { id: "ask", label: "询问用户" }];
const response = (answer) => ({ ok: true, json: async () => ({ answers: { plan: answer } }) });
const good = { type: "choice", choice: "p0", probabilities: { p0: 0.9, p1: 0.1 }, confidence: 0.8 };

describe("native D1 client", () => {
  const semanticQuestions = { task: { type: "choice", instructions: "意图", criteria: { on: "打开", off: "关闭" } } };

  it("semantic and legacy inference share one bounded slot", async () => {
    let finish;
    const client = createD1Client({ endpoint: "http://d1.invalid/v1/systemone", fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
    const first = client.classify({ state: "test", questions: semanticQuestions });
    await expect(client.choose({ state: "second", candidates })).rejects.toThrow("另一条");
    finish({ ok: true, json: async () => ({ answers: { task: { type: "choice", choice: "on", probabilities: { on: 0.9, off: 0.1 } } } }) });
    await first;
  });

  it("semantic cancellation and timeout release the slot without retries", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    const client = createD1Client({ endpoint: "http://d1.invalid/v1/systemone", timeoutMs: 10, fetchImpl });
    const first = client.classify({ state: "test", questions: semanticQuestions, signal: controller.signal });
    controller.abort(); await expect(first).rejects.toThrow("取消");
    await expect(client.classify({ state: "test", questions: semanticQuestions })).rejects.toThrow("超时");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("bounds semantic question counts, criteria and payloads before transport", async () => {
    const fetchImpl = vi.fn(); const client = createD1Client({ endpoint: "http://d1.invalid/v1/systemone", fetchImpl });
    await expect(client.classify({ state: "x".repeat(6001), questions: semanticQuestions })).rejects.toThrow("budget");
    await expect(client.classify({ state: "test", questions: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`q${i}`, semanticQuestions.task])) })).rejects.toThrow("budget");
    await expect(client.classify({ state: "test", questions: { q: { ...semanticQuestions.task, criteria: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}`, "label"])) } } })).rejects.toThrow("Invalid");
    await expect(client.classify({ state: "test", questions: { q: { ...semanticQuestions.task, criteria: { on: "x".repeat(501), off: "关闭" } } } })).rejects.toThrow("Invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("semantic HTTP errors fail closed without another provider", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }));
    const client = createD1Client({ endpoint: "http://d1.invalid/v1/systemone", fetchImpl });
    await expect(client.classify({ state: "test", questions: semanticQuestions })).rejects.toThrow("503");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("batches typed semantic fields in one native call", async () => {
    const questions = { task: { type: "choice", instructions: "意图", criteria: { on: "打开", off: "关闭" } }, extent: { type: "choice", instructions: "数量", criteria: { one: "一个", all: "全部" } } };
    const answer = (choice, other) => ({ type: "choice", choice, probabilities: { [choice]: 0.9, [other]: 0.1 } });
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ answers: { task: answer("on", "off"), extent: answer("one", "all") } }) }));
    const client = createD1Client({ endpoint: "http://d1.invalid/v1/systemone", fetchImpl });
    const result = await client.classify({ state: "开一个灯", questions });
    expect(result.answers.task.choice).toBe("on");
    expect(result.answers.extent.choice).toBe("one");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).questions).toEqual(questions);
  });

  it("rejects incomplete semantic fields and extra answers", async () => {
    const questions = { task: { type: "choice", instructions: "意图", criteria: { on: "打开", off: "关闭" } } };
    for (const answers of [{}, { task: { type: "choice", choice: "on", probabilities: { on: 0.9, off: 0.1 } }, extra: good }]) {
      const client = createD1Client({ endpoint: "http://d1.invalid/v1/systemone", fetchImpl: async () => ({ ok: true, json: async () => ({ answers }) }) });
      await expect(client.classify({ state: "开灯", questions })).rejects.toThrow("invalid decision");
    }
  });

  it("uses systemone choice protocol without API key or chat-completions", async () => {
    const fetchImpl = vi.fn(async () => response(good));
    const client = createD1Client({ endpoint: "http://d1.invalid/v1/systemone", fetchImpl });
    const result = await client.choose({ state: "当前用户指令：打开书房灯", candidates });
    expect(result.candidate.id).toBe("on");
    expect(result.margin).toBeCloseTo(0.8);
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://d1.invalid/v1/systemone");
    expect(request.headers.Authorization).toBeUndefined();
    expect(JSON.parse(request.body).questions.plan.criteria).toEqual({ p0: candidates[0].label, p1: candidates[1].label });
  });

  it.each([
    null,
    { ...good, choice: "unknown" },
    { ...good, probabilities: { p0: 0.1, p1: 0.9 } },
    { ...good, probabilities: { p0: 0.9 } },
    { ...good, probabilities: { p0: 0.9, p1: 0.9 } },
    { ...good, probabilities: { p0: NaN, p1: 0.1 } },
    { ...good, probabilities: { p0: 0.9, p1: 0.1, foreign: 0 } },
    { ...good, type: "noul" },
  ])("rejects malformed or inconsistent distributions %#", async (answer) => {
    const client = createD1Client({ endpoint: "http://d1.invalid/v1/systemone", fetchImpl: async () => response(answer) });
    await expect(client.choose({ state: "test", candidates })).rejects.toThrow();
  });

  it("fails closed on HTTP errors without retrying another provider", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }));
    const client = createD1Client({ endpoint: "http://d1.invalid/v1/systemone", fetchImpl });
    await expect(client.choose({ state: "test", candidates })).rejects.toThrow("503");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("validates both independent answers when purpose checking is requested", async () => {
    const client = createD1Client({ endpoint: "http://d1.invalid/v1/systemone", fetchImpl: async () => response(good) });
    await expect(client.choose({ state: "test", candidates, purposeCandidates: [{ id: "control", label: "立即控制" }, { id: "query", label: "查询" }] })).rejects.toThrow("invalid decision");
  });

  it("serializes the joint intent/action description instead of dropping it at the API boundary", async () => {
    const fetchImpl = vi.fn(async () => response(good));
    const client = createD1Client({ endpoint: "http://d1.invalid/v1/systemone", fetchImpl });
    const decisions = candidates.map((candidate) => ({ ...candidate, modelDescription: `完整决策：${candidate.label}` }));
    await client.choose({ state: "当前用户指令：开灯", candidates: decisions, instructions: "选择意图与动作一致的决策" });
    const payload = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(payload.questions.plan.instructions).toBe("选择意图与动作一致的决策");
    expect(payload.questions.plan.criteria.p0).toBe(decisions[0].modelDescription);
    expect(payload.questions.purpose).toBeUndefined();
  });

  it("times out and releases the single inference slot", async () => {
    const fetchImpl = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))));
    const client = createD1Client({ endpoint: "http://d1.invalid/v1/systemone", timeoutMs: 10, fetchImpl });
    await expect(client.choose({ state: "test", candidates })).rejects.toThrow("超时");
    await expect(client.choose({ state: "test", candidates })).rejects.toThrow("超时");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects concurrency instead of building an unbounded queue", async () => {
    let finish;
    const client = createD1Client({ endpoint: "http://d1.invalid/v1/systemone", fetchImpl: () => new Promise((resolve) => { finish = resolve; }) });
    const first = client.choose({ state: "first", candidates });
    await expect(client.choose({ state: "second", candidates })).rejects.toThrow("另一条");
    finish(response(good));
    await first;
  });

  it("propagates external cancellation and releases the inference slot", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    const client = createD1Client({ endpoint: "http://d1.invalid/v1/systemone", timeoutMs: 10, fetchImpl });
    const first = client.choose({ state: "test", candidates, signal: controller.signal });
    controller.abort();
    await expect(first).rejects.toThrow("取消");
    await expect(client.choose({ state: "test", candidates })).rejects.toThrow("超时");
    await expect(client.choose({ state: "test", candidates, signal: controller.signal })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("bounds input and candidates before making any network call", async () => {
    const fetchImpl = vi.fn();
    const client = createD1Client({ endpoint: "http://d1.invalid/v1/systemone", fetchImpl });
    await expect(client.choose({ state: "x".repeat(4001), candidates })).rejects.toThrow("budget");
    await expect(client.choose({ state: "test", candidates: Array(17).fill(candidates[0]) })).rejects.toThrow("budget");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
