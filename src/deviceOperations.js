import { capabilityAccess } from "./capabilityAuthorization.js";
import { resolveControlAsset } from "./hcmControlGraph.js";

// HA's public supported_features bitfields; never infer optional services from a device name.
export const DEVICE_FEATURES = {
  fan: { set_speed: 1, oscillate: 2, power_off: 16, power_on: 32 },
  cover: { power_on: 1, power_off: 2, set_position: 4, motion_stop: 8 },
  climate: { set_temperature: 1, power_off: 128, power_on: 256 },
  media_player: { media_pause: 1, set_volume: 4, mute_on: 8, mute_off: 8, volume_up: 1024, volume_down: 1024, power_on: 128, power_off: 256, media_stop: 4096, media_play: 16384 },
  vacuum: { vacuum_stop: 8, vacuum_dock: 16, vacuum_start: 8192 },
};
const labels = {
  power_on: "打开电源", power_off: "关闭电源",
  set_temperature: "设置空调目标温度", set_position: "设置窗帘或升降装置的位置百分比", set_speed: "设置风扇风速百分比",
  oscillate_on: "开启风扇摇头", oscillate_off: "关闭风扇摇头",
  media_play: "播放或继续播放音乐", media_pause: "暂停播放音乐，保留电源", media_stop: "停止播放音乐，保留电源",
  set_volume: "设置播放音量百分比", volume_up: "增大音量一次", volume_down: "减小音量一次",
  mute_on: "让播放声音静音，不是关闭电源或麦克风", mute_off: "取消播放声音的静音，恢复声音", channel_up: "下一个频道", channel_down: "上一个频道",
  raise: "升起晾衣杆到顶部", lower: "降下晾衣杆到底部", motion_stop: "停止窗帘/晾衣杆移动",
  feed: "按设备已配置的单次出粮量投喂一次，不修改投喂计划", vacuum_start: "扫地机器人开始清扫", vacuum_stop: "扫地机器人停止清扫", vacuum_dock: "扫地机器人返回充电座",
};
const services = {
  power_on: "turn_on", power_off: "turn_off", set_temperature: "set_temperature", set_position: "set_cover_position", set_speed: "set_percentage",
  oscillate_on: "oscillate", oscillate_off: "oscillate", media_play: "media_play", media_pause: "media_pause", media_stop: "media_stop",
  set_volume: "volume_set", volume_up: "volume_up", volume_down: "volume_down", mute_on: "volume_mute", mute_off: "volume_mute", raise: "open_cover", lower: "close_cover", motion_stop: "stop_cover",
  vacuum_start: "start", vacuum_stop: "stop", vacuum_dock: "return_to_base",
};
const primaryDomains = { ac: "climate", fan: "fan", curtain: "cover", drying_rack: "cover", tv: "media_player", media_player: "media_player", robot_vacuum: "vacuum", vacuum: "vacuum" };
const hasFeature = (cap, operation) => {
  const domain = cap.binding.domain;
  const bit = DEVICE_FEATURES[domain]?.[operation];
  const features = cap.binding.supportedFeatures;
  return bit && Number.isInteger(features) && features >= 0 && (features & bit) === bit;
};

export function deviceOperations(device, home) {
  const logical = resolveControlAsset(home, device.id);
  const thing = logical?.thing ?? home.things.find(t => t.id === device.id);
  const caps = logical?.capability ? [logical.capability] : thing?.capabilities ?? [];
  const native = caps.filter(c => c.binding?.domain === primaryDomains[device.type]);
  const identified = native.filter(c => /电源/.test(c.name) || c.id === "power");
  const primary = native.length === 1 ? native[0] : identified.length === 1 ? identified[0] : null;
  const result = [];
  const add = (cap, operation, service, extra = {}) => {
    const access = capabilityAccess(cap);
    if (!["execute", "confirm"].includes(access)) return;
    const constraints = cap.evidence?.constraints ?? {};
    const missingRange = operation === "set_temperature" && ![constraints.min ?? cap.binding.min ?? cap.binding.min_temp, constraints.max ?? cap.binding.max ?? cap.binding.max_temp].every(Number.isFinite);
    result.push({ id: `${cap.id}:${operation}`, operation, label: labels[operation], capabilityId: logical?.asset ? "power" : cap.id, missingRange,
      access: operation === "feed" ? "confirm" : access, domain: cap.binding.domain, service, repeatable: cap.binding.domain === "button", ...extra });
  };
  for (const cap of caps) {
    const domain = cap.binding?.domain;
    if (!domain) continue;
    if (cap === primary) {
      if (domain === "fan") {
        for (const op of ["power_on", "power_off", "set_speed"]) if (hasFeature(cap, op) || ["power_on", "power_off"].includes(op) && cap.binding.supportedFeatures === undefined) add(cap, op, services[op]);
        if (hasFeature(cap, "oscillate")) for (const op of ["oscillate_on", "oscillate_off"]) add(cap, op, services[op]);
      } else if (domain === "cover") {
        for (const op of ["power_on", "power_off", "set_position", "motion_stop"]) if (hasFeature(cap, op) || cap.binding.supportedFeatures === undefined && op !== "motion_stop") {
          const mapped = device.type === "drying_rack" && op === "power_on" ? "raise" : device.type === "drying_rack" && op === "power_off" ? "lower" : op;
          const label = device.type === "curtain" && ["power_on", "power_off"].includes(op) ? op === "power_on" ? "打开窗帘" : "关闭窗帘"
            : op === "motion_stop" ? `停止${device.type === "drying_rack" ? "晾衣杆" : "窗帘"}移动` : labels[mapped];
          add(cap, mapped, op === "power_on" ? "open_cover" : op === "power_off" ? "close_cover" : services[op], { label });
        }
      } else if (domain === "climate") {
        for (const op of ["power_on", "power_off", "set_temperature"]) if (hasFeature(cap, op) || cap.binding.supportedFeatures === undefined) add(cap, op, services[op]);
      } else if (["media_player", "vacuum"].includes(domain)) {
        for (const op of Object.keys(DEVICE_FEATURES[domain])) if (hasFeature(cap, op)) add(cap, op, services[op]);
      }
    } else if (domain === "switch" && ["drying_rack", "generic_device", "hub"].includes(device.type)
      && !/指示灯|提示音|反向|童锁|配置|计划/.test(cap.name)) {
      for (const op of ["power_on", "power_off"]) add(cap, op, services[op]);
    }
    if (domain !== "button") continue;
    const name = cap.name;
    const tests = ["pet_feeder", "feeder"].includes(device.type) ? { feed: /(?:投喂|喂食|出粮)(?:一次|执行|动作|按钮|$)/ }
      : ["tv", "media_player"].includes(device.type) ? { power_on: /开机$/, power_off: /关机$/, media_play: /播放音乐$/, volume_up: /音量\+$/, volume_down: /音量-$/, mute_on: /打开静音$/, mute_off: /关闭静音$/, channel_up: /频道\+$/, channel_down: /频道-$/ }
        : device.type === "drying_rack" ? { raise: /升起$|上升$/, lower: /降下$|下降$/, motion_stop: /停止$/ } : {};
    if (/校准|重置|计划|绑定|配置|童锁/.test(name)) continue;
    for (const [op, pattern] of Object.entries(tests)) if (pattern.test(name)) add(cap, op, "press");
  }
  // Prefer native stateful services to an IR/button command with the same meaning.
  return result.filter(op => op.domain !== "button" || !result.some(other => other.operation === op.operation && other.domain !== "button"));
}

export function compileDeviceOperation({ device, home, operationId, argument }) {
  const options = deviceOperations(device, home);
  const op = options.find(o => o.id === operationId);
  if (!op) return { error: "这个操作没有已确认的设备接口，我先不操作。" };
  const cap = resolveControlAsset(home, device.id)?.capability ?? home.things.find(t => t.id === device.id)?.capabilities.find(c => c.id === op.capabilityId);
  const value = { operation: op.operation };
  if (["set_temperature", "set_position", "set_speed", "set_volume"].includes(op.operation)) {
    const limits = cap.evidence?.constraints ?? {};
    const min = limits.min ?? cap.binding.min ?? cap.binding.min_temp ?? (op.operation === "set_temperature" ? undefined : 0);
    const max = limits.max ?? cap.binding.max ?? cap.binding.max_temp ?? (op.operation === "set_temperature" ? undefined : 100);
    const step = limits.step ?? cap.binding.step ?? (op.operation === "set_speed" ? cap.binding.percentageStep : undefined) ?? 1;
    if (![min, max, step, argument].every(Number.isFinite) || step <= 0 || argument < min || argument > max
      || Math.abs((argument - min) / step - Math.round((argument - min) / step)) > 1e-6) return { error: Number.isFinite(min) && Number.isFinite(max) ? `设备允许的范围是 ${min} 到 ${max}，数值还需符合设备步长。` : "设备尚未提供可靠的数值范围，我先不操作。" };
    value.argument = argument;
  } else if (argument !== undefined) return { error: "这类操作不接受数值参数，请明确设备支持的操作。" };
  return { action: { device_id: device.id, capability: op.capabilityId, value, reason: device.name }, operation: op };
}

export function deviceOperationService(capability, value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !["operation", "argument"].includes(k))) return null;
  const domain = capability.binding?.domain, entityId = capability.binding?.entityId;
  const operation = value.operation;
  const service = domain === "button" ? "press" : domain === "cover" && operation === "power_on" ? "open_cover"
    : domain === "cover" && operation === "power_off" ? "close_cover" : services[operation];
  if (!entityId || !service) return null;
  const device = { id: "target", type: domain === "button" ? /喂食|投喂|出粮/.test(capability.name) ? "pet_feeder" : ["raise", "lower", "motion_stop"].includes(operation) ? "drying_rack" : "tv"
    : domain === "cover" && ["raise", "lower"].includes(operation) ? "drying_rack" : Object.entries(primaryDomains).find(([, d]) => d === domain)?.[0] ?? "generic_device" };
  const home = { things: [{ ...device, capabilities: [capability] }], controlGraph: { assets: [], endpoints: [] } };
  const op = deviceOperations(device, home).find(o => o.operation === operation);
  if (!op || (domain === "button" && value.argument !== undefined)) return null;
  const validation = compileDeviceOperation({ device, home, operationId: op.id, argument: value.argument });
  if (validation.error) return null;
  const serviceData = { entity_id: entityId };
  const field = { set_temperature: "temperature", set_position: "position", set_speed: "percentage", set_volume: "volume_level" }[operation];
  if (field) serviceData[field] = operation === "set_volume" ? value.argument / 100 : value.argument;
  if (operation.startsWith("oscillate_")) serviceData.oscillating = operation === "oscillate_on";
  if (operation.startsWith("mute_")) serviceData.is_volume_muted = operation === "mute_on";
  return { domain, service: op.service, serviceData };
}

export function deviceOperationSummary(device, operations) {
  if (!operations.length) return `${device.name}目前没有已确认可执行的对应接口；可以查询已接入状态。`;
  const text = [...new Set(operations.map(o => `${o.label.split(/[，/]/)[0]}${o.missingRange ? "（范围待同步，暂不执行）" : o.access === "confirm" ? "（需确认）" : ""}`))].join("、");
  return `${device.name}可${text}。`;
}
