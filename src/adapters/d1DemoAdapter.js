import { createHcmHome } from "../hcm.js";
import { createProviderCommand, assertAuthorizedProviderExecution } from "./providerAdapterSdk.js";
import { simulateHcmServiceCall } from "../homeAssistantServiceSimulator.js";
import { capabilityAccess } from "../capabilityAuthorization.js";
import { deviceOperationService } from "../deviceOperations.js";

export function createD1DemoHome() {
  const control = (id, name, domain, valueType = "boolean", state = false, extra = {}) => ({
    id, name, kind: "control", valueType, state,
    policy: { risk: "low", confirmation: "never", autoExecutable: true },
    binding: { provider: "home_assistant", domain, entityId: `${domain}.demo_${id}`, ...extra },
  });
  return createHcmHome({
    provider: { id: "home_assistant", name: "内存模拟 · 不连接真实 HA" },
    spaces: [
      { id: "entry", name: "玄关", aliases: ["入户"] },
      { id: "dining", name: "餐厅" }, { id: "study", name: "书房" },
      { id: "living", name: "客厅" }, { id: "master", name: "主卧" },
      { id: "second", name: "次卧" }, { id: "balcony", name: "阳台" },
    ],
    things: [
      { id: "entry_panel", name: "入户1号开关", type: "switch_panel", spaceId: "entry", capabilities: [
        control("dining_spot", "餐厅射灯 开关左键", "switch"),
        control("dining_ceiling", "餐厅吊灯 开关右键", "switch"),
      ] },
      { id: "study_panel", name: "书房开关", type: "switch_panel", spaceId: "study", capabilities: [
        control("study_spot", "书房射灯 开关左键", "switch"),
        control("study_ceiling", "书房吊灯 开关中键", "switch"),
        { ...control("study_unused", "右键-书房开关（右键未绑定", "switch"), policy: { risk: "high", confirmation: "always", autoExecutable: false } },
      ] },
      ...[["living", "客厅"], ["master", "主卧"], ["second", "次卧"]].map(([id, name]) => ({
        id: `${id}_light`, name: `${name}灯`, type: "light", spaceId: id,
        capabilities: [control(`${id}_power`, "电源", "light"), control(`${id}_brightness`, "亮度", "light", "number", 40)],
      })),
      { id: "study_ac", name: "书房空调", type: "ac", spaceId: "study", capabilities: [
        control("study_temperature", "温度", "climate", "number", 26, { min_temp: 16, max_temp: 30 }),
      ] },
      { id: "living_tv", name: "客厅电视", type: "tv", spaceId: "living", capabilities: [control("tv_power", "电源", "media_player", "boolean", false, { supportedFeatures: 128 | 256 })] },
      { id: "living_fan", name: "客厅风扇", type: "fan", spaceId: "living", capabilities: [control("fan_power", "电源", "fan")] },
      { id: "living_curtain", name: "客厅窗帘", type: "curtain", spaceId: "living", capabilities: [control("curtain_position", "位置", "cover", "number", 50)] },
      { id: "balcony_drying", name: "阳台晾衣杆", aliases: ["晾衣杆", "晾衣服"], type: "drying_rack", spaceId: "balcony", capabilities: [control("drying_position", "升降位置", "cover", "number", 100)] },
      { id: "entry_motion", name: "玄关人体传感器", aliases: ["玄关人体"], type: "motion_sensor", spaceId: "entry", capabilities: [
        { id: "occupancy", name: "人体检测", kind: "sensor", valueType: "boolean", state: false, binding: { provider: "home_assistant", domain: "binary_sensor", entityId: "binary_sensor.demo_entry" } },
      ] },
    ],
  });
}

// This adapter has no network transport. Even an authorized execute mutates memory only.
export function createD1DemoAdapter({ home = createD1DemoHome() } = {}) {
  const state = structuredClone(home);
  const entityStates = new Map(state.things.flatMap(thing => thing.capabilities.filter(c => c.binding?.entityId).map(c => [c.binding.entityId, c.binding.currentState ?? (c.state === false ? "off" : "on")])));
  const identity = { id: "home_assistant", name: state.provider.name, version: "d1-experiment", transport: "memory" };
  return {
    id: identity.id,
    simulated: true,
    isConfigured: () => true,
    getStatus: () => ({ configured: true, baseUrl: null, simulated: true }),
    identity: async () => identity,
    getConnectionStatus: async () => ({ configured: true, state: "simulated" }),
    discoverHcmHome: async () => {
      if (state.controlGraph) {
        for (const endpoint of state.controlGraph.endpoints) {
          const cap = state.things.find(t => t.id === endpoint.providerThingId)?.capabilities.find(c => c.id === endpoint.capabilityId);
          endpoint.state = typeof cap?.state === "boolean" ? cap.state : "unknown";
        }
        for (const asset of state.controlGraph.assets) asset.state.commandedState = state.controlGraph.endpoints.find(e => e.id === asset.primaryEndpointId)?.state ?? "unknown";
      }
      return structuredClone(state);
    },
    discoverSnapshot: async () => ({ version: "1.0", provider: identity, capturedAt: new Date().toISOString(), spaces: [], devices: [], entities: [], states: [], metadata: { simulated: true } }),
    async compileAction(action) {
      const service = action.serviceCall;
      if (!service) throw new Error("Demo requires a validated HCM service call");
      return createProviderCommand({ providerId: identity.id, target: { id: service.serviceData.entity_id, type: "entity" }, operation: `${service.domain}.${service.service}`, payload: service.serviceData,
        evidence: { observations: { thingId: action.thingId, capabilityId: action.capabilityId, value: action.value } } });
    },
    async simulate(command, { home: snapshot, item } = {}) {
      const [domain, service] = command.operation.split(".");
      return { ...simulateHcmServiceCall({ ...item, serviceCall: { domain, service, serviceData: command.payload } }, snapshot), commandFingerprint: command.fingerprint, providerId: identity.id, mode: "simulation" };
    },
    async execute(command, authorization) {
      assertAuthorizedProviderExecution(authorization, command);
      const [domain, service] = command.operation.split(".");
      const selection = command.evidence?.observations;
      const thing = state.things.find(t => t.id === selection?.thingId) ?? state.things.find(t => t.capabilities.some(c => c.binding?.entityId === command.target.id));
      const capability = selection?.capabilityId ? thing?.capabilities.find(c => c.id === selection.capabilityId && c.binding?.entityId === command.target.id)
        : thing?.capabilities.find(c => c.binding?.entityId === command.target.id);
      if (!capability) throw new Error("Unknown demo entity");
      const access = capabilityAccess(capability);
      if (!(access === "execute" || access === "confirm" && authorization.confirmed === true) || thing.online === false) throw new Error("simulation_policy_blocked");
      if (selection?.value && typeof selection.value === "object") {
        if (selection.value.operation === "feed" && authorization.confirmed !== true) throw new Error("simulation_confirmation_required");
        const expected = deviceOperationService(capability, selection.value);
        if (!expected || `${expected.domain}.${expected.service}` !== command.operation || JSON.stringify(expected.serviceData) !== JSON.stringify(command.payload)) throw new Error("simulation_operation_mismatch");
      }
      const payload = command.payload;
      const auxiliary = ["oscillate", "volume_set", "volume_mute", "volume_up", "volume_down"].includes(service);
      const next = service === "turn_on" ? payload.brightness_pct ?? payload.percentage ?? true
        : ["turn_off", "media_pause", "media_stop"].includes(service) ? false
          : ["media_play", "press"].includes(service) ? true
          : service === "open_cover" ? 100 : service === "close_cover" ? 0
            : service === "oscillate" ? payload.oscillating : service === "volume_mute" ? payload.is_volume_muted
              : service === "volume_set" ? payload.volume_level
                : ["volume_up", "volume_down"].includes(service) ? capability.state ?? null
                  : service === "stop_cover" ? capability.binding.currentPosition ?? capability.state
                  : ["start", "stop", "return_to_base"].includes(service) ? service === "start" ? "cleaning" : service === "return_to_base" ? "returning" : "idle"
                    : payload.temperature ?? payload.position ?? payload.percentage;
      if (next === undefined) throw new Error(`Unsupported demo service ${service}`);
      const oldRaw = entityStates.get(command.target.id) ?? "unknown";
      if (!auxiliary) capability.state = next;
      const raw = auxiliary ? oldRaw
        : service === "media_pause" ? "paused" : service === "media_stop" ? "idle" : service === "media_play" ? "playing"
          : domain === "vacuum" ? next
        : domain === "cover" ? next === 0 ? "closed" : "open"
          : domain === "fan" && typeof next === "number" ? next === 0 ? "off" : "on"
          : service === "set_temperature" ? entityStates.get(command.target.id) ?? "off" : next === false ? "off" : "on";
      entityStates.set(command.target.id, raw);
      capability.binding.currentState = raw;
      if (payload.temperature !== undefined) capability.binding.temperature = payload.temperature;
      if (domain === "cover" && typeof next === "number") capability.binding.currentPosition = next;
      if (payload.percentage !== undefined) capability.binding.percentage = payload.percentage;
      if (payload.oscillating !== undefined) capability.binding.oscillating = payload.oscillating;
      if (payload.volume_level !== undefined) capability.binding.volumeLevel = payload.volume_level;
      if (payload.is_volume_muted !== undefined) capability.binding.volumeMuted = payload.is_volume_muted;
      if (["volume_up", "volume_down"].includes(service) && Number.isFinite(capability.binding.volumeLevel)) capability.binding.volumeLevel = Math.min(1, Math.max(0, capability.binding.volumeLevel + (service === "volume_up" ? 0.05 : -0.05)));
      if (domain === "button") {
        capability.binding.pressCount = (capability.binding.pressCount ?? 0) + 1;
        const operation = selection?.value?.operation;
        thing.simulationState = { ...thing.simulationState, lastOperation: operation, buttonPresses: (thing.simulationState?.buttonPresses ?? 0) + 1 };
        if (["power_on", "power_off", "media_play"].includes(operation)) thing.simulationState.value = operation === "power_off" ? "off" : operation === "media_play" ? "playing" : "on";
        if (operation === "feed") thing.simulationState.feedCount = (thing.simulationState.feedCount ?? 0) + 1;
      }
      if (payload.brightness_pct !== undefined) {
        const powers = thing.capabilities.filter(item => item.binding?.domain === "light" && item.valueType === "boolean");
        const sameEntity = powers.filter(item => item.binding.entityId === command.target.id);
        for (const power of sameEntity.length ? sameEntity : powers.length === 1 ? powers : []) power.state = true;
      }
      return { simulated: true, state: next };
    },
    async readState(targetId) {
      const capability = state.things.flatMap((thing) => thing.capabilities).find((item) => item.binding?.entityId === targetId);
      if (!capability) throw new Error("Unknown demo state");
      return { state: entityStates.get(targetId) ?? "unknown", value: capability.state, attributes: {
        temperature: capability.binding.temperature, current_position: capability.binding.currentPosition,
        percentage: capability.binding.percentage, oscillating: capability.binding.oscillating,
        volume_level: capability.binding.volumeLevel, is_volume_muted: capability.binding.volumeMuted,
      } };
    },
  };
}
