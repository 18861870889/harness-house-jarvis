import { describe, expect, it } from "vitest";
import { HOUSE_BLUEPRINT, actorRoom, isValidActorPose, createSandboxHome } from "./houseBlueprint.js";
import { compileHcmForPlanner } from "../hcmPlanner.js";

describe("sandbox geometry and HCM contract", () => {
  it("shares stable room IDs without mutating the existing demo household", () => {
    const home = createSandboxHome();
    expect(home.spaces.map((room) => room.id).toSorted()).toEqual(HOUSE_BLUEPRINT.rooms.map((room) => room.id).toSorted());
    home.things[0].capabilities[0].state = true;
    expect(createSandboxHome().things[0].capabilities[0].state).toBe(false);
  });
  it("recomputes inventory summaries for the sample household only", () => {
    const home = createSandboxHome();
    expect(home.stats.thingCount).toBe(home.things.length);
    expect(home.stats.spaceCount).toBe(2);
    expect(home.stats.capabilityCount).toBe(home.things.reduce((count, thing) => count + thing.capabilities.length, 0));
    expect(Object.keys(home.stats.types)).not.toContain("motion_sensor");
  });
  it("distinguishes actor location from the selected camera room", () => {
    expect(actorRoom({ x: -2, z: 1 }, "living")).toBe("study");
    expect(actorRoom({ x: 2, z: -1 })).toBe("living");
    expect(actorRoom({ x: 0, z: 0 })).toBeNull();
  });
  it.each([{ x: NaN, z: 0 }, { x: 100, z: 0 }, { x: 0, z: 2 }, { x: -3.5, z: -1.8 }])("rejects impossible or obstructed actor positions: %j", (pose) => {
    expect(isValidActorPose(pose)).toBe(false);
  });
  it("keeps passage through the door open", () => {
    expect(isValidActorPose({ x: 0, z: 0 })).toBe(true);
    expect(isValidActorPose(HOUSE_BLUEPRINT.spawn)).toBe(true);
  });
  it("maps non-smart study lights to individual switch gangs", () => {
    const devices = compileHcmForPlanner(createSandboxHome());
    expect(devices.filter((device) => device.roomId === "study" && device.type === "light").map((device) => device.name)).toEqual(["书房射灯", "书房吊灯"]);
    expect(devices.some((device) => device.capabilities.some((capability) => capability.access === "execute" && capability.id === "study_unused"))).toBe(false);
  });
});
