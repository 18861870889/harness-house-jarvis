import { compileHcmForPlanner } from "./hcmPlanner.js";
import { findExplicitRoomIds, resolveControlAsset } from "./hcmControlGraph.js";

export const D1_SEMANTIC_CONTRACT_VERSION = "3.0";
const TASKS = {
  power_on: "现在要求打开设备或打开灯、窗帘",
  power_off: "现在要求关闭设备或关灯、关闭窗帘",
  mixed_control: "现在明确要求一些设备打开、另一些设备关闭",
  set_value: "现在设置一个明确数值，如温度、亮度、风速或位置",
  brighter: "觉得太暗、不够亮，要求增加照明",
  dimmer: "觉得太亮、刺眼，要求减少照明",
  warmer: "觉得冷或太凉，希望环境暖一些",
  cooler: "觉得热或闷，希望环境凉一些",
  state_query: "只查询设备、传感器当前状态或开关情况，不改变设备",
  capability_query: "咨询怎么控制、支持什么功能或操作方法，不要求执行",
  location_query: "询问自己在哪个房间或是否在某个房间，不控制设备",
  feedback: "评价刚才操作的效果，如不合适、好多了、关闭得太多、满意了",
  confirm: "仅明确同意执行上一轮待确认方案，没有添加新要求",
  no_action: "取消、拒绝、禁止操作、未来偏好或闲聊，本轮不执行",
  media_stop: "要求停止或暂停播放音乐，不是切断设备电源",
  unclear: "无法确定当前要求，需要具体反问",
};
const EXTENTS = {
  one: "新打开或关闭一个设备，其余保持不变；没有要求只保留一个",
  only_one: "最终只留一个所要求的灯开启，房间其他灯关闭",
  all: "明确要求全部或所有匹配设备，包括多个房间的灯都关闭",
  matching: "指定了设备名称或灯具类别，只操作匹配设备",
  default: "未指定数量或具体设备，使用最小改动的房间默认操作",
  unclear: "数量要求无法确定，需要反问，不执行",
};
const question = (instructions, criteria) => ({ type: "choice", instructions, criteria });
const certain = answer => answer?.probability >= 0.65 && answer.margin >= 0.2;
const controls = device => device.capabilities.filter(c => c.access === "execute" && c.operation !== "press");
const powerOf = device => {
  const eligible = controls(device).filter(c => ["on_off", "temperature_or_on_off", "position_or_open_close"].includes(c.operation) && ["boolean", "boolean_or_number"].includes(c.valueType));
  const primary = eligible.filter(c => c.id === "power" || /电源/.test(c.name) || c.name.replace(device.name, "") === "开关");
  return primary.length === 1 ? primary[0] : eligible.length === 1 ? eligible[0] : undefined;
};
const actionFor = (device, capability, value) => ({ device_id: device.id, capability: capability.id, value, reason: device.name });
const localName = (device, home) => device.name.replace(home.spaces.find(r => r.id === device.roomId)?.name ?? "", "");
const WRITE_TASKS = new Set(["power_on", "power_off", "mixed_control", "set_value", "brighter", "dimmer", "warmer", "cooler", "media_stop", "confirm"]);
const NEGATIVE = /不要|不想|不需要|别|不许|不用|先不|暂时不|(?:不|勿)(?:开|关|动|操作)/;
const OPEN = /打开|开启|开(?=下|一下|一盏|一个|灯|射灯|吊灯|窗帘|电视|空调|风扇)/;
const CLOSE = /关闭|关掉|关(?=下|一下|一盏|一个|灯|射灯|吊灯|窗帘|电视|空调|风扇)/;
const GENERIC_LIGHT = /(?:^|开|关|开下|关下|开一下|关一下|打开|关闭|关掉|(?:一|1)(?:个|盏)|所有|全部|房间|屋里|室内)(?:灯|照明)(?=$|\s|都|全|开|关|现在|目前|怎么|如何|支持|吧|了|一下|下|[?!？，,。])/u;

function catalogueMatches(text, devices, home) {
  const named = devices.filter(d => [d.name, localName(d, home), ...(d.aliases ?? [])].some(name => name.length >= 2 && text.includes(name)));
  const suffixes = devices.filter(d => d.type === "light").flatMap(d => [2, 3, 4].map(n => localName(d, home).slice(-n)))
    .filter(name => name.length >= 2 && name.endsWith("灯") && text.includes(name));
  const genericRooms = home.spaces.filter(r => ["灯", "的灯", "所有灯", "的所有灯", "全部灯", "的全部灯"].some(noun => text.includes(`${r.name}${noun}`))).map(r => r.id);
  return devices.filter(d => named.includes(d) || genericRooms.includes(d.roomId) && d.type === "light"
    || !named.length && suffixes.some(name => localName(d, home).endsWith(name)));
}

function targetSets(devices, home) {
  const sets = devices.map(d => ({ ids: [d.id], label: `具体指定${d.name}，或简称${localName(d, home)}` }));
  for (const type of new Set(devices.map(d => d.type))) {
    const group = devices.filter(d => d.type === type);
    if (group.length > 1) sets.unshift({ ids: group.map(d => d.id), label: `本轮所述${type === "light" ? "灯具" : "设备"}候选集合：${group.map(d => d.name).join("、")}；没有指定其中具体哪一台` });
  }
  const lights = devices.filter(d => d.type === "light");
  const suffixes = new Set(lights.flatMap(d => [2, 3, 4].map(n => localName(d, home).slice(-n))));
  for (const suffix of suffixes) {
    const group = lights.filter(d => localName(d, home).endsWith(suffix));
    if (suffix.length >= 2 && suffix.endsWith("灯") && group.length > 1 && group.length < lights.length) sets.unshift({ ids: group.map(d => d.id), label: `指定${suffix}这一类灯，仅包含${group.map(d => d.name).join("、")}，不包含其他类别的灯` });
  }
  return sets.filter((s, i) => sets.findIndex(other => JSON.stringify([...other.ids].sort()) === JSON.stringify([...s.ids].sort())) === i);
}

export function buildD1SemanticRequest({ input, home, conversation = {} }) {
  const explicit = findExplicitRoomIds(input, home);
  const referential = /它|(?:这个|那个)(?!房间|屋)|那盏|这盏|刚才那|刚刚那/.test(input);
  const catalog = compileHcmForPlanner(home, { limit: 10000 });
  const focusIds = new Set((conversation.focusedTargets ?? []).map(t => t.id));
  const location = conversation.currentRoom;
  const rooms = explicit.length ? explicit : referential && focusIds.size
    ? [...new Set(catalog.filter(d => focusIds.has(d.id)).map(d => d.roomId))]
    : location?.source === "configured_terminal" ? [location.id]
      : !conversation.uncertainOrigin ? (conversation.focusedRooms ?? []).map(r => r.id) : [];
  const named = catalog.filter(d => [d.name, ...(d.aliases ?? [])].some(name => name.length >= 2 && input.includes(name)
    && (home.spaces.some(r => name.includes(r.name)) || catalog.filter(other => [other.name, ...(other.aliases ?? [])].includes(name)).length === 1)));
  let devices = catalog.filter(d => rooms.includes(d.roomId) || named.includes(d));
  if (referential && focusIds.size) devices = catalog.filter(d => focusIds.has(d.id) && (!explicit.length || explicit.includes(d.roomId)));
  const bedrooms = home.spaces.filter(r => /主卧|次卧|儿童房|卧室/.test(r.name) && !/卫生间/.test(r.name));
  const namedBedroom = bedrooms.some(r => [r.name, ...(r.aliases ?? [])].filter(n => !/^(卧室|睡房)$/.test(n)).some(n => input.includes(n)));
  const bedroomOptions = bedrooms.filter(r => !/^(卧室|睡房)$/.test(r.name));
  const block = referential && (!focusIds.size || !devices.length) ? "你指的是哪一个设备？目前没有可明确指代的目标。"
    : /卧室|睡房/.test(input) && !namedBedroom && bedrooms.length > 1
    ? `你指的是${bedroomOptions.map(r => r.name).join("还是")}？`
    : devices.length > 24 ? "涉及的设备较多，请分房间说明，我先不操作。" : null;
  if (devices.length > 24) devices = [];
  const scope = { source: explicit.length ? "explicit_room" : referential ? "conversation_target" : location ? "terminal" : rooms.length ? "conversation_room" : "ambiguous_origin", roomIds: rooms, targetIds: devices.map(d => d.id) };
  const goal = conversation.activeGoalTask && rooms.includes(conversation.activeGoalTask.roomId) ? conversation.activeGoalTask : null;
  const confirmationOnly = /^(可以|好|好的|确认|执行|执行吧|继续|继续吧|没问题|同意|是的|关吧|打开吧)[。！!]?$/u.test(input.trim());
  const pending = conversation.pendingDecision && conversation.pendingDecision.roomIds.every(id => rooms.includes(id)) ? conversation.pendingDecision : null;
  const clauses = input.split(/[，,。；;]|但是|但|不过|(?=不要|不想|不需要|别|不许|不用|先不|暂时不|(?:不|勿)(?:开|关|动|操作))/).filter(c => c.trim());
  const positive = clauses.filter(c => !NEGATIVE.test(c)).join("；");
  const denied = clauses.filter(c => NEGATIVE.test(c));
  const excludedIds = new Set(denied.flatMap(clause => {
    const matches = catalogueMatches(clause, devices, home);
    return matches.map(d => d.id);
  }));
  // Literal action words constrain the schema, not a locally executed intent.
  const allowedTasks = { ...TASKS };
  const retainOne = /(?:只|仅)(?:留|保留)(?:一|1)(?:个|盏)/.test(positive);
  const literalDirection = retainOne ? null : OPEN.test(positive) && !CLOSE.test(positive) ? "on" : CLOSE.test(positive) && !OPEN.test(positive) ? "off" : null;
  if (literalDirection === "on") for (const id of WRITE_TASKS) if (id !== "power_on" && !(id === "set_value" && /\d+\s*(度|℃|%|％)/.test(positive))) delete allowedTasks[id];
  if (literalDirection === "off") for (const id of WRITE_TASKS) if (id !== "power_off") delete allowedTasks[id];
  const methodQuestion = /怎么|如何|支持|有哪些功能|能做什么/.test(input);
  const stateQuestion = /(?:打开|关闭|开启|关掉)了(?:吗|没有)|(?:打开|关闭|开启)没有|(?:开着|关着)(?:吗|么)|调到.*了(?:吗|没有)/.test(input);
  const feedbackOnly = /^(?:刚才|刚刚)?(?:不合适|不满意|好多了|合适了|满意了|(?:开|关)(?:闭)?(?:的|得|了)太(?:多|少)了?)[。！!]?$/u.test(input.trim());
  if (methodQuestion || stateQuestion || feedbackOnly || denied.length && !positive.trim()) for (const id of WRITE_TASKS) delete allowedTasks[id];
  if (!confirmationOnly) delete allowedTasks.confirm;
  else { allowedTasks.confirm = TASKS.confirm; for (const id of WRITE_TASKS) if (id !== "confirm") delete allowedTasks[id]; }
  const literalOne = /(?:一|1)(?:个|盏)/.test(positive);
  const literalOnly = retainOne || literalOne && /只|仅/.test(positive) && literalDirection !== "off";
  const extents = literalOne ? { [literalOnly ? "only_one" : "one"]: EXTENTS[literalOnly ? "only_one" : "one"], unclear: EXTENTS.unclear } : EXTENTS;
  const lastActions = feedbackOnly ? (conversation.lastExecutedActions ?? []).filter(a => rooms.includes(a.roomId)).map(a => `${a.value === true ? "打开" : a.value === false ? "关闭" : "调整"}${catalog.find(d => d.id === a.device_id)?.name ?? "设备"}`).join("、") : "";
  const state = `本轮用户原话：${JSON.stringify(input)}\n可信发言房间：${location?.name ?? "未知"}\n`
    + (literalDirection && !methodQuestion && !stateQuestion && !feedbackOnly ? `本轮明确操作词：${literalDirection === "on" ? "打开（开下灯、开一下灯中的下／一下是语气词，不是关闭）" : "关闭"}。这是当前原话的操作方向，不是历史命令。\n` : "")
    + (stateQuestion ? "本轮是在检查当前或已发生的状态，不是重新执行该操作。\n" : "")
    + (feedbackOnly ? "本轮是对刚才结果的评价，没有新的执行要求；需要理解反馈或具体反问，不能继续关闭设备。\n" : "")
    + (lastActions ? `本房间上一条已实际模拟执行的操作：${lastActions}\n` : "")
    + (retainOne ? "本轮要求最终只保留一盏所指定类型的灯开启，不是把这些灯全部关闭。\n" : "")
    + (denied.length && literalDirection ? `当前明确的执行子句：${JSON.stringify(positive)}；否定子句不能取消这个新要求，也不能作为执行目标。\n` : "")
    + (referential ? `上一轮明确目标：${(conversation.focusedTargets ?? []).map(t => t.name).join("、")}\n` : "")
    + (goal ? `本房间未完成的目标：${goal.desiredOutcome}，只供理解反馈，不能替代本轮要求\n` : "")
    + (pending && confirmationOnly ? `本轮仅回复上一轮方案。待确认方案：${pending.label.slice(0, 250)}\n` : "");
  const questions = {
    task: question("只判断本轮原话的意图。旧目标和待确认方案不是本轮命令；新要求不是确认；询问位置不是控制房间；评价操作效果不是重复执行。", allowedTasks),
    extent: question("本轮原话要求的设备数量和范围是什么？一个与只留一个不同；设备类别如射灯不包含吊灯。没有明确数量或类别选default。", extents),
    feedback: question("本轮对刚才结果的评价是什么？没有评价选none。", { satisfied: "明确满意或合适，保持现状", improved: "改善了但未说已合适", dissatisfied: "不合适或操作太多，需要纠正", none: "不是效果反馈" }),
    target_form: question("本轮使用什么目标名称？例如灯是泛称；射灯、吊灯、床头灯都是具体名称或子类，即使目录中没有这个设备也不能扩大为所有灯。", { generic: "泛称灯、照明、空调等设备类型，没有指定具体名称或子类", named: "使用具体设备名称或子类，如射灯、吊灯、落地灯、床头灯", referential: "明确指代上一个目标，如它、刚才那盏", unclear: "本轮没有设备目标或目标表述无法判断" }),
  };
  const unsupportedCount = [...positive.matchAll(/(?:两|[一二三四五六七八九十百零]+|\d+)\s*(?:个|盏)/g)].some(m => !/^(一|1)(个|盏)$/.test(m[0].replace(/\s/g, "")));
  return { state, questions, devices, catalog, scope, block, pending, excludedIds: [...excludedIds], positive, literalOne, literalOnly, literalDirection, referential, feedbackOnly, unsupportedCount };
}

function groundTargets(pack, home, task, answers) {
  let devices = pack.devices.filter(d => !pack.excludedIds.includes(d.id));
  const domain = ["brighter", "dimmer"].includes(task) ? ["light"] : ["warmer", "cooler"].includes(task) ? ["ac", "fan"] : null;
  if (domain) devices = devices.filter(d => domain.includes(d.type));
  const nouns = { light: /灯|照明/, ac: /空调/, fan: /风扇/, curtain: /窗帘/, tv: /电视/, vacuum: /扫地|机器人/ };
  const types = Object.entries(nouns).filter(([, pattern]) => pattern.test(pack.positive)).map(([type]) => type);
  pack.requestedTypes = types;
  if (types.length) devices = devices.filter(d => types.includes(d.type));
  pack.retrievedIds = devices.map(d => d.id);
  const matches = catalogueMatches(pack.positive, devices, home);
  const bind = (targets, source) => ({ ids: targets.map(d => d.id), source });
  if (matches.length) return { devices, binding: bind(matches, "catalogue_literal") };
  if (pack.referential && devices.length) return { devices, binding: bind(devices, "conversation_target") };
  if (domain && devices.length) return { devices, binding: bind(devices, "semantic_domain") };
  if (types.length && devices.length && (types.length === 1 && types[0] === "light" && GENERIC_LIGHT.test(pack.positive) || certain(answers.target_form) && answers.target_form.choice === "generic")) return { devices, binding: bind(devices, "room_device_class") };
  return { devices };
}

function originalCapability(home, device, capability) {
  if (!capability) return null;
  return resolveControlAsset(home, device.id)?.capability ?? home.things.find(t => t.id === device.id)?.capabilities.find(c => c.id === capability.id);
}

function numericAction(home, device, capability, value) {
  const original = originalCapability(home, device, capability);
  const bounds = original?.evidence?.constraints ?? {};
  const min = bounds.min ?? bounds.minValue ?? original?.binding?.min ?? original?.binding?.min_temp ?? (capability.domain === "climate" ? undefined : 0);
  const max = bounds.max ?? bounds.maxValue ?? original?.binding?.max ?? original?.binding?.max_temp ?? (capability.domain === "climate" ? undefined : 100);
  const step = bounds.step ?? original?.binding?.step ?? 1;
  if (![min, max, step, value].every(Number.isFinite) || step <= 0 || value < min || value > max || Math.abs((value - min) / step - Math.round((value - min) / step)) > 1e-6) return null;
  return actionFor(device, capability, value);
}

function primary(devices) {
  return [...devices].sort((a, b) => Number(/吊灯|吸顶灯|主灯|主射灯/.test(b.name)) - Number(/吊灯|吸顶灯|主灯|主射灯/.test(a.name)) || a.id.localeCompare(b.id))[0];
}

function capabilitySummary(device, input = "") {
  const capabilities = device.capabilities.filter(c => c.access === "execute");
  if (!capabilities.length) return `${device.name}目前接入的能力只有状态读取。`;
  if (capabilities.every(c => c.operation === "press")) return `${device.name}已接入${capabilities.map(c => c.name.replace(device.name, "")).join("、")}，但当前沙盒还不能执行这类动作。`;
  if (/调光|亮度/.test(input) && device.type === "light" && !capabilities.some(c => c.valueType === "number" && /brightness|亮度/i.test(`${c.id} ${c.name}`))) return `${device.name}只能开关，不能调光。`;
  return `${device.name}支持${capabilities.map(c => c.name.replace(device.name, "")).join("、")}。`;
}

export function compileD1SemanticDecision({ input, home, conversation = {}, pack, classification }) {
  const answers = classification.answers;
  const task = answers.task?.choice;
  const extent = answers.extent?.choice;
  if (!Object.hasOwn(TASKS, task) || !Object.hasOwn(EXTENTS, extent) || Object.keys(answers).length !== Object.keys(pack.questions).length) throw new Error("invalid_semantic_decision");
  for (const [id, q] of Object.entries(pack.questions)) {
    const a = answers[id];
    if (!a || !Object.hasOwn(q.criteria, a.choice) || ![a.probability, a.margin].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) throw new Error("invalid_semantic_decision");
  }
  const target = classification.target;
  if (target && (!pack.targetChoices?.[target.choice] || ![target.probability, target.margin].every(n => Number.isFinite(n) && n >= 0 && n <= 1))) throw new Error("invalid_semantic_target");
  if (pack.targetBinding && (pack.targetBinding.ids.some(id => !pack.devices.some(d => d.id === id)) || !["catalogue_literal", "conversation_target", "semantic_domain", "room_device_class"].includes(pack.targetBinding.source))) throw new Error("invalid_catalogue_binding");
  const targetIds = pack.targetBinding?.ids ?? (target && certain(target) ? pack.targetChoices[target.choice].ids : []);
  const selected = pack.devices.filter(d => targetIds.includes(d.id));
  const excluded = new Set(pack.excludedIds);
  const frame = { task, extent, targetIds: selected.map(d => d.id), excludedIds: [...excluded], scope: pack.scope, targetSource: pack.targetBinding?.source ?? "d1_choice" };
  let mode = "answer", summary = "", actions = [], proposal, goal, goalFeedback, query;
  const ask = text => { mode = "ask_clarification"; summary = text; actions = []; };
  const hasMethodQuestion = /怎么|如何|支持|有哪些功能|能做什么/.test(input);
  if (hasMethodQuestion && !["capability_query", "state_query", "location_query", "no_action"].includes(task)) ask("你是在询问操作方法吗？我先不操作设备。");
  else if (pack.block && !["location_query", "no_action", "feedback", "confirm"].includes(task)) ask(pack.block);
  else if (!certain(answers.task)) ask(pack.feedbackOnly ? "刚才的调整是太亮、太暗，还是操作范围不对？" : `你希望${selected[0]?.name ?? "设备"}如何调整？我先不操作。`);
  else if (task === "location_query") {
    summary = conversation.currentRoom ? `你现在在${conversation.currentRoom.name}。` : "当前无法确定你在哪个房间，我不会根据提问中的房间名猜测。";
  } else if (task === "no_action") {
    const on = pack.devices.filter(d => excluded.has(d.id) && powerOf(d)?.state === true);
    if (on.length === 1 && powerOf(on[0]) && !/以后|下次|将来/.test(input)) {
      ask(`${on[0].name}现在已经开着。要关闭它吗？`);
      proposal = { label: `关闭${on[0].name}`, actions: [actionFor(on[0], powerOf(on[0]), false)], scope: { ...pack.scope, targetIds: [on[0].id] } };
    } else if (pack.feedbackOnly) ask("刚才的调整是太亮、太暗，还是操作范围不对？");
    else summary = "好，本次不操作设备。";
  } else if (task === "confirm") {
    if (!pack.pending?.actions?.length) ask("当前没有待确认的执行方案，请说明要操作什么。");
    else {
      actions = structuredClone(pack.pending.actions);
      goal = pack.pending.goal;
      summary = "";
      mode = "execute";
    }
  } else if (task === "feedback") {
    if (!certain(answers.feedback)) ask("刚才的调整是太亮、太暗，还是操作范围不对？");
    else if (answers.feedback.choice === "satisfied") { summary = "好，保持现在的状态。"; goalFeedback = "satisfied"; }
    else if (answers.feedback.choice === "improved") { summary = "好，有改善。还需要调整吗？"; goalFeedback = "improved"; }
    else {
      const tooManyOff = /关(?:闭)?(?:的|得)?太多|关多/.test(input);
      const restore = tooManyOff ? (conversation.lastExecutedActions ?? []).filter(a => a.value === false && pack.scope.roomIds.includes(a.roomId))
        .flatMap(a => { const device = pack.catalog.find(d => d.id === a.device_id); const cap = device && powerOf(device); return cap?.state === false && !excluded.has(device.id) ? [actionFor(device, cap, true)] : []; }) : [];
      if (restore.length) {
        const names = restore.map(a => pack.catalog.find(d => d.id === a.device_id).name).join("、");
        ask(`刚才关掉了${names}。要重新打开${restore.length === 1 ? "它" : "这几盏"}吗？`);
        proposal = { label: `重新打开${names}`, actions: restore, scope: { ...pack.scope, targetIds: restore.map(a => a.device_id) } };
      } else ask(tooManyOff ? "你希望重新打开哪些灯？" : conversation.activeGoalTask ? "现在是太亮还是太暗？" : "刚才操作的范围不合适吗？你希望保留哪些设备？");
    }
  } else if (pack.block) ask(pack.block);
  else if (pack.unsupportedCount && WRITE_TASKS.has(task)) ask("请具体指定要调整的设备；这次数量要求还不能可靠对应，我先不操作。");
  else if (!selected.length) {
    const typeNames = { light: "灯具", ac: "空调", fan: "风扇", curtain: "窗帘", tv: "电视", vacuum: "扫地机器人" };
    if (pack.scope.roomIds.length && pack.requestedTypes?.length && !pack.retrievedIds.length) ask(`${pack.scope.roomIds.map(id => home.spaces.find(r => r.id === id)?.name).join("、")}没有已接入且可识别的${pack.requestedTypes.map(t => typeNames[t]).join("、")}。你指的是其他房间的设备吗？`);
    else ask(pack.scope.roomIds.length ? `你指的是${pack.devices.filter(d => d.type === "light").map(d => d.name).slice(0, 4).join("、") || "哪个设备"}中的哪一个？` : "你想操作哪个房间？当前位置还不确定。");
  }
  else if (["state_query", "capability_query"].includes(task)) {
    if (selected.length === 1) {
      if (task === "state_query") { query = { mode: "state", device_id: selected[0].id }; summary = `读取${selected[0].name}的状态。`; }
      else summary = capabilitySummary(selected[0], input);
    } else summary = selected.map(d => task === "state_query" ? `${d.name}：${powerOf(d)?.state === true ? "开启" : powerOf(d)?.state === false ? "关闭" : "状态未知"}` : capabilitySummary(d, input)).join("；") + "。";
  } else if (extent === "only_one" && ["power_on", "power_off", "mixed_control", "brighter", "dimmer"].includes(task)) {
    const writable = selected.filter(d => powerOf(d) && !excluded.has(d.id));
    if (!certain(answers.extent)) ask("你是希望最终只留一盏灯吗？我先不操作。");
    else if (writable.length !== selected.length || writable.some(d => d.type !== "light") || new Set(writable.map(d => d.roomId)).size !== 1) ask("只保留一盏灯需要明确一个房间的可控灯具，我先不操作。");
    else {
      const chosen = primary(writable);
      const otherLights = pack.catalog.filter(d => d.type === "light" && d.roomId === chosen.roomId && d.id !== chosen.id);
      const unrepresented = (home.controlGraph?.assets ?? []).some(a => a.type === "light" && a.spaceId === chosen.roomId && !pack.catalog.some(d => d.id === a.id))
        || home.things.some(t => t.type === "light" && t.spaceId === chosen.roomId && !pack.catalog.some(d => d.id === t.id));
      if (unrepresented || writable.some(d => typeof powerOf(d)?.state !== "boolean") || otherLights.some(d => typeof powerOf(d)?.state !== "boolean" || excluded.has(d.id) && powerOf(d).state !== false)) ask("有其他灯的状态或控制权限不明确，暂时不能保证只保留一盏。请确认这些灯是否可以关闭。");
      else { actions = [actionFor(chosen, powerOf(chosen), true), ...otherLights.filter(d => !excluded.has(d.id)).map(d => actionFor(d, powerOf(d), false))]; mode = "execute"; summary = `现在只保留${chosen.name}，其余灯已关闭。`; }
    }
  } else if (["warmer", "cooler"].includes(task)) {
    const ac = selected.find(d => d.type === "ac");
    const cap = ac && powerOf(ac);
    const raw = ac && originalCapability(home, ac, cap);
    const current = raw?.binding?.temperature ?? (typeof cap?.state === "number" ? cap.state : undefined);
    if (!ac || cap?.state === false || !Number.isFinite(current)) ask(`${ac?.name ?? "当前房间空调"}${cap?.state === false ? "当前关闭" : "没有已确认的运行温度"}。暂时没有可直接执行的${task === "warmer" ? "升温" : "降温"}方案；你想调整哪台设备？`);
    else {
      const action = numericAction(home, ac, cap, current + (task === "warmer" ? 1 : -1));
      if (!action) ask(`${ac.name}没有已确认的对应温度调节范围，我先不操作。`);
      else { actions = [action]; mode = "execute"; }
    }
  } else if (["brighter", "dimmer"].includes(task)) {
    const lights = selected.filter(d => d.type === "light");
    const direction = task === "brighter" ? 1 : -1;
    const adjustable = lights.flatMap(device => {
      const power = powerOf(device);
      const brightness = controls(device).find(c => c.domain === "light" && c.valueType === "number" && /brightness|亮度/i.test(`${c.id} ${c.name}`));
      if (power?.state === true && brightness && Number.isFinite(brightness.state)) {
        const action = numericAction(home, device, brightness, brightness.state + direction * 20);
        return action ? [{ device, action }] : [];
      }
      if (power?.state === (task === "brighter" ? false : true)) return [{ device, action: actionFor(device, power, task === "brighter") }];
      return [];
    });
    if (!adjustable.length) ask(`目前没有已确认的进一步${task === "brighter" ? "调亮" : "调暗"}方案，我先不操作。`);
    else {
      const device = primary(adjustable.map(a => a.device));
      actions = [adjustable.find(a => a.device.id === device.id).action]; mode = "execute";
      goal = { domain: "lighting", desired_outcome: task, space_refs: [device.roomId], evidence: "device_state_only" };
    }
  } else if (["power_on", "power_off"].includes(task)) {
    if (pack.literalOne && !certain(answers.extent) || extent === "unclear") ask("你希望新开一盏灯，还是最终只留一盏灯？");
    else {
      const writable = selected.filter(d => powerOf(d) && !excluded.has(d.id));
      if (writable.length !== selected.length) ask("有设备的整体开关能力不明确，或只有只读/未适配能力。我先不操作，请说明具体设备和操作。");
      else {
        const value = task === "power_on";
        let targets = writable;
        if (extent === "one") targets = [primary(writable.filter(d => powerOf(d).state !== value)) ?? primary(writable)];
        else if (value && (!certain(answers.extent) || extent === "default") && writable.every(d => d.type === "light")) targets = [primary(writable)];
        actions = targets.map(d => actionFor(d, powerOf(d), value));
        if (mode !== "ask_clarification") mode = "execute";
      }
    }
  } else if (task === "mixed_control") {
    const operations = classification.operations;
    if (operations && (Object.keys(operations).length !== selected.length || selected.some((_, i) => ![operations[`d${i}`]?.probability, operations[`d${i}`]?.margin].every(n => Number.isFinite(n) && n >= 0 && n <= 1)))) throw new Error("invalid_semantic_operations");
    if (!operations || selected.some((d, i) => !certain(operations[`d${i}`]) || !["on", "off"].includes(operations[`d${i}`].choice) || !powerOf(d))) ask("请明确每个设备要打开还是关闭。");
    else { actions = selected.map((d, i) => actionFor(d, powerOf(d), operations[`d${i}`].choice === "on")); mode = "execute"; }
  } else if (task === "set_value") {
    const matches = [...input.matchAll(/(-?\d+(?:\.\d+)?)\s*(度|℃|%|％|百分比)/g)];
    if (selected.length !== 1 || matches.length !== 1) ask("请给一个设备设置一个明确数值，避免对应错。");
    else {
      const device = selected[0];
      const capability = controls(device).find(c => c.valueType !== "boolean" && (/[度℃]/.test(matches[0][2]) ? c.domain === "climate" : c.domain !== "climate"));
      const action = capability && numericAction(home, device, capability, Number(matches[0][1]));
      if (!action) ask(`${device.name}没有已确认的对应数值或范围，我先不操作。`);
      else { actions = [action]; mode = "execute"; }
    }
  } else ask("这条要求还没有完整的可执行方案，请说明具体设备和操作。");

  // Semantic constraints authorize actions; a high model score alone never does.
  if (actions.some(a => excluded.has(a.device_id)) && task !== "confirm") throw new Error("semantic_exclusion_violation");
  if (["power_on", "power_off"].includes(task) && extent !== "only_one" && actions.some(a => a.value !== (task === "power_on"))) throw new Error("semantic_direction_violation");
  if (extent === "one" && actions.length > 1) throw new Error("semantic_quantity_violation");
  if (["state_query", "capability_query", "location_query", "feedback", "no_action", "unclear"].includes(task) && actions.length) throw new Error("semantic_readonly_violation");
  if (mode === "execute") {
    frame.resolvedTargetIds = [...new Set(actions.map(a => a.device_id))];
    actions = actions.filter(a => {
      const device = pack.catalog.find(d => d.id === a.device_id);
      const capability = device?.capabilities.find(c => c.id === a.capability);
      if (!capability || capability.access !== "execute") throw new Error("semantic_capability_violation");
      return capability.state !== a.value;
    });
    if (!actions.length) { mode = "answer"; summary = "已经是你要求的状态，无需重复操作。"; }
    else summary ||= `已${actions.length === 1 ? (actions[0].value === true ? "打开" : actions[0].value === false ? "关闭" : "调整") + pack.catalog.find(d => d.id === actions[0].device_id).name : `调整${actions.length}个设备`}。`;
  }
  const intentType = task === "state_query" && selected.length === 1 ? "state_query" : actions.length ? actions.length > 1 ? "scene" : "device_control" : "unknown";
  return {
    intent: input, intent_type: intentType, confidence: answers.task.probability, summary, actions, query, goal, goalFeedback, proposal,
    semanticFrame: frame,
    intent_frame: { intent_type: intentType, intent: input, confidence: answers.task.probability, goal, actions, query,
      decision: { mode, reason: summary }, ambiguity: { needs_clarification: mode === "ask_clarification" } },
    d1: { contractVersion: D1_SEMANTIC_CONTRACT_VERSION, selectedId: `semantic:${task}`, probability: answers.task.probability, margin: answers.task.margin,
      latencyMs: classification.latencyMs, usage: classification.usage, scope: pack.scope, candidateCount: Object.keys(pack.questions).length,
      candidates: Object.entries(pack.questions.task.criteria).map(([id, label]) => ({ id, label })), fields: answers, target, targetBinding: pack.targetBinding, targetChoices: pack.targetChoices, operations: classification.operations, semanticFrame: frame, scopeBlock: pack.block, uncertain: !certain(answers.task) },
  };
}

export async function decideWithD1V3(options) {
  const pack = buildD1SemanticRequest(options);
  const classification = await options.client.classify({ state: pack.state, questions: pack.questions });
  const task = classification.answers.task?.choice;
  if (certain(classification.answers.task) && !pack.block && !["location_query", "no_action", "confirm", "feedback", "unclear"].includes(task)) {
    // Catalogue retrieval is grounded fact, not fabricated model confidence.
    const { devices, binding } = groundTargets(pack, options.home, task, classification.answers);
    pack.targetBinding = binding;
    const sets = binding ? [] : targetSets(devices, options.home).filter(s => classification.answers.target_form?.choice !== "named" || s.ids.length === 1);
    if (!binding && sets.length && sets.length <= 15) {
      pack.targetChoices = Object.fromEntries(sets.map((set, i) => [`t${i}`, set]));
      pack.targetChoices.unclear = { ids: [], label: "目标设备或类别不明确，需要反问" };
      const targetResult = await options.client.classify({ state: `${pack.state}本轮意图：${TASKS[task]}\n本轮目标所在房间：${pack.scope.roomIds.map(id => options.home.spaces.find(r => r.id === id)?.name ?? id).join("、")}\n`, questions: {
        target: question("选择本轮目标。目录没有用户所说的设备时必须选unclear，不能用另一种灯替代。泛称、指定数量但没指明哪一盏时选集合，执行灯具由最小改动策略选取。射灯不包含吊灯。", Object.fromEntries(Object.entries(pack.targetChoices).map(([id, set]) => [id, set.label]))),
      } });
      classification.target = targetResult.answers.target;
      classification.latencyMs += targetResult.latencyMs;
    }
    if (task === "mixed_control" && (binding || certain(classification.target))) {
        const selected = devices.filter(d => (binding?.ids ?? pack.targetChoices[classification.target.choice].ids).includes(d.id));
        const operations = await options.client.classify({ state: pack.state, questions: Object.fromEntries(selected.map((d, i) => [`d${i}`, question(`本轮要求${d.name}打开还是关闭？`, { on: `打开${d.name}`, off: `关闭${d.name}`, unclear: "没有明确要求，不操作" })])) });
        classification.operations = operations.answers;
        classification.latencyMs += operations.latencyMs;
    }
  }
  return compileD1SemanticDecision({ ...options, pack, classification });
}
