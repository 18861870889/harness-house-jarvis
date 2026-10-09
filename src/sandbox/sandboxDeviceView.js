import { compileHcmForPlanner } from "../hcmPlanner.js";

const primaryDomains = { ac: "climate", tv: "media_player", media_player: "media_player", fan: "fan", curtain: "cover", robot_vacuum: "vacuum" };
function providerState(thing, type) {
  const capability = thing?.capabilities.find(c => c.binding?.domain === primaryDomains[type]);
  if (!capability?.binding?.currentState) return null;
  return { value: capability.binding.currentState, temperature: capability.binding.temperature };
}

export function sandboxDevices(home, blueprint) {
  const compiled = compileHcmForPlanner(home, { limit: 10000 });
  if (blueprint.kind !== "ha-replica") return compiled;
  const devices = blueprint.devices.map(placement => {
    const device = compiled.find(d => d.id === placement.id);
    const thing = home.things.find(t => t.id === placement.id);
    const asset = home.controlGraph?.assets.find(a => a.id === placement.id);
    const endpoint = asset ? home.controlGraph.endpoints.find(e => e.id === asset.primaryEndpointId) : null;
    const controller = endpoint ? home.things.find(t => t.id === endpoint.providerThingId) : null;
    return { ...placement, ...device, online: thing?.online ?? controller?.online ?? placement.online, capabilities: device?.capabilities ?? [],
      providerState: providerState(thing, placement.type),
      controller: endpoint ? { name: controller?.name, channel: endpoint.channel, installedRoomId: controller?.spaceId, capabilityName: endpoint.name } : null };
  });
  for (const device of compiled) if (!devices.some(d => d.id === device.id)) {
    const thing = home.things.find(t => t.id === device.id);
    devices.push({ ...device, online: thing?.online, providerState: providerState(thing, device.type), position: null });
  }
  return devices;
}

export function sandboxDeviceStatus(device) {
  if (device.online === false) return "离线";
  const raw = device.providerState?.value;
  if (["unknown", "unavailable"].includes(raw)) return "状态未知";
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
  if (["presence_sensor", "motion_sensor", "door_sensor"].includes(device.type)) return device.capabilities.some(c => c.access === "read" && c.valueType === "boolean" && c.state === true);
  return device?.capabilities.some(c => c.state === true && (c.access === "execute" || ["power", "power_state"].includes(c.id))) ?? false;
}
