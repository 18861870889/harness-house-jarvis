import { describe, expect, it } from "vitest";
import { compileDeviceOperation, deviceOperations, deviceOperationService } from "./deviceOperations.js";
import { createNonLightingFixture } from "./sandbox/nonLightingFixture.js";
import { compileHcmForPlanner, normalizeHcmPlannerDraft } from "./hcmPlanner.js";
import { buildHcmExecutionPlan, validateHcmAction } from "./hcmExecutor.js";
import { createD1DemoAdapter } from "./adapters/d1DemoAdapter.js";
import { simulateProviderExecutionPlan, executeSimulatedProviderPlan, verifyProviderExecutionResults } from "./providerExecutionRuntime.js";
import { sandboxDevices, sandboxDeviceStatus } from "./sandbox/sandboxDeviceView.js";
import { HOUSE_BLUEPRINT } from "./sandbox/houseBlueprint.js";

const device = (home, id) => compileHcmForPlanner(home, { limit: 10000, includeConfirmable: true }).find(d => d.id === id);
const operation = (home, id, name, argument) => compileDeviceOperation({ home, device: device(home, id), operationId: deviceOperations(device(home, id), home).find(o => o.operation === name)?.id, argument });
const cap = (home, id) => home.things.find(t => t.id === id).capabilities[0];

describe("grounded non-light device operations", () => {
  it.each([
    ["study_ac", "power_on", undefined, "climate.turn_on"], ["study_ac", "power_off", undefined, "climate.turn_off"], ["study_ac", "set_temperature", 24.5, "climate.set_temperature"],
    ["living_fan", "power_on", undefined, "fan.turn_on"], ["living_fan", "power_off", undefined, "fan.turn_off"], ["living_fan", "set_speed", 75, "fan.set_percentage"],
    ["living_fan", "oscillate_on", undefined, "fan.oscillate"], ["living_fan", "oscillate_off", undefined, "fan.oscillate"],
    ["living_curtain", "power_on", undefined, "cover.open_cover"], ["living_curtain", "power_off", undefined, "cover.close_cover"], ["living_curtain", "set_position", 30, "cover.set_cover_position"], ["living_curtain", "motion_stop", undefined, "cover.stop_cover"],
    ["rack", "raise", undefined, "cover.open_cover"], ["rack", "lower", undefined, "cover.close_cover"], ["rack", "motion_stop", undefined, "cover.stop_cover"],
    ["speaker", "power_on", undefined, "media_player.turn_on"], ["speaker", "power_off", undefined, "media_player.turn_off"],
    ["speaker", "media_play", undefined, "media_player.media_play"], ["speaker", "media_pause", undefined, "media_player.media_pause"], ["speaker", "media_stop", undefined, "media_player.media_stop"],
    ["speaker", "set_volume", 25, "media_player.volume_set"], ["speaker", "mute_on", undefined, "media_player.volume_mute"], ["speaker", "mute_off", undefined, "media_player.volume_mute"],
    ["speaker", "volume_up", undefined, "media_player.volume_up"], ["speaker", "volume_down", undefined, "media_player.volume_down"],
    ["living_tv", "power_on", undefined, "button.press"], ["living_tv", "power_off", undefined, "button.press"], ["living_tv", "volume_up", undefined, "button.press"],
    ["living_tv", "channel_down", undefined, "button.press"], ["feeder", "feed", undefined, "button.press"],
    ["vacuum", "vacuum_start", undefined, "vacuum.start"], ["vacuum", "vacuum_stop", undefined, "vacuum.stop"], ["vacuum", "vacuum_dock", undefined, "vacuum.return_to_base"],
  ])("executes %s %s with verified simulation readback", async (id, name, argument, service) => {
    const home = createNonLightingFixture(), compiled = operation(home, id, name, argument);
    expect(compiled.error).toBeUndefined();
    const normalized = normalizeHcmPlannerDraft("模拟设备操作", { intent: "模拟", confidence: 1, actions: [compiled.action] }, home, { strictSelection: true, confirmedActions: [compiled.action] });
    const plan = buildHcmExecutionPlan(normalized.actions, home, { confirmedActions: normalized.actions });
    expect(plan.rejected).toEqual([]);
    expect(`${plan.accepted[0].serviceCall.domain}.${plan.accepted[0].serviceCall.service}`).toBe(service);
    const adapter = createD1DemoAdapter({ home });
    const simulation = await simulateProviderExecutionPlan({ adapter, accepted: plan.accepted, home });
    expect(simulation.ok).toBe(true);
    const results = await executeSimulatedProviderPlan({ adapter, simulation, commandId: `test-${id}-${name}` });
    const verification = await verifyProviderExecutionResults({ adapter, results, home });
    expect(verification).toHaveLength(1);
    expect(verification.every(r => r.ok && r.verification.ok)).toBe(true);
    const after = await adapter.discoverHcmHome();
    const beforeOther = home.things.filter(t => t.id !== id), afterOther = after.things.filter(t => t.id !== id);
    expect(afterOther).toEqual(beforeOther);
    if (id === "living_fan") expect(after.things.find(t => t.id === id).capabilities[1].state).toBe(false);
    if (id === "living_curtain") expect(after.things.find(t => t.id === id).capabilities[1].state).toBe(false);
    if (name === "feed") expect(after.things.find(t => t.id === id).simulationState.feedCount).toBe(1);
    if (name === "set_volume") expect((await adapter.readState(cap(home, id).binding.entityId)).attributes.volume_level).toBe(0.25);
  });

  it.each([99, -1, 24.3, NaN, Infinity, "24"])("rejects invalid temperature %s without clamping", value => {
    expect(operation(createNonLightingFixture(), "study_ac", "set_temperature", value).error).toBeDefined();
  });
  it.each([-1, 101, 33, NaN])("rejects unsupported fan step or percentage %s", value => {
    expect(operation(createNonLightingFixture(), "living_fan", "set_speed", value).error).toBeDefined();
  });
  it("requires exact numeric bounds for temperature", () => {
    const home = createNonLightingFixture(); delete cap(home, "study_ac").binding.min_temp;
    expect(operation(home, "study_ac", "set_temperature", 24).error).toContain("范围");
  });
  it("does not expose unsupported media stop or use power-off instead", () => {
    const home = createNonLightingFixture(); cap(home, "speaker").binding.supportedFeatures = 1;
    expect(deviceOperations(device(home, "speaker"), home).map(o => o.operation)).toEqual(["media_pause"]);
    expect(deviceOperationService(cap(home, "speaker"), { operation: "media_stop" })).toBeNull();
  });
  it("rejects an unknown feature bit or arbitrary service payload", () => {
    const home = createNonLightingFixture(); cap(home, "living_fan").binding.supportedFeatures = 0;
    expect(deviceOperations(device(home, "living_fan"), home)).toEqual([]);
    expect(deviceOperationService(cap(home, "speaker"), { operation: "media_play", service: "turn_off" })).toBeNull();
    expect(deviceOperationService(cap(home, "speaker"), { operation: "delete_everything" })).toBeNull();
  });
  it("requires exact feeding confirmation, even if a provider marks feeding low risk", () => {
    const home = createNonLightingFixture(), a = operation(home, "feeder", "feed").action;
    cap(home, "feeder").policy = { risk: "low", confirmation: "never", autoExecutable: true };
    expect(validateHcmAction(a, home).code).toBe("confirmation_required");
    expect(validateHcmAction(a, home, { confirmedActions: [{ ...a, value: { operation: "power_on" } }] }).ok).toBe(false);
    expect(validateHcmAction(a, home, { confirmedActions: [a] }).ok).toBe(true);
    expect(validateHcmAction({ ...a, value: true }, home).ok).toBe(false);
  });
  it.each(["high", "sensitive"])("confirmation never authorizes %s-risk calibration", risk => {
    const home = createNonLightingFixture(), protectedCap = home.things.find(t => t.id === "feeder").capabilities[1];
    protectedCap.policy.risk = risk;
    const a = { device_id: "feeder", capability: protectedCap.id, value: true };
    expect(validateHcmAction(a, home, { confirmedActions: [a] }).ok).toBe(false);
    expect(deviceOperations(device(home, "feeder"), home).every(o => o.capabilityId !== protectedCap.id)).toBe(true);
  });
  it("does not infer a rack raising action from its power switch", () => {
    const home = createNonLightingFixture(); cap(home, "rack").binding.domain = "switch";
    expect(deviceOperations(device(home, "rack"), home).map(o => o.operation)).toEqual(["power_on", "power_off"]);
    expect(operation(home, "rack", "raise").error).toBeDefined();
  });
  it("rejects negative feature masks", () => {
    const home = createNonLightingFixture(); cap(home, "speaker").binding.supportedFeatures = -1;
    expect(deviceOperations(device(home, "speaker"), home)).toEqual([]);
  });
  it("a service acceptance is not enough when numeric readback differs", async () => {
    const verified = await verifyProviderExecutionResults({ adapter: { readState: async () => ({ state: "on", attributes: { percentage: 10 } }) },
      results: [{ ok: true, service: "fan.set_percentage", serviceData: { entity_id: "fan.fixture", percentage: 75 } }], wait: async () => {} });
    expect(verified[0].verification.ok).toBe(false);
    expect(verified[0].verification.code).toBe("state_mismatch");
  });
  it("sensor and configuration entries never become controls", () => {
    const home = createNonLightingFixture();
    expect(deviceOperations(device(home, "presence"), home)).toEqual([]);
    const feeder = deviceOperations(device(home, "feeder"), home);
    expect(feeder.map(o => o.operation)).toEqual(["feed"]);
  });
  it("does not guess among multiple unnamed primary controls", () => {
    const home = createNonLightingFixture(), fan = home.things.find(t => t.id === "living_fan");
    fan.capabilities[0].name = "控制甲";
    fan.capabilities.push({ ...structuredClone(fan.capabilities[0]), id: "second_power", name: "控制乙" });
    expect(deviceOperations(device(home, "living_fan"), home)).toEqual([]);
  });
  it("UI reports provider power and position rather than an auxiliary switch", () => {
    const home = createNonLightingFixture(); cap(home, "living_fan").binding.currentState = "off";
    home.things.find(t => t.id === "living_fan").capabilities[1].state = true;
    const devices = sandboxDevices(home, HOUSE_BLUEPRINT);
    expect(sandboxDeviceStatus(devices.find(d => d.id === "living_fan"))).toBe("关闭");
    expect(sandboxDeviceStatus(devices.find(d => d.id === "living_curtain"))).toBe("开度 50%");
    expect(sandboxDeviceStatus(devices.find(d => d.id === "study_ac"))).toBe("制冷 · 26°C");
  });
});
