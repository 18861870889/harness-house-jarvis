import { createD1DemoHome } from "../adapters/d1DemoAdapter.js";
import { createHcmHome } from "../hcm.js";
import { inFloor, replicaPoseIsValid } from "./replicaBlueprint.js";

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

export function isValidActorPose(pose, blueprint = HOUSE_BLUEPRINT) {
  if (!pose || ![pose.x, pose.z].every(Number.isFinite)) return false;
  if (blueprint.kind === "ha-replica") return replicaPoseIsValid(pose, blueprint);
  const r = HOUSE_BLUEPRINT.actorRadius;
  if (Math.abs(pose.x) > 5.5 - r - 0.08 || Math.abs(pose.z) > 2.8 - r - 0.08) return false;
  return !HOUSE_BLUEPRINT.colliders.some(({ center: [x, , z], size: [w, , d] }) => Math.abs(pose.x - x) < w / 2 + r - 0.015 && Math.abs(pose.z - z) < d / 2 + r - 0.015);
}

export function actorRoom(pose, blueprint = HOUSE_BLUEPRINT) {
  if (blueprint?.kind === "ha-replica") {
    if (!isValidActorPose(pose, blueprint) || blueprint.doors.some(d => Math.hypot(pose.x - d.x, pose.z - d.z) < 0.32)) return null;
    const matches = new Set(blueprint.floors.filter(f => f.roomId && inFloor(pose, f)).map(f => f.roomId));
    return matches.size === 1 ? [...matches][0] : null;
  }
  if (!isValidActorPose(pose) || Math.abs(pose.x) < 0.35) return null;
  return pose.x < 0 ? "study" : "living";
}

export function findWalkingPath(start, target, blueprint = HOUSE_BLUEPRINT) {
  if (!isValidActorPose(start, blueprint) || !isValidActorPose(target, blueprint)) return [];
  if (blueprint.kind !== "ha-replica") return start.x * target.x < 0 ? [{ x: Math.sign(start.x) * 0.65, z: 0 }, { x: Math.sign(target.x) * 0.65, z: 0 }, target] : [target];
  const step = 0.15, b = blueprint.bounds;
  const cols = Math.ceil((b.maxX - b.minX) / step) + 1, rows = Math.ceil((b.maxZ - b.minZ) / step) + 1;
  const pose = id => ({ x: b.minX + (id % cols) * step, z: b.minZ + Math.floor(id / cols) * step });
  const valid = new Uint8Array(cols * rows);
  let from = -1, to = -1, startDistance = Infinity, endDistance = Infinity;
  for (let id = 0; id < valid.length; id++) if (isValidActorPose(pose(id), blueprint)) {
    valid[id] = 1;
    const p = pose(id), a = Math.hypot(p.x - start.x, p.z - start.z), z = Math.hypot(p.x - target.x, p.z - target.z);
    if (a < startDistance) { from = id; startDistance = a; }
    if (z < endDistance) { to = id; endDistance = z; }
  }
  if (from < 0 || to < 0 || Math.max(startDistance, endDistance) > 0.23) return [];
  const previous = new Int32Array(valid.length).fill(-1), queue = [from];
  previous[from] = from;
  for (let i = 0; i < queue.length && previous[to] < 0; i++) {
    const id = queue[i], x = id % cols, z = Math.floor(id / cols);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz, next = nz * cols + nx;
      if (nx < 0 || nx >= cols || nz < 0 || nz >= rows || !valid[next] || previous[next] >= 0) continue;
      previous[next] = id; queue.push(next);
    }
  }
  if (previous[to] < 0) return [];
  const path = [target];
  for (let id = to; id !== from; id = previous[id]) path.push(pose(id));
  path.push(pose(from));
  return path.reverse();
}

export function followWalkingPath(pose, path, maximumStep) {
  // Early turns cut across a wall corner even when each grid waypoint is valid.
  while (path.length && Math.hypot(path[0].x - pose.x, path[0].z - pose.z) < 0.015) path.shift();
  if (!path.length) return { x: 0, z: 0 };
  const dx = path[0].x - pose.x, dz = path[0].z - pose.z, distance = Math.hypot(dx, dz);
  const step = Math.min(distance, maximumStep);
  return { x: dx / distance * step, z: dz / distance * step };
}

export function createSandboxHome() {
  const home = createD1DemoHome();
  const ids = new Set(HOUSE_BLUEPRINT.rooms.map((room) => room.id));
  return createHcmHome({
    provider: { ...home.provider, name: "家庭沙盒 · 内存模拟" }, syncedAt: home.syncedAt,
    spaces: home.spaces.filter((room) => ids.has(room.id)), things: home.things.filter((thing) => ids.has(thing.spaceId)),
  });
}
