import { createD1DemoHome } from "../adapters/d1DemoAdapter.js";
import { createHcmHome } from "../hcm.js";

const box = (id, center, size) => ({ id, center, size });
export const HOUSE_BLUEPRINT = {
  version: 1, units: "meters", name: "书房与客厅样板", actorRadius: 0.22,
  spawn: { x: -2, z: 1.1 },
  rooms: [
    { id: "study", name: "书房", minX: -5.5, maxX: 0, minZ: -2.8, maxZ: 2.8 },
    { id: "living", name: "客厅", minX: 0, maxX: 5.5, minZ: -2.8, maxZ: 2.8 },
  ],
  colliders: [
    box("back", [0, 1.3, -2.8], [11.2, 2.6, 0.16]),
    box("front", [0, 1.3, 2.8], [11.2, 2.6, 0.16]),
    box("left", [-5.5, 1.3, 0], [0.16, 2.6, 5.6]),
    box("right", [5.5, 1.3, 0], [0.16, 2.6, 5.6]),
    box("partition_back", [0, 1.3, -1.9], [0.16, 2.6, 1.8]),
    box("partition_front", [0, 1.3, 1.9], [0.16, 2.6, 1.8]),
    box("desk", [-3.5, 0.45, -1.75], [2.0, 0.9, 0.8]),
    box("desk_chair", [-3.5, 0.5, -0.8], [0.6, 1, 0.65]),
    box("bookcase", [-5.05, 0.7, 0], [0.5, 1.4, 2]),
    box("study_plant", [-4.8, 0.4, 2.1], [0.4, 0.8, 0.4]),
    box("sofa", [3.2, 0.5, 1.6], [3.1, 1, 0.95]),
    box("coffee_table", [3.2, 0.3, 0], [1.45, 0.6, 0.85]),
    box("tv_bench", [3.2, 0.3, -2.35], [2.8, 0.6, 0.5]),
    box("fan", [1.15, 0.7, 1.8], [0.45, 1.4, 0.45]),
  ],
  lamps: [
    { id: "study_spot", bulbName: "study_spot_bulb", position: [-3.4, 2.35, -1.3], target: [-3.4, 0.7, -1.4] },
    { id: "study_ceiling", bulbName: "study_ceiling_bulb", position: [-2.1, 2.35, 0.6] },
    { id: "living_power", bulbName: "living_bulb", position: [2.8, 2.35, -0.2], brightnessId: "living_brightness" },
  ],
};

export function isValidActorPose(pose) {
  if (!pose || ![pose.x, pose.z].every(Number.isFinite)) return false;
  const r = HOUSE_BLUEPRINT.actorRadius;
  if (Math.abs(pose.x) > 5.5 - r - 0.08 || Math.abs(pose.z) > 2.8 - r - 0.08) return false;
  return !HOUSE_BLUEPRINT.colliders.some(({ center: [x, , z], size: [w, , d] }) => Math.abs(pose.x - x) < w / 2 + r - 0.015 && Math.abs(pose.z - z) < d / 2 + r - 0.015);
}

export function actorRoom(pose) {
  if (!isValidActorPose(pose) || Math.abs(pose.x) < 0.35) return null;
  return pose.x < 0 ? "study" : "living";
}

export function createSandboxHome() {
  const home = createD1DemoHome();
  const ids = new Set(HOUSE_BLUEPRINT.rooms.map((room) => room.id));
  return createHcmHome({
    provider: { ...home.provider, name: "家庭沙盒 · 内存模拟" }, syncedAt: home.syncedAt,
    spaces: home.spaces.filter((room) => ids.has(room.id)), things: home.things.filter((thing) => ids.has(thing.spaceId)),
  });
}
