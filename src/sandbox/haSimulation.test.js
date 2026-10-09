import { describe, expect, it } from "vitest";
import { createD1DemoHome, createD1DemoAdapter } from "../adapters/d1DemoAdapter.js";
import { buildHcmExecutionPlan } from "../hcmExecutor.js";
import { simulateProviderExecutionPlan, executeSimulatedProviderPlan, verifyProviderExecutionResults } from "../providerExecutionRuntime.js";
import { prepareHaHouse } from "./haHouse.js";
import { haHouseFixture } from "./haHouse.fixture.js";

async function apply(adapter, home, action) {
  const plan = buildHcmExecutionPlan([action], home);
  expect(plan.rejected).toEqual([]);
  const simulation = await simulateProviderExecutionPlan({ adapter, accepted: plan.accepted, home });
  expect(simulation.ok).toBe(true);
  const results = await executeSimulatedProviderPlan({ adapter, simulation, commandId: "test" });
  const verified = await verifyProviderExecutionResults({ adapter, results, wait: async () => {} });
  expect(verified.every(r => r.ok && r.verification.ok)).toBe(true);
}

describe("HA capability-backed in-memory execution", () => {
  it("selects the exact capability when an entity exposes both power and brightness", async () => {
    const home = createD1DemoHome();
    const thing = home.things.find(t => t.id === "living_light");
    thing.capabilities[1].binding.entityId = thing.capabilities[0].binding.entityId;
    thing.capabilities.push({ ...structuredClone(thing.capabilities[0]), id: "other_channel", binding: { ...thing.capabilities[0].binding, entityId: "light.other_channel" } });
    const adapter = createD1DemoAdapter({ home });
    await apply(adapter, home, { thingId: thing.id, capabilityId: "living_brightness", value: 85 });
    const changed = (await adapter.discoverHcmHome()).things.find(t => t.id === thing.id);
    expect(changed.capabilities[0].state).toBe(true);
    expect(changed.capabilities[1].state).toBe(85);
    expect(changed.capabilities[2].state).toBe(false);
    expect(home.things.find(t => t.id === thing.id).capabilities[0].state).toBe(false);
  });
  it("updates individual HA gangs and logical lamp readback without stale graph state", async () => {
    const { home: raw, state } = haHouseFixture();
    const { home } = prepareHaHouse(raw, {}, state);
    const adapter = createD1DemoAdapter({ home });
    await apply(adapter, home, { thingId: "study_panel", capabilityId: "study_spot", value: true });
    const changed = await adapter.discoverHcmHome();
    expect(changed.controlGraph.assets.find(a => a.id === "asset_study_书房射灯").state.commandedState).toBe(true);
    expect(changed.controlGraph.assets.find(a => a.id === "asset_study_书房吊灯").state.commandedState).toBe(false);
    expect(changed.things.find(t => t.id === "study_panel").capabilities.find(c => c.id === "study_unused").state).toBe(false);
  });
  it("simulates pause, climate and cover services with provider-compatible readback", async () => {
    const home = createD1DemoHome();
    const tv = home.things.find(t => t.id === "living_tv");
    tv.capabilities[0].binding.supportedFeatures = 1;
    Object.assign(home.things.find(t => t.id === "study_ac").capabilities[0].binding, { currentState: "cool", temperature: 26 });
    const adapter = createD1DemoAdapter({ home });
    for (const action of [
      { thingId: tv.id, capabilityId: "tv_power", value: false },
      { thingId: "study_ac", capabilityId: "study_temperature", value: 24 },
      { thingId: "living_curtain", capabilityId: "curtain_position", value: 0 },
      { thingId: "living_fan", capabilityId: "fan_power", value: 0 },
    ]) await apply(adapter, await adapter.discoverHcmHome(), action);
    expect((await adapter.readState(tv.capabilities[0].binding.entityId)).state).toBe("paused");
    expect((await adapter.discoverHcmHome()).things.find(t => t.id === "study_ac").capabilities[0].state).toBe(24);
    expect((await adapter.discoverHcmHome()).things.find(t => t.id === "study_ac").capabilities[0].binding.temperature).toBe(24);
    expect((await adapter.readState("climate.demo_study_temperature")).state).toBe("cool");
    expect((await adapter.readState("cover.demo_curtain_position")).state).toBe("closed");
    expect((await adapter.readState("fan.demo_fan_power")).state).toBe("off");
  });
  it("keeps sensors, configuration and unused gangs protected even with simulation authorization", async () => {
    const home = createD1DemoHome();
    const adapter = createD1DemoAdapter({ home });
    for (const action of [{ thingId: "entry_motion", capabilityId: "occupancy", value: true }, { thingId: "study_panel", capabilityId: "study_unused", value: true }]) {
      const plan = buildHcmExecutionPlan([action], home);
      expect(plan.rejected[0].code).toBe("policy_blocked");
      const cap = home.things.find(t => t.id === action.thingId).capabilities.find(c => c.id === action.capabilityId);
      const command = await adapter.compileAction({ ...action, serviceCall: { domain: cap.binding.domain, service: "turn_on", serviceData: { entity_id: cap.binding.entityId } } });
      await expect(adapter.execute(command, { authorized: true, commandId: "test", simulation: { ok: true, commandFingerprint: command.fingerprint } })).rejects.toThrow("simulation_policy_blocked");
    }
  });
});
