import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareHaHouse, createHaHouseSource, readOnlyHaTransports } from "./haHouse.js";
import { actorRoom, isValidActorPose, findWalkingPath } from "./houseBlueprint.js";
import { compileHcmForPlanner } from "../hcmPlanner.js";
import { haHouseFixture } from "./haHouse.fixture.js";
import { createSandboxService } from "./sandboxService.js";

describe("existing HA house, not a replacement demo", () => {
  it("keeps every provider device, mapped gang and edited room; preserves image aspect", () => {
    const { home, state } = haHouseFixture();
    const house = prepareHaHouse(home, {}, state);
    expect(house.home.things).toHaveLength(home.things.length);
    expect(house.blueprint.rooms.map(r => r.id)).toContain("corridor");
    expect(house.blueprint.rooms).toHaveLength(8);
    const study = house.blueprint.rooms.find(r => r.id === "study");
    expect((study.maxX - study.minX) / (study.maxZ - study.minZ)).toBeCloseTo(35 / 30 * 0.8, 4);
    expect(house.blueprint.devices.find(d => d.id === "asset_study_书房射灯").position[0]).toBeCloseTo(1.4);
    expect(compileHcmForPlanner(house.home).filter(d => d.roomId === "study" && d.type === "light")).toHaveLength(2);
    expect(house.home.controlGraph.endpoints.find(e => e.capabilityId === "study_unused").status).toBe("unbound");
  });
  it("uses semantic assignments without moving a physical entry controller into dining", () => {
    const { home, state } = haHouseFixture();
    state.deviceAssignments.asset_dining_餐厅射灯 = "corridor";
    state.namingMode = "room_custom";
    state.customDeviceNames.asset_dining_餐厅射灯 = "过道射灯";
    const house = prepareHaHouse(home, {}, state);
    const asset = house.home.controlGraph.assets.find(a => a.id === "asset_dining_餐厅射灯");
    expect(asset.spaceId).toBe("corridor");
    expect(asset.name).toContain("过道射灯");
    expect(house.home.things.find(t => t.id === "entry_panel").spaceId).toBe("entry");
    expect(asset.primaryEndpointId).toContain("demo_dining_spot");
    expect(home.things.find(t => t.id === "entry_panel").spaceId).toBe("entry");
  });
  it("uses valid actor locations, open doors and collision-aware routes in all rooms", () => {
    const { home, state } = haHouseFixture();
    const { blueprint } = prepareHaHouse(home, {}, state);
    expect(isValidActorPose(blueprint.spawn, blueprint)).toBe(true);
    for (const room of blueprint.rooms) {
      expect(actorRoom(blueprint.roomSpawns[room.id], blueprint)).toBe(room.id);
      expect(findWalkingPath(blueprint.spawn, blueprint.roomSpawns[room.id], blueprint).length).toBeGreaterThan(0);
    }
    expect(isValidActorPose({ x: 100, z: 0 }, blueprint)).toBe(false);
    expect(isValidActorPose({ x: -6.5, z: 7.5 }, blueprint)).toBe(false);
  });
  it("keeps a drawn room even after its last device and HA area disappear", () => {
    const { home, state } = haHouseFixture();
    home.things = home.things.filter(t => t.spaceId !== "balcony");
    home.spaces = home.spaces.filter(s => s.id !== "balcony");
    const house = prepareHaHouse(home, {}, state);
    expect(house.blueprint.rooms).toHaveLength(8);
    expect(house.home.spaces.find(s => s.id === "balcony")?.name).toBe("阳台");
    expect(actorRoom(house.blueprint.roomSpawns.balcony, house.blueprint)).toBe("balcony");
  });
  it("never exports transport credentials or arbitrary provider attributes", () => {
    const { home, state } = haHouseFixture();
    home.provider.token = "private-token";
    home.things[0].provider = { token: "private-token" };
    home.things[0].capabilities[0].binding.attributes = { access_token: "private-token", entity_picture: "http://camera/private" };
    home.things[0].capabilities[0].evidence = { token: "private-token" };
    home.things[0].capabilities.push({ id: "wifi_password", name: "Wi-Fi 密码", kind: "config", state: "private-token", binding: { entityId: "text.wifi_password", currentState: "private-token", options: ["private-token"] } });
    const serialized = JSON.stringify(prepareHaHouse(home, {}, state));
    expect(serialized).not.toContain("private-token");
    expect(serialized).not.toContain("http://camera/private");
  });
  it("rejects corrupt or uncalibrated layouts instead of silently showing two sample rooms", () => {
    const { home, state } = haHouseFixture();
    expect(() => prepareHaHouse({}, {}, state)).toThrow("invalid_ha_snapshot");
    expect(() => prepareHaHouse(home, {}, { ...state, floorPlanCoordinateMode: "container", floorPlanImage: "data:image/jpeg;base64,AA==" })).toThrow("layout_needs_calibration");
  });
});

describe("read-only HA boundary and offline source", () => {
  it("permits registry/state reads but refuses all service and event writes", async () => {
    const fetchImpl = vi.fn(async () => new Response("[]"));
    const sent = [];
    class Socket { send(data) { sent.push(JSON.parse(data)); } close() {} }
    const transport = readOnlyHaTransports({ baseUrl: "http://ha.test:8123", fetchImpl, WebSocketImpl: Socket });
    await transport.fetchImpl("http://ha.test:8123/api/states", {});
    await expect(transport.fetchImpl("http://ha.test:8123/api/services/light/turn_on", { method: "POST" })).rejects.toThrow("ha_read_only");
    await expect(transport.fetchImpl("http://other.test/api/states", {})).rejects.toThrow("ha_read_only");
    const socket = new transport.WebSocketImpl("ws://ha.test:8123/api/websocket");
    socket.send(JSON.stringify({ type: "config/device_registry/list", id: 1 }));
    expect(() => socket.send(JSON.stringify({ type: "call_service", domain: "light", service: "turn_on" }))).toThrow("ha_read_only");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    transport.close();
  });
  it("retains the last good full house when HA is offline and reports stale status", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sandbox-ha-test-"));
    const { home, state } = haHouseFixture();
    writeFileSync(join(directory, "home_model_cache.json"), JSON.stringify(home));
    const graphLoader = vi.fn(async () => { throw new Error("private-token network unavailable"); });
    const source = await createHaHouseSource({ directory, connection: { baseUrl: "http://ha.test:8123", token: "private-token" }, spatialState: state, graphLoader });
    try {
      const before = source.house();
      await source.refresh();
      expect(source.house()).toEqual(before);
      expect(source.status().connectionState).toBe("cached");
      expect(source.status().error).toBe("ha_unavailable");
      expect(JSON.stringify(source.status())).not.toContain("private-token");
      expect(source.house().home.things).toHaveLength(home.things.length);
    } finally { source.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it("refreshes registry changes without overwriting an already forked simulation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sandbox-ha-test-"));
    const { home, state } = haHouseFixture();
    writeFileSync(join(directory, "home_model_cache.json"), JSON.stringify(home));
    let finish;
    const graphLoader = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const source = await createHaHouseSource({ directory, connection: { baseUrl: "http://ha.test:8123", token: "private-token" }, spatialState: state, graphLoader });
    const initial = source.house();
    const service = await createSandboxService({ client: {}, initialHome: initial.home, blueprint: initial.blueprint, baselineId: initial.baselineId });
    try {
      const first = source.refresh(), second = source.refresh();
      expect(graphLoader).toHaveBeenCalledTimes(1);
      expect(source.status().connectionState).toBe("syncing");
      finish({
        fetchedAt: "2026-10-09T01:00:00.000Z",
        areas: home.spaces.map(s => ({ area_id: s.id, name: s.name })),
        devices: [{ id: "added", area_id: "study", name: "书房新增灯", identifiers: [["xiaomi_home", "fixture"]] }],
        entities: [{ device_id: "added", entity_id: "light.fixture_added", original_name: "电源", platform: "xiaomi_home" }],
        states: [{ entity_id: "light.fixture_added", state: "on", attributes: {} }],
      });
      await Promise.all([first, second]);
      expect(source.status().connectionState).toBe("live");
      expect(source.house().home.things[0].id).toBe("ha_added");
      expect(source.house().baselineId).not.toBe(initial.baselineId);
      expect(source.house().blueprint.rooms).toHaveLength(8);
      expect(service.snapshot().home).toEqual(initial.home);
      expect(service.snapshot().effects).toBe(0);
    } finally { source.close(); await service.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it("can pick up saved map edits while HA is offline without mutating the original cache", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sandbox-ha-test-"));
    const { home, state } = haHouseFixture();
    writeFileSync(join(directory, "home_model_cache.json"), JSON.stringify(home));
    const source = await createHaHouseSource({ directory, spatialState: state });
    try {
      const before = source.house().baselineId;
      state.roomNames = { study: "工作间" };
      await source.refresh();
      expect(source.status().connectionState).toBe("cached");
      expect(source.house().blueprint.rooms.find(r => r.id === "study").name).toBe("工作间");
      expect(source.house().baselineId).not.toBe(before);
      expect(home.spaces.find(s => s.id === "study").name).toBe("书房");
    } finally { source.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
