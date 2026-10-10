import { compileDeviceOperation, deviceOperations } from "./deviceOperations.js";

export function compileDeviceDecision({ input, home, selected, task, classification, pack, lightPower }) {
  const asks = text => ({ mode: "ask_clarification", summary: text, actions: [] });
  if (selected.some(d => home.things.find(t => t.id === d.id)?.online === false)) return asks("目标设备离线，我先不操作。请检查设备连接后再试。");
  const numeric = [...input.matchAll(/(-?\d+(?:\.\d+)?)\s*(度|℃|%|％|百分比)/g)];
  if (["set_value", "device_action", "warmer", "cooler"].includes(task) && selected.length !== 1) return asks(["warmer", "cooler"].includes(task) ? "要调整空调温度，还是风扇？请指定一台设备。" : "请指定一个设备和具体操作，避免对应错。");
  if (classification.answers.extent?.choice === "one" && selected.length > 1) return asks("请指定要操作哪一个设备，我先不扩大执行范围。");
  const actions = [], descriptions = [];
  let needsConfirmation = false;
  for (const [index, device] of selected.entries()) {
    if (device.type === "light") {
      const cap = lightPower?.(device);
      const answer = classification.operations?.[`d${index}`];
      const direction = task === "mixed_control" ? answer?.probability >= 0.65 && answer.margin >= 0.2 ? answer.choice : null : task === "power_on" ? "on" : task === "power_off" ? "off" : null;
      if (!cap || !["on", "off"].includes(direction)) return asks("请明确每个设备要打开还是关闭，并确认它有对应接口。");
      actions.push({ device_id: device.id, capability: cap.id, value: direction === "on", reason: device.name });
      descriptions.push(`${direction === "on" ? "打开" : "关闭"}${device.name}`);
      continue;
    }
    const options = deviceOperations(device, home);
    if (!options.length) return asks(`${device.name}${["power_on", "power_off"].includes(task) ? "整体开关能力不明确" : "没有已接入的对应动作"}；不能用配置项或附属开关替代。`);
    const stopRequested = task === "device_action" && ["tv", "media_player"].includes(device.type) && /停止|停掉|停下/.test(input) && /音乐|播放/.test(input);
    const pause = options.find(o => o.operation === "media_pause");
    if (stopRequested && !options.some(o => o.operation === "media_stop") && pause) {
      const compiled = compileDeviceOperation({ device, home, operationId: pause.id });
      return { ...asks(`${device.name}没有停止播放接口，但可以暂停。要暂停吗？`), proposal: { label: `暂停${device.name}播放`, actions: [compiled.action], scope: pack.scope } };
    }
    let operation, argument;
    if (["power_on", "power_off"].includes(task)) {
      const matches = options.filter(o => o.operation === task);
      if (matches.length === 1) operation = matches[0];
    } else if (task === "mixed_control") {
      const answer = classification.operations?.[`d${index}`];
      if (!(answer?.probability >= 0.65 && answer.margin >= 0.2 && ["on", "off"].includes(answer.choice))) return asks("请明确每个设备是打开还是关闭。");
      const matches = options.filter(o => o.operation === (answer.choice === "on" ? "power_on" : "power_off"));
      if (matches.length === 1) operation = matches[0];
    } else if (["warmer", "cooler"].includes(task)) {
      operation = options.find(o => o.operation === "set_temperature");
      const cap = home.things.find(t => t.id === device.id)?.capabilities.find(c => c.id === operation?.capabilityId);
      const current = cap?.binding.temperature ?? (typeof cap?.state === "number" ? cap.state : undefined);
      if (!Number.isFinite(current) || cap?.state === false || cap?.binding.currentState === "off") return asks(`${device.name}没有已确认的运行温度，或当前关闭。请明确要设置的温度。`);
      argument = current + (task === "warmer" ? 1 : -1);
    } else {
      const answer = classification.deviceOperation;
      if (!(answer?.probability >= 0.65 && answer.margin >= 0.2)) return asks("这项操作还不明确，我先不操作。请说明要开关、调节还是触发什么动作。");
      const choice = pack.deviceOperationChoices?.[answer.choice];
      operation = options.find(o => o.id === choice?.id);
      if (["set_temperature", "set_position", "set_speed", "set_volume"].includes(operation?.operation)) {
        if (operation.operation === "set_temperature" && /打开|开启|开机/.test(pack.positive ?? input)) return asks("这条同时要求空调开机和设置温度，请分别发送，避免只完成一部分。");
        if (numeric.length !== 1) return asks("请给出一个明确数值和单位，例如 26 度或 50%。");
        if ((operation.operation === "set_temperature") !== /度|℃/.test(numeric[0][2])) return asks("数值单位与设备操作不匹配，我先不操作。");
        argument = Number(numeric[0][1]);
      } else if (numeric.length) return asks("这项动作不支持这个数值参数，我先不操作。");
    }
    if (stopRequested && operation?.operation !== "media_stop") {
      return asks(`${device.name}这次没有明确对应到停止播放，我先不操作。`);
    }
    if (!operation) return asks(`${device.name}${["power_on", "power_off"].includes(task) ? "整体开关能力不明确" : "没有已接入的这项动作"}。我不会改动指示灯、提示音或配置项来代替。`);
    if (operation.operation === "feed") {
      const quantities = [...input.matchAll(/(-?\d+(?:\.\d+)?|[零一二三四五六七八九十百两半]+)\s*(次|份|克|[gG])/g)];
      if (quantities.some(m => m[2] !== "次" || !["1", "一"].includes(m[1])) || /多喂|少喂|加量|加倍|双倍|一半|\d/.test(input.replace(/1\s*次/g, "一次"))) return asks("当前只支持按设备已配置的出粮量投喂一次；自定义份数或克数尚无可靠接口。");
    }
    const compiled = compileDeviceOperation({ device, home, operationId: operation.id, argument });
    if (compiled.error) return asks(`${device.name}：${compiled.error}`);
    actions.push(compiled.action);
    descriptions.push(`${device.name}：${operation.label.split(/[，/]/)[0]}${argument !== undefined ? ` ${argument}${operation.operation === "set_temperature" ? "度" : "%"}` : ""}`);
    needsConfirmation ||= operation.access === "confirm";
  }
  const description = descriptions.join("；");
  if (needsConfirmation) return { ...asks(`将${description}。这是一次设备动作，确认执行吗？`), proposal: { label: description, actions, scope: pack.scope } };
  return { mode: "execute", summary: `已模拟执行：${description}。`, actions };
}
