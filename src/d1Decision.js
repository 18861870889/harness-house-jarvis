import { compileHcmForPlanner } from "./hcmPlanner.js";
import { findExplicitRoomIds, resolveControlAsset } from "./hcmControlGraph.js";
import { isReferentialControlInput, isRoomScopedFollowUpInput } from "./conversationContext.js";

const TYPES = [
  [/灯|照明/, new Set(["light", "switch_panel"])],
  [/空调/, new Set(["ac"])],
  [/风扇/, new Set(["fan"])],
  [/窗帘|纱帘/, new Set(["curtain"])],
  [/晾衣|晒衣/, new Set(["drying_rack"])],
  [/电视|音箱|音乐/, new Set(["tv"])],
  [/人体|人在|传感器/, new Set(["motion_sensor", "presence_sensor", "door_sensor"])],
];
const PURPOSES = [
  { id: "control", label: "要求现在执行设备控制" },
  { id: "state", label: "询问设备当前状态，不要求操作" },
  { id: "capabilities", label: "询问怎么使用设备、怎么控制、有哪些功能，不要求操作" },
  { id: "no_write", label: "取消、禁止操作、聊天、建议或者未来偏好，不要求现在操作" },
  { id: "unclear", label: "无法确定，应该反问" },
];

// Retrieval narrows the HCM catalogue; operation direction remains a D1 choice.
export function buildD1Candidates({ input, home, conversation = {} }) {
  const catalog = compileHcmForPlanner(home);
  const roomIds = findExplicitRoomIds(input, home);
  const focusIds = new Set((conversation.focusedTargets ?? []).map((target) => target.id));
  const focusRooms = [...new Set([
    ...(conversation.focusedRooms ?? []).map((room) => room.id),
    ...catalog.filter((device) => focusIds.has(device.id)).map((device) => device.roomId),
  ])];
  const referential = /它|这个|那个/.test(input) || isReferentialControlInput(input) && !isRoomScopedFollowUpInput(input);
  let block = null;
  if (referential && roomIds.length === 0 && focusIds.size !== 1) block = "你指的是哪个设备？我先不操作。";
  if (/卧室|睡房/.test(input) && !home.spaces.some((room) => /主卧|次卧|儿童房/.test(room.name) && input.includes(room.name))) {
    const bedrooms = home.spaces.filter((room) => /主卧|次卧|卧室|儿童房/.test(room.name));
    if (bedrooms.length > 1) block = `你指的是${bedrooms.map((room) => room.name).join("还是")}？`;
  }
  let devices = roomIds.length ? catalog.filter((device) => roomIds.includes(device.roomId)) : catalog;
  const genericLightRooms = home.spaces.filter((room) => input.includes(`${room.name}灯`) || input.includes(`${room.name}所有灯`)).map((room) => room.id);
  const named = devices.filter((device) => [device.name, ...(device.aliases ?? [])].some((name) => {
    const room = home.spaces.find((space) => space.id === device.roomId);
    const localName = String(name).replace(room?.name ?? "", "").trim();
    return name.length >= 2 && input.includes(name)
      || roomIds.length > 0 && localName.length >= 2 && input.includes(localName);
  }));
  const typeSets = TYPES.filter(([pattern]) => pattern.test(input)).map(([, types]) => types);
  if (named.length) devices = devices.filter((device) => named.includes(device) || genericLightRooms.includes(device.roomId) && ["light", "switch_panel"].includes(device.type));
  else if (referential) devices = devices.filter((device) => focusIds.has(device.id));
  else if (typeSets.length) devices = devices.filter((device) => typeSets.some((types) => types.has(device.type)));
  else devices = [];

  if (!roomIds.length && !named.length && !referential && focusRooms.length === 1) {
    devices = devices.filter((device) => device.roomId === focusRooms[0]);
  }
  if (!roomIds.length && !named.length && !referential && new Set(devices.map((device) => device.roomId)).size > 1) {
    block = "你想操作哪个房间的设备？";
  }
  if (!devices.length) block ??= "没有找到明确且已适配的设备。请说明房间和设备名称。";
  const ask = { id: "clarify", label: "询问用户目标或要求，暂不操作设备", intentType: "unknown", actions: [], summary: block ?? "你希望操作哪个设备、如何调整？", clarify: true };
  const noop = { id: "no_action", label: "不操作设备（取消、禁止或无需操作）", intentType: "unknown", actions: [], summary: "没有操作设备。" };
  const candidates = [];
  const variables = [];
  const readOnly = /怎么|如何|能否|支持|有哪些|能做什么/.test(input);
  const forbiddenIds = new Set();
  // A negative instruction is a write boundary, not an instruction to invert the state.
  for (const clause of input.split(/[，,。；;]|但是|但|不过/).filter((text) => /不要|别|不许|不用|先不|暂时不/.test(text))) {
    const clauseRooms = findExplicitRoomIds(clause, home);
    const clauseNamed = devices.filter((device) => [device.name, ...(device.aliases ?? [])].some((name) => name.length >= 2 && clause.includes(name)));
    const clauseTypes = TYPES.filter(([pattern]) => pattern.test(clause)).map(([, types]) => types);
    const forbidden = clauseNamed.length ? clauseNamed : devices.filter((device) => (!clauseRooms.length || clauseRooms.includes(device.roomId)) && (!clauseTypes.length || clauseTypes.some((types) => types.has(device.type))));
    for (const device of forbidden) forbiddenIds.add(device.id);
  }
  if ([...input.matchAll(/(-?\d+(?:\.\d+)?)\s*(度|℃|%|％|百分比)/g)].length > 1) block = "这条指令包含多个设置值，请逐个设备说明，避免把数值对应错。";
  if (!block) {
    for (const device of devices) {
      const controls = device.capabilities.filter((capability) => capability.access === "execute" && capability.operation !== "press");
      const unitMatch = input.match(/(-?\d+(?:\.\d+)?)\s*(度|℃|%|％|百分比)/);
      const numeric = unitMatch ? Number(unitMatch[1]) : null;
      const numericCapability = controls.find((capability) => capability.valueType !== "boolean"
        && (unitMatch?.[2] === "度" || unitMatch?.[2] === "℃" ? capability.domain === "climate" : capability.domain !== "climate"));
      if (numericCapability && numeric !== null) {
        const original = resolveControlAsset(home, device.id)?.capability
          ?? home.things.find((thing) => thing.id === device.id)?.capabilities.find((capability) => capability.id === numericCapability.id);
        const bounds = original?.evidence?.constraints ?? {};
        const min = bounds.min ?? bounds.minValue ?? (numericCapability.domain === "climate" ? original?.binding?.min_temp : 0);
        const max = bounds.max ?? bounds.maxValue ?? (numericCapability.domain === "climate" ? original?.binding?.max_temp : 100);
        const step = bounds.step;
        const offStep = Number.isFinite(step) && step > 0 && Math.abs((numeric - min) / step - Math.round((numeric - min) / step)) > 1e-6;
        if (!Number.isFinite(min) || !Number.isFinite(max) || numeric < min || numeric > max || offStep) {
          block = `${device.name}的设置值超出已知能力范围，或者设备未提供范围。请确认数值。`;
          break;
        }
        variables.push({ device, capability: numericCapability, values: [numeric] });
      } else if (numeric !== null && controls.length && !readOnly) {
        block = `${device.name}没有已确认的对应数值调节能力，我先不操作。`;
        break;
      } else {
        const boolean = controls.find((capability) => ["on_off", "temperature_or_on_off", "position_or_open_close"].includes(capability.operation)
          && (capability.valueType !== "number" || capability.valueType === "boolean_or_number"));
        if (boolean) variables.push({ device, capability: boolean, values: [true, false] });
      }
    }
    const groups = [];
    for (const variable of variables) {
      const groupKey = (genericLightRooms.includes(variable.device.roomId) || !named.length) && ["light", "switch_panel"].includes(variable.device.type) && variable.values.length === 2
        ? `${variable.device.roomId}:lights` : variable.device.id;
      const group = groups.find((item) => item.key === groupKey);
      if (group) group.variables.push(variable);
      else groups.push({ key: groupKey, values: variable.values, variables: [variable] });
    }
    if (groups.length > 3) {
      block = "这条指令涉及较多独立设备，请分成两条说明，避免遗漏或误操作。";
    } else if (groups.length) {
      let combinations = [[]];
      for (const group of groups) combinations = combinations.flatMap((items) => group.values.map((value) => [...items, ...group.variables.map((variable) => actionFor(variable, value))]));
      for (const actions of combinations) candidates.push(actionCandidate(actions, devices));
      if (groups.length === 2) {
        for (const group of groups) for (const value of group.values) candidates.push(actionCandidate(group.variables.map((variable) => actionFor(variable, value)), devices));
      }
    }
    for (const device of devices.slice(0, 3)) candidates.push({
      id: `state:${device.id}`, label: `查询${device.name}的当前状态，不控制设备`,
      intentType: "state_query", query: { mode: "state", device_id: device.id }, actions: [], summary: `读取${device.name}的状态。`,
    });
    candidates.push({ id: "capabilities", label: readOnly
      ? `回答“${input}”，说明${devices.map((device) => device.name).join("、")}已知控制能力，不实际操作`
      : `说明${devices.map((device) => device.name).join("、")}如何控制、支持哪些能力，不执行`, intentType: "inventory_query", actions: [], summary: "查询设备能力。" });
    candidates.push({ id: "preference", label: "用户在描述偏好或建议，以后再处理，本次不操作", intentType: "unknown", actions: [], summary: "这条偏好暂未自动保存，没有操作设备。" });
  }
  const permitted = candidates.filter((candidate) => (!readOnly || candidate.actions.length === 0) && candidate.actions.every((action) => !forbiddenIds.has(action.device_id)));
  if (block || permitted.length > 14) {
    ask.summary = block ?? "可选方案较多，请更具体地说明目标和操作。";
    return { candidates: [ask, noop], devices, block: ask.summary };
  }
  if (readOnly && forbiddenIds.size === 0) {
    return { candidates: [permitted.find((candidate) => candidate.id === "capabilities"), ask], devices, block: null, readOnly, forbiddenIds: [] };
  }
  return { candidates: [...permitted, ask, noop], devices, block: null, readOnly, forbiddenIds: [...forbiddenIds] };
}

export async function decideWithD1({ input, home, conversation, client }) {
  const pack = buildD1Candidates({ input, home, conversation });
  const focusNames = (conversation?.focusedTargets ?? []).map((target) => target.name).join("、");
  const state = `当前用户指令：${input}\n${focusNames ? `上一轮目标：${focusNames}\n` : ""}`
    + pack.devices.map((device) => `${device.name}：${device.capabilities.map((capability) => `${capability.name}=${JSON.stringify(capability.state ?? "未知")}`).join("，")}`).join("\n");
  const result = await client.choose({ state, candidates: pack.candidates, purposeCandidates: PURPOSES });
  const uncertain = result.probability < 0.65 || result.margin < 0.2;
  let selected = pack.block || uncertain ? pack.candidates.find((candidate) => candidate.id === "clarify") : result.candidate;
  const purpose = result.purpose;
  const purposeCertain = purpose && purpose.probability >= 0.65 && purpose.margin >= 0.2;
  if (!pack.block && purposeCertain && ["state", "capabilities"].includes(purpose.choice)) {
    const query = pack.candidates.find((candidate) => purpose.choice === "state" ? candidate.id.startsWith("state:") : candidate.id === "capabilities");
    if (purpose.choice === "capabilities" || pack.devices.length === 1) selected = query ?? pack.candidates.find((candidate) => candidate.id === "clarify");
  }
  if (selected.actions.length && purpose && (!purposeCertain || purpose.choice !== "control")) {
    selected = pack.candidates.find((candidate) => candidate.id === (purposeCertain && purpose.choice === "no_write" ? "no_action" : "clarify"));
  }
  const summary = selected.clarify && uncertain && !pack.block ? "我还不能确定你的意思，请说清楚房间、设备和操作。" : selected.summary;
  return {
    intent: input,
    intent_type: selected.intentType,
    confidence: result.probability,
    summary,
    actions: selected.actions,
    query: selected.query,
    intent_frame: {
      intent_type: selected.intentType, intent: input, confidence: result.probability,
      decision: { mode: selected.clarify ? "ask_clarification" : selected.actions.length ? "execute" : selected.query || selected.intentType === "inventory_query" ? "answer" : "no_action", reason: summary },
      ambiguity: { needs_clarification: Boolean(selected.clarify) },
    },
    d1: { ...result, candidate: undefined, selectedId: selected.id, candidateCount: pack.candidates.length, candidates: pack.candidates.map(({ id, label }) => ({ id, label })), scopeBlock: pack.block, readOnly: Boolean(pack.readOnly), forbiddenIds: pack.forbiddenIds ?? [], uncertain },
  };
}

function actionFor({ device, capability }, value) {
  return { device_id: device.id, capability: capability.id, value, reason: `${device.name} ${value}` };
}

function actionCandidate(actions, devices) {
  let label = actions.map((action) => {
    const name = devices.find((device) => device.id === action.device_id)?.name;
    return action.value === true ? `打开${name}` : action.value === false ? `关闭${name}` : `设置${name}为${action.value}`;
  }).join("，");
  const untouched = devices.filter((device) => !actions.some((action) => action.device_id === device.id));
  if (untouched.length) label += `，${untouched.map((device) => device.name).join("、")}保持不变`;
  return { id: `actions:${JSON.stringify(actions.map(({ device_id, capability, value }) => [device_id, capability, value]))}`, label, intentType: actions.length > 1 ? "scene" : "device_control", actions, summary: label };
}
