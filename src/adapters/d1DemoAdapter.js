import { createHcmHome } from "../hcm.js";
import { createProviderCommand, assertAuthorizedProviderExecution } from "./providerAdapterSdk.js";
import { simulateHcmServiceCall } from "../homeAssistantServiceSimulator.js";

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
  const identity = { id: "home_assistant", name: state.provider.name, version: "d1-experiment", transport: "memory" };
  return {
    id: identity.id,
    simulated: true,
    isConfigured: () => true,
    getStatus: () => ({ configured: true, baseUrl: null, simulated: true }),
    identity: async () => identity,
    getConnectionStatus: async () => ({ configured: true, state: "simulated" }),
    discoverHcmHome: async () => structuredClone(state),
    discoverSnapshot: async () => ({ version: "1.0", provider: identity, capturedAt: new Date().toISOString(), spaces: [], devices: [], entities: [], states: [], metadata: { simulated: true } }),
    async compileAction(action) {
      const service = action.serviceCall;
      if (!service) throw new Error("Demo requires a validated HCM service call");
      return createProviderCommand({ providerId: identity.id, target: { id: service.serviceData.entity_id, type: "entity" }, operation: `${service.domain}.${service.service}`, payload: service.serviceData });
    },
    async simulate(command, { home: snapshot, item } = {}) {
      const [domain, service] = command.operation.split(".");
      return { ...simulateHcmServiceCall({ ...item, serviceCall: { domain, service, serviceData: command.payload } }, snapshot), commandFingerprint: command.fingerprint, providerId: identity.id, mode: "simulation" };
    },
    async execute(command, authorization) {
      assertAuthorizedProviderExecution(authorization, command);
      const [, service] = command.operation.split(".");
      const capabilities = state.things.flatMap((thing) => thing.capabilities);
      const capability = capabilities.find((item) => item.binding?.entityId === command.target.id);
      if (!capability) throw new Error("Unknown demo entity");
      const payload = command.payload;
      const next = service === "turn_on" ? payload.brightness_pct ?? payload.percentage ?? true
        : service === "turn_off" ? false
          : service === "open_cover" ? 100 : service === "close_cover" ? 0
            : payload.temperature ?? payload.position;
      if (next === undefined) throw new Error(`Unsupported demo service ${service}`);
      capability.state = next;
      if (payload.brightness_pct !== undefined) {
        const thing = state.things.find((item) => item.capabilities.includes(capability));
        for (const power of thing.capabilities.filter((item) => item.binding?.domain === "light" && item.valueType === "boolean")) power.state = true;
      }
      return { simulated: true, state: next };
    },
    async readState(targetId) {
      const capability = state.things.flatMap((thing) => thing.capabilities).find((item) => item.binding?.entityId === targetId);
      if (!capability) throw new Error("Unknown demo state");
      return { state: capability.binding.domain === "cover" ? capability.state === 0 ? "closed" : "open" : capability.state === false ? "off" : "on", value: capability.state };
    },
  };
}
