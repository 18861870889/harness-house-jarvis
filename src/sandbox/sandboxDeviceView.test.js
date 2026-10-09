import { describe, expect, it } from "vitest";
import { sandboxDevices, sandboxDeviceStatus, deviceIsOn } from "./sandboxDeviceView.js";
import { prepareHaHouse } from "./haHouse.js";
import { haHouseFixture } from "./haHouse.fixture.js";

describe("truthful HA snapshot and simulated device labels", () => {
  it("shows climate mode and target temperature without inventing an on/off reading", () => {
    const { home, state } = haHouseFixture();
    const ac = home.things.find(t => t.id === "study_ac");
    ac.capabilities[0].state = "cool";
    Object.assign(ac.capabilities[0].binding, { currentState: "cool", temperature: 24 });
    const house = prepareHaHouse(home, {}, state);
    const device = sandboxDevices(house.home, house.blueprint).find(d => d.id === ac.id);
    expect(sandboxDeviceStatus(device)).toBe("制冷 · 24°C");
    expect(deviceIsOn(device)).toBe(true);
    device.providerState.value = "off";
    expect(sandboxDeviceStatus(device)).toBe("关闭");
    expect(deviceIsOn(device)).toBe(false);
    device.providerState.value = "unknown";
    expect(sandboxDeviceStatus(device)).toBe("状态未知");
    expect(deviceIsOn(device)).toBe(false);
  });
  it("distinguishes media pause from power-off and offline from historical state", () => {
    const device = { type: "tv", capabilities: [], providerState: { value: "paused" } };
    expect(sandboxDeviceStatus(device)).toBe("已暂停");
    expect(deviceIsOn(device)).toBe(true);
    device.online = false;
    expect(sandboxDeviceStatus(device)).toBe("离线");
    expect(deviceIsOn(device)).toBe(false);
  });
  it("reads sensor indicators without granting an execution capability", () => {
    const { home, state } = haHouseFixture();
    home.things.find(t => t.id === "entry_motion").capabilities[0].state = true;
    const house = prepareHaHouse(home, {}, state);
    const sensor = sandboxDevices(house.home, house.blueprint).find(d => d.id === "entry_motion");
    expect(sandboxDeviceStatus(sensor)).toBe("检测到");
    expect(deviceIsOn(sensor)).toBe(true);
    expect(sensor.capabilities.every(c => c.access === "read")).toBe(true);
  });
});
