import { compileHcmForPlanner } from "../hcmPlanner.js";
import { deviceOperations } from "../deviceOperations.js";

const primaryDomains = { ac: "climate", tv: "media_player", media_player: "media_player", fan: "fan", curtain: "cover", drying_rack: "cover", robot_vacuum: "vacuum", vacuum: "vacuum" };
function providerState(thing, type) {
  const native = thing?.capabilities.filter(c => c.binding?.domain === primaryDomains[type]) ?? [];
  const capability = native.find(c => c.id === "power" || /电源/.test(c.name)) ?? (native.length === 1 ? native[0] : null);
  if (!capability?.binding?.currentState) return thing?.simulationState ?? null;
  return { value: capability.binding.currentState, temperature: capability.binding.temperature, position: capability.binding.currentPosition,
    percentage: capability.binding.percentage, volumeLevel: capability.binding.volumeLevel, oscillating: capability.binding.oscillating };
}

export function sandboxDevices(home, blueprint) {
  const compiled = compileHcmForPlanner(home, { limit: 10000, includeConfirmable: true });
  const details = device => ({ operations: device.type === "light" ? [] : deviceOperations(device, home), providerState: providerState(home.things.find(t => t.id === device.id), device.type) });
  if (blueprint.kind !== "ha-replica") return compiled.map(device => ({ ...device, ...details(device) }));
  const devices = blueprint.devices.map(placement => {
    const device = compiled.find(d => d.id === placement.id);
    const thing = home.things.find(t => t.id === placement.id);
    const asset = home.controlGraph?.assets.find(a => a.id === placement.id);
    const endpoint = asset ? home.controlGraph.endpoints.find(e => e.id === asset.primaryEndpointId) : null;
    const controller = endpoint ? home.things.find(t => t.id === endpoint.providerThingId) : null;
    return { ...placement, ...device, online: thing?.online ?? controller?.online ?? placement.online, capabilities: device?.capabilities ?? [],
      ...details(device ?? placement),
      controller: endpoint ? { name: controller?.name, channel: endpoint.channel, installedRoomId: controller?.spaceId, capabilityName: endpoint.name } : null };
  });
  for (const device of compiled) if (!devices.some(d => d.id === device.id)) {
    const thing = home.things.find(t => t.id === device.id);
    devices.push({ ...device, online: thing?.online, ...details(device), position: null });
  }
  return devices;
}

export function sandboxDeviceStatus(device) {
  if (device.online === false) return "离线";
  const raw = device.providerState?.value;
  if (["unknown", "unavailable"].includes(raw)) return "状态未知";
  if (device.type === "pet_feeder" && device.providerState?.feedCount) return `已模拟投喂 ${device.providerState.feedCount} 次`;
  if (["curtain", "drying_rack"].includes(device.type) && Number.isFinite(device.providerState?.position)) return `${device.type === "curtain" ? "开度" : "位置"} ${device.providerState.position}%`;
  if (device.type === "curtain" && raw) return raw === "closed" ? "关闭" : raw === "open" ? "已打开 · 开度未知" : raw === "opening" ? "打开中" : raw === "closing" ? "关闭中" : "状态未知";
  if (device.type === "fan" && raw) return `${raw === "on" ? "开启" : raw === "off" ? "关闭" : "状态未知"}${raw === "on" && Number.isFinite(device.providerState.percentage) ? ` · ${device.providerState.percentage}%` : ""}`;
  if (device.type === "ac" && raw) {
    const label = { off: "关闭", on: "开启", cool: "制冷", heat: "制热", dry: "除湿", fan_only: "送风", auto: "自动", heat_cool: "自动" }[raw];
    if (label) return `${label}${raw !== "off" && Number.isFinite(device.providerState.temperature) ? ` · ${device.providerState.temperature}°C` : ""}`;
  }
  if (["tv", "media_player"].includes(device.type)) {
    const label = { off: "关闭", on: "开启", playing: "播放中", paused: "已暂停", idle: "待机", standby: "待机" }[raw];
    if (label) return label;
  }
  if (device.type === "robot_vacuum") {
    const label = { cleaning: "清扫中", returning: "回充中", docked: "充电座", idle: "待命", paused: "已暂停", error: "故障", off: "关闭" }[raw];
    if (label) return label;
  }
  const bool = device.capabilities.find(c => (c.valueType === "boolean" && ["power", "on_off"].includes(c.operation)) || ["power", "power_state"].includes(c.id));
  if (bool && typeof bool.state === "boolean") return bool.state ? "开启" : "关闭";
  const number = device.capabilities.find(c => typeof c.state === "number" && c.access === "execute");
  if (number) return `${number.state}${number.domain === "climate" ? "°C" : number.domain === "cover" || number.domain === "light" || number.domain === "fan" ? "%" : ""}`;
  const sensor = device.capabilities.find(c => c.valueType === "boolean" && c.access === "read");
  if (sensor && typeof sensor.state === "boolean") return device.type === "door_sensor" ? sensor.state ? "打开" : "关闭" : sensor.state ? "检测到" : "未检测到";
  return device.capabilities.some(c => c.access === "execute") ? "状态未知" : "只读";
}

export function deviceIsOn(device) {
  if (!device || device.online === false) return false;
  const raw = device.providerState?.value;
  if (device.type === "ac" && raw) return ["on", "cool", "heat", "dry", "fan_only", "auto", "heat_cool"].includes(raw);
  if (["tv", "media_player"].includes(device.type) && raw) return ["on", "playing", "paused", "idle", "standby"].includes(raw);
  if (device.type === "fan" && raw) return raw === "on";
  if (["robot_vacuum", "vacuum"].includes(device.type) && raw) return ["cleaning", "returning"].includes(raw);
  if (["presence_sensor", "motion_sensor", "door_sensor"].includes(device.type)) return device.capabilities.some(c => c.access === "read" && c.valueType === "boolean" && c.state === true);
  return device?.capabilities.some(c => c.state === true && (c.access === "execute" || ["power", "power_state"].includes(c.id))) ?? false;
}
