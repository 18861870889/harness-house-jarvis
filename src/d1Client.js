export function createD1Client({
  endpoint,
  model = "d1-3b-q4",
  timeoutMs = 1800,
  fetchImpl = fetch,
} = {}) {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid D1 endpoint");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid D1 timeout");
  let busy = false;

  return {
    model,
    async choose({ state, candidates, purposeCandidates, instructions, signal }) {
      signal?.throwIfAborted();
      if (busy) throw new Error("D1 正在处理另一条指令，请稍后重试。设备没有执行。");
      if (candidates.length < 2 || candidates.length > 16) throw new Error("D1 candidate budget exceeded");
      if (state.length > 4000) throw new Error("D1 context budget exceeded");
      const criteria = Object.fromEntries(candidates.map((candidate, index) => [`p${index}`, candidate.modelDescription ?? candidate.label]));
      if (Object.values(criteria).some((label) => typeof label !== "string" || label.length > 500)) {
        throw new Error("Invalid D1 candidate label");
      }
      if (state.length + Object.values(criteria).join("").length > 3000) throw new Error("D1 context budget exceeded");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();
      busy = true;
      try {
        const response = await fetchImpl(url.href, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
          body: JSON.stringify({ model, state, questions: {
            plan: { type: "choice", instructions: instructions ?? "哪个方案符合这条用户指令？", criteria },
            ...(purposeCandidates ? { purpose: {
              type: "choice", instructions: "用户是在要求立刻操作设备，还是仅在咨询信息或描述偏好？",
              criteria: Object.fromEntries(purposeCandidates.map((candidate) => [candidate.id, candidate.label])),
            } } : {}),
          } }),
        });
        if (!response.ok) throw new Error(`D1 HTTP ${response.status}`);
        const data = await response.json();
        const answer = data.answers?.plan;
        const keys = Object.keys(criteria);
        const distribution = validateDistribution(answer, keys);
        const purpose = purposeCandidates ? {
          ...validateDistribution(data.answers?.purpose, purposeCandidates.map((candidate) => candidate.id)),
          choice: data.answers.purpose.choice,
        } : null;
        return {
          candidate: candidates[keys.indexOf(answer.choice)],
          choice: answer.choice,
          ...distribution,
          purpose,
          // Provider confidence is a normalized top-choice score, not execution authorization.
          providerConfidence: answer.confidence,
          latencyMs: Date.now() - startedAt,
          usage: data.usage,
        };
      } catch (error) {
        if (signal?.aborted) throw new Error("D1 请求已取消，设备没有执行。");
        if (controller.signal.aborted) throw new Error("D1 响应超时，设备没有执行。请重试。");
        throw error;
      } finally {
        clearTimeout(timer);
        busy = false;
      }
    },
  };
}

function validateDistribution(answer, keys) {
  const probabilities = answer?.probabilities;
  if (answer?.type !== "choice" || !keys.includes(answer.choice) || !probabilities
    || Object.keys(probabilities).length !== keys.length
    || keys.some((key) => !Number.isFinite(probabilities[key]) || probabilities[key] < 0 || probabilities[key] > 1)
    || Math.abs(keys.reduce((sum, key) => sum + probabilities[key], 0) - 1) > 0.02) {
    throw new Error("D1 returned an invalid decision distribution");
  }
  const ranked = keys.toSorted((a, b) => probabilities[b] - probabilities[a]);
  if (ranked[0] !== answer.choice) throw new Error("D1 choice disagrees with distribution");
  return { probabilities, probability: probabilities[answer.choice], margin: probabilities[ranked[0]] - probabilities[ranked[1]] };
}
