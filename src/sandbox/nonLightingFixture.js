import { createSandboxHome } from "./houseBlueprint.js";
import { DEVICE_FEATURES } from "../deviceOperations.js";

// Test-only interfaces. They are never added to a saved HA household.
export function createNonLightingFixture() {
  const home = createSandboxHome();
  const features = domain => Object.values(DEVICE_FEATURES[domain]).reduce((mask, bit) => mask | bit, 0);
  const cap = (id, name, domain, extra = {}) => ({ id, name, kind: "control", valueType: "boolean", state: false,
    policy: { risk: "low", confirmation: "never", autoExecutable: true },
    binding: { provider: "home_assistant", domain, entityId: `${domain}.fixture_${id}`, ...extra } });
  const thing = (id, name, type, capabilities) => ({ id, name, type, spaceId: "living", online: true, aliases: [], capabilities });
  const ac = home.things.find(t => t.id === "study_ac").capabilities[0];
  Object.assign(ac.binding, { supportedFeatures: features("climate"), temperature: 26, currentState: "cool", step: 0.5 });
  const fan = home.things.find(t => t.id === "living_fan");
  Object.assign(fan.capabilities[0], { state: true });
  Object.assign(fan.capabilities[0].binding, { supportedFeatures: features("fan"), currentState: "on", percentage: 50, percentageStep: 25, oscillating: false });
  fan.capabilities.push(cap("fan_buzzer", "提示音", "switch"));
  const curtain = home.things.find(t => t.id === "living_curtain");
  Object.assign(curtain.capabilities[0].binding, { supportedFeatures: features("cover"), currentState: "open", currentPosition: 50 });
  curtain.capabilities.push(cap("curtain_reverse", "电机反向", "switch"));
  const tv = home.things.find(t => t.id === "living_tv");
  tv.capabilities = [["on", "开机"], ["off", "关机"], ["up", "音量+"], ["down", "音量-"], ["mute", "打开静音"], ["unmute", "关闭静音"], ["next", "频道+"], ["previous", "频道-"]].map(([id, label]) => ({ ...cap(`tv_${id}`, `客厅电视${label}`, "button"), kind: "action" }));
  home.things.push(
    thing("speaker", "客厅音箱", "tv", [cap("speaker_power", "音箱电源", "media_player", { supportedFeatures: features("media_player"), currentState: "playing", volumeLevel: 0.4, volumeMuted: false })]),
    thing("rack", "客厅晾衣杆", "drying_rack", [cap("rack_position", "升降位置", "cover", { supportedFeatures: features("cover"), currentState: "closed", currentPosition: 0 })]),
    thing("feeder", "客厅猫粮机", "pet_feeder", [
      { ...cap("feed", "投喂一次", "button"), kind: "action", policy: { risk: "medium", confirmation: "always", autoExecutable: false } },
      { ...cap("calibrate", "电机校准", "button"), kind: "action", policy: { risk: "high", confirmation: "always", autoExecutable: false } },
      { ...cap("quantity", "出粮量配置", "number"), kind: "config", valueType: "number", state: 20, policy: { risk: "high", confirmation: "always", autoExecutable: false } },
    ]),
    thing("vacuum", "客厅扫地机器人", "robot_vacuum", [cap("vacuum_state", "清扫控制", "vacuum", { supportedFeatures: features("vacuum"), currentState: "docked" })]),
    thing("presence", "客厅人在传感器", "presence_sensor", [{ ...cap("occupancy", "有人无人", "binary_sensor"), kind: "sensor", state: true }]),
  );
  return home;
}
