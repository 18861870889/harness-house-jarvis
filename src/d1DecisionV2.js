import { buildD1Candidates } from "./d1Decision.js";
import { findExplicitRoomIds } from "./hcmControlGraph.js";
import { isReferentialControlInput, isRoomScopedFollowUpInput } from "./conversationContext.js";

export const D1_DECISION_CONTRACT_VERSION = "2.0";
const INSTRUCTIONS = "哪个完整决策符合当前这一轮用户指令？同时匹配目标和操作或查询。查询方法不是要求实际执行。最近对话仅补全省略的目标，不能代替当前指令。";
const LIGHTING_INSTRUCTIONS = "当前这一轮用户希望房间更亮、更暗，还是仅查询或不操作？描述当前光线不合适是在寻求改善。选择能改善现状的方案，已完成的动作不要重复；没有对应可行能力时应解释，不选择相反方向。否定和未来偏好不操作。";
const goalHint = (input) => /暗|亮一点|更亮|更暗|太亮|调亮|调暗|不够亮/.test(input) && !/多少|状态|是否|为什么|怎么|如何|支持|\d+\s*(%|％|度|℃)/.test(input);

function scopedConversation(input, home, conversation) {
  const explicit = findExplicitRoomIds(input, home);
  const referential = /它|这个|那个|那盏|这盏|刚才|刚刚/.test(input) || isReferentialControlInput(input) && !isRoomScopedFollowUpInput(input) && !goalHint(input);
  const location = conversation.currentRoom;
  if (!explicit.length && !referential && conversation.uncertainOrigin) {
    return { conversation: { ...conversation, focusedTargets: [], focusedRooms: [] }, source: "ambiguous_origin" };
  }
  if (!explicit.length && !referential && location?.source === "configured_terminal" && home.spaces.some((room) => room.id === location.id)) {
    return { conversation: { ...conversation, focusedTargets: [], focusedRooms: [{ id: location.id }] }, source: "terminal" };
  }
  return { conversation, source: explicit.length ? "explicit_room" : referential ? "conversation_target" : conversation.focusedRooms?.length ? "conversation_room" : "unspecified" };
}

function originalCapability(home, device, capability) {
  return home.things.find((thing) => thing.id === device.id)?.capabilities.find((item) => item.id === capability.id);
}

function goalCandidates(home, devices, forbidden) {
  const candidates = [];
  for (const device of devices.filter((item) => item.type === "light" && !forbidden.has(item.id))) {
    const power = device.capabilities.find((capability) => capability.access === "execute" && capability.valueType === "boolean");
    const brightness = device.capabilities.find((capability) => capability.access === "execute" && capability.domain === "light" && capability.valueType === "number" && /brightness|亮度/i.test(`${capability.id} ${capability.name}`));
    const add = (direction, capability, value, description) => candidates.push({
      id: `goal:${direction}:${device.id}`, label: description, summary: description, intentType: "device_control",
      actions: [{ device_id: device.id, capability: capability.id, value, reason: description }],
      goal: { domain: "lighting", desired_outcome: direction, space_refs: [device.roomId], evidence: "device_state_only" },
    });
    if (power?.state === false) add("brighter", power, true, `增加房间照明：补开${device.name}，其余设备保持不变`);
    if (power?.state === true && !brightness) add("dimmer", power, false, `减少房间照明：关闭${device.name}，其余设备保持不变`);
    if (power?.state !== true || !brightness || !Number.isFinite(brightness.state)) continue;
    const constraints = originalCapability(home, device, brightness)?.evidence?.constraints ?? {};
    const min = constraints.min ?? constraints.minValue ?? 0;
    const max = constraints.max ?? constraints.maxValue ?? 100;
    const step = constraints.step ?? 1;
    if (![min, max, step].every(Number.isFinite) || step <= 0 || min < 0 || max > 100 || min >= max || brightness.state < min || brightness.state > max) continue;
    for (const [direction, sign] of [["brighter", 1], ["dimmer", -1]]) {
      const raw = Math.min(max, Math.max(min, brightness.state + sign * 20));
      const value = Number((min + Math.round((raw - min) / step) * step).toFixed(6));
      if (value < min || value > max || sign * (value - brightness.state) <= 0) continue;
      add(direction, brightness, value, `${direction === "brighter" ? "增加" : "减少"}房间照明：将${device.name}亮度从${brightness.state}%调到${value}%，其余设备保持不变`);
    }
  }
  for (const direction of ["brighter", "dimmer"]) if (!candidates.some((candidate) => candidate.goal?.desired_outcome === direction)) {
    candidates.push({ id: `goal_limit:${direction}`, intentType: "unknown", actions: [], clarify: true,
      label: `${direction === "brighter" ? "调亮" : "调暗"}没有已确认的可行调整，说明能力或状态限制，不操作`,
      summary: `这个房间目前没有已确认的进一步${direction === "brighter" ? "调亮" : "调暗"}方案。我先不操作。`,
    });
  }
  return candidates;
}

export function buildD1DecisionPack({ input, home, conversation = {} }) {
  const scoped = scopedConversation(input, home, conversation);
  const pack = buildD1Candidates({ input, home, conversation: scoped.conversation, semanticDecision: true });
  const scope = { source: scoped.source, roomIds: [...new Set(pack.devices.map((device) => device.roomId))], targetIds: pack.devices.map((device) => device.id) };
  let candidates = pack.candidates;
  if (/^(取消|算了|不用了|不操作|先不操作)[吧。！! ]*$/.test(input)) pack.block = null;
  if (!pack.block && !pack.enforceReadOnly && goalHint(input) && pack.devices.length && pack.devices.every((device) => device.type === "light") && scope.roomIds.length === 1) {
    candidates = [...goalCandidates(home, pack.devices, new Set(pack.forbiddenIds)), ...candidates.filter((candidate) => !candidate.actions.length)];
  }
  const feedbackRooms = findExplicitRoomIds(input, home);
  const feedbackRoom = scoped.source === "terminal" ? scoped.conversation.currentRoom?.id : null;
  const goalRoomMatches = feedbackRooms.length ? feedbackRooms.includes(conversation.activeGoalTask?.roomId)
    : !feedbackRoom || feedbackRoom === conversation.activeGoalTask?.roomId;
  if (goalRoomMatches && ["awaiting_user_feedback", "awaiting_confirmation"].includes(conversation.activeGoalTask?.status)) {
    candidates = [...candidates,
      { id: "goal_feedback", label: "用户明确表示当前灯光已合适或已满意，不需要继续调整，保持现状不操作设备", summary: "好，保持现在的灯光。", actions: [], intentType: "unknown", goalFeedback: "satisfied" },
      { id: "goal_feedback_improved", label: "用户反馈比刚才改善了、好多了，但未明确表示已足够合适，记录改善而不认定目标完成，不操作设备", summary: "好，有改善。还需要调整吗？", actions: [], intentType: "unknown", goalFeedback: "improved" },
    ];
    if (!pack.devices.length) pack.block = null;
  }
  if (candidates.length > 16) {
    pack.block = "可行方案较多，请说明具体灯具或调整目标。我先不操作。";
    candidates = [{ id: "clarify", label: pack.block, summary: pack.block, clarify: true, intentType: "unknown", actions: [] }, { id: "no_action", label: "取消或不操作", summary: "没有操作设备。", intentType: "unknown", actions: [] }];
  }
  candidates = candidates.map((candidate) => {
    const mode = candidate.clarify ? "ask_clarification" : candidate.actions.length ? "execute" : candidate.query || candidate.intentType === "inventory_query" || candidate.goalFeedback ? "answer" : "no_action";
    const modelDescription = candidate.goal ? `用户希望房间${candidate.goal.desired_outcome === "brighter" ? "更亮" : "暗一点"}：${candidate.label}`
      : mode === "execute" ? candidate.label
      : candidate.query ? `用户仅询问当前状态：${candidate.label}，不要求改变设备`
        : candidate.intentType === "inventory_query" ? candidate.label
          : candidate.goalFeedback ? candidate.label
            : candidate.clarify ? `用户想控制设备，但目标或能力不明确，需要反问：${candidate.label}`
              : candidate.id === "preference" ? candidate.label : "用户明确取消、禁止操作或本次不需要执行，保持设备不变";
    return { ...candidate, scope, decision: { mode }, modelDescription };
  });
  return { ...pack, candidates, scope };
}

export async function decideWithD1V2({ input, home, conversation = {}, client }) {
  const pack = buildD1DecisionPack({ input, home, conversation });
  const focusNames = (conversation.focusedTargets ?? []).map((target) => target.name).join("、");
  const state = `当前用户指令：${input}\n${focusNames && pack.scope.source === "conversation_target" ? `上一轮目标：${focusNames}\n` : ""}`
    + `可信发言房间：${conversation.currentRoom?.name ?? conversation.currentRoom?.id ?? "未知"}\n`
    + `本次操作或查询范围：${pack.scope.roomIds.map((id) => home.spaces.find((room) => room.id === id)?.name ?? id).join("、") || "未明确"}\n`
    + `${conversation.activeGoalTask ? `进行中的目标：${JSON.stringify(conversation.activeGoalTask)}\n` : ""}`
    + pack.devices.map((device) => `${device.name}：${device.capabilities.map((capability) => `${capability.name}=${JSON.stringify(capability.state ?? "未知")}`).join("，")}`).join("\n");
  const result = await client.choose({ state, candidates: pack.candidates, instructions: pack.candidates.some((candidate) => candidate.goal) ? LIGHTING_INSTRUCTIONS : INSTRUCTIONS });
  if (![result.probability, result.margin].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    || !pack.candidates.some((candidate) => JSON.stringify(candidate) === JSON.stringify(result.candidate))) throw new Error("invalid_decision");
  const uncertain = result.probability < 0.65 || result.margin < 0.2;
  const selected = pack.block || uncertain ? pack.candidates.find((candidate) => candidate.id === "clarify") : result.candidate;
  const proposal = uncertain && !pack.block && result.probability >= 0.5 && result.margin >= 0.2 && result.candidate.actions.length
    ? { label: result.candidate.label, actions: result.candidate.actions, scope: result.candidate.scope, goal: result.candidate.goal } : undefined;
  const proposedAction = proposal?.actions[0];
  const proposedName = proposedAction ? pack.devices.find((device) => device.id === proposedAction.device_id)?.name : null;
  const proposalQuestion = result.candidate.goal && proposedName
    ? typeof proposedAction.value === "number" ? `要把${proposedName}亮度调到${proposedAction.value}%吗？` : `要我${proposedAction.value ? "补开" : "关闭"}${proposedName}吗？`
    : proposal ? `要我${proposal.label}吗？` : null;
  const summary = proposal ? proposalQuestion
    : uncertain && !pack.block ? "我还不能确定你要控制、查询还是调整，请补充一下。" : selected.summary;
  return {
    intent: input, intent_type: selected.intentType, confidence: result.probability, summary,
    actions: selected.actions, query: selected.query, goal: selected.goal, goalFeedback: selected.goalFeedback, proposal,
    intent_frame: { intent_type: selected.intentType, intent: input, confidence: result.probability, goal: selected.goal,
      decision: { mode: selected.decision.mode, reason: summary }, ambiguity: { needs_clarification: Boolean(selected.clarify) },
    },
    d1: { ...result, candidate: undefined, purpose: undefined, contractVersion: D1_DECISION_CONTRACT_VERSION, selectedId: selected.id,
      candidateCount: pack.candidates.length, candidates: pack.candidates.map(({ id, label }) => ({ id, label })), scope: pack.scope, scopeBlock: pack.block, readOnly: Boolean(pack.enforceReadOnly), uncertain },
  };
}
