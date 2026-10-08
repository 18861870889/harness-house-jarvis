import { describe, expect, it, vi } from "vitest";
import { createD1Client } from "./d1Client.js";

const candidates = [{ id: "on", label: "打开书房灯" }, { id: "ask", label: "询问用户" }];
const response = (answer) => ({ ok: true, json: async () => ({ answers: { plan: answer } }) });
const good = { type: "choice", choice: "p0", probabilities: { p0: 0.9, p1: 0.1 }, confidence: 0.8 };

describe("native D1 client", () => {
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
