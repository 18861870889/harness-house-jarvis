import { pointInPolygon } from "../spatialHomeEditor.js";

const round = n => Math.round(n * 10000) / 10000;
export const inFloor = (pose, floor) => pointInPolygon(floor.points.map(p => ({ x: p.x, y: p.z })), pose.x, pose.z);
export const onHouseFloor = (pose, blueprint) => blueprint.floors.some(f => inFloor(pose, f));

export function replicaPoseIsValid(pose, blueprint) {
  const r = blueprint.actorRadius + 0.025;
  if (!onHouseFloor(pose, blueprint)) return false;
  if (![[r, 0], [-r, 0], [0, r], [0, -r]].every(([x, z]) => onHouseFloor({ x: pose.x + x, z: pose.z + z }, blueprint))) return false;
  return !blueprint.colliders.some(({ center: [x, , z], size: [w, , d], rotation = 0 }) => {
    const dx = pose.x - x, dz = pose.z - z;
    return Math.abs(Math.cos(rotation) * dx - Math.sin(rotation) * dz) < w / 2 + r && Math.abs(Math.sin(rotation) * dx + Math.cos(rotation) * dz) < d / 2 + r;
  });
}

export function createReplicaBlueprint(scene, state) {
  const aspect = state.floorPlanImageAspectRatio ?? 1;
  const width = 14, depth = width / aspect;
  const point = (x, y) => ({ x: round((x / 100 - 0.5) * width), z: round((y / 100 - 0.5) * depth) });
  const floors = [], rooms = [], warnings = [];
  const rectPoints = rect => [point(rect.left, rect.top), point(rect.left + rect.width, rect.top), point(rect.left + rect.width, rect.top + rect.height), point(rect.left, rect.top + rect.height)];
  for (const room of scene.rooms) {
    if (room.id === "unknown") continue;
    const shapes = room.polygon?.length >= 3 ? [room.polygon.map(p => point(p.x, p.y))]
      : (room.allMapRects ?? [room.mapRect]).map(rectPoints);
    if (!shapes.length || shapes.some(s => s.some(p => ![p.x, p.z].every(Number.isFinite)))) throw new Error("invalid_house_geometry");
    const points = shapes.flat();
    const bounds = { minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)), minZ: Math.min(...points.map(p => p.z)), maxZ: Math.max(...points.map(p => p.z)) };
    const normalized = { id: room.id, name: room.name, type: room.type, ...bounds, calibrated: room.spatialSource === "editor" };
    rooms.push(normalized);
    shapes.forEach((points, index) => floors.push({ id: `${room.id}-${index}`, roomId: room.id, type: room.type, points }));
    if (!normalized.calibrated) warnings.push({ code: "estimated_room", roomId: room.id });
  }
  if (!rooms.length) throw new Error("invalid_house_geometry");
  const doors = [];
  for (const [i, a] of rooms.entries()) for (const b of rooms.slice(i + 1)) {
    const overlapX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
    const overlapZ = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
    const gapX = Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX);
    const gapZ = Math.max(a.minZ, b.minZ) - Math.min(a.maxZ, b.maxZ);
    let door;
    if (gapX >= -0.08 && gapX <= 0.35 && overlapZ >= 0.85) door = { axis: "x", x: (Math.max(a.minX, b.minX) + Math.min(a.maxX, b.maxX)) / 2, z: (Math.max(a.minZ, b.minZ) + Math.min(a.maxZ, b.maxZ)) / 2, width: Math.min(1.1, overlapZ - 0.08), gap: Math.max(gapX, 0) };
    else if (gapZ >= -0.08 && gapZ <= 0.35 && overlapX >= 0.85) door = { axis: "z", x: (Math.max(a.minX, b.minX) + Math.min(a.maxX, b.maxX)) / 2, z: (Math.max(a.minZ, b.minZ) + Math.min(a.maxZ, b.maxZ)) / 2, width: Math.min(1.1, overlapX - 0.08), gap: Math.max(gapZ, 0) };
    if (!door) continue;
    doors.push({ ...door, rooms: [a.id, b.id], inferred: true });
    const w = door.axis === "x" ? door.gap + 0.12 : door.width;
    const d = door.axis === "z" ? door.gap + 0.12 : door.width;
    floors.push({ id: `passage-${a.id}-${b.id}`, roomId: null, type: "passage", points: [{ x: door.x - w / 2, z: door.z - d / 2 }, { x: door.x + w / 2, z: door.z - d / 2 }, { x: door.x + w / 2, z: door.z + d / 2 }, { x: door.x - w / 2, z: door.z + d / 2 }] });
  }
  const walls = [];
  const seen = new Set();
  for (const floor of floors.filter(f => f.roomId)) {
    for (const [i, start] of floor.points.entries()) {
      const end = floor.points[(i + 1) % floor.points.length];
      const length = Math.hypot(end.x - start.x, end.z - start.z);
      const count = Math.ceil(length / 0.16);
      let run = null;
      const flush = () => { if (run) { walls.push(run); run = null; } };
      for (let j = 0; j < count; j++) {
        const p = { x: start.x + (end.x - start.x) * (j + 0.5) / count, z: start.z + (end.z - start.z) * (j + 0.5) / count };
        const inSamePart = floors.some(f => f !== floor && f.roomId === floor.roomId && inFloor(p, f));
        const inDoor = doors.some(d => d.rooms.includes(floor.roomId) && (d.axis === "x" ? Math.abs(p.x - d.x) < 0.3 && Math.abs(p.z - d.z) < d.width / 2 : Math.abs(p.z - d.z) < 0.3 && Math.abs(p.x - d.x) < d.width / 2));
        if (inSamePart || inDoor) { flush(); continue; }
        const segmentStart = { x: start.x + (end.x - start.x) * j / count, z: start.z + (end.z - start.z) * j / count };
        const segmentEnd = { x: start.x + (end.x - start.x) * (j + 1) / count, z: start.z + (end.z - start.z) * (j + 1) / count };
        if (run) run.end = segmentEnd;
        else run = { start: segmentStart, end: segmentEnd, roomId: floor.roomId };
      }
      flush();
    }
  }
  const colliders = [];
  for (const wall of walls) {
    const x = (wall.start.x + wall.end.x) / 2, z = (wall.start.z + wall.end.z) / 2;
    const key = `${x.toFixed(2)}-${z.toFixed(2)}-${Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z).toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    colliders.push({ id: `wall-${colliders.length}`, center: [x, 1.25, z], size: [Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z), 2.5, 0.08], rotation: -Math.atan2(wall.end.z - wall.start.z, wall.end.x - wall.start.x) });
  }
  const furniture = [];
  for (const room of rooms) {
    const w = room.maxX - room.minX, d = room.maxZ - room.minZ;
    const x = (room.minX + room.maxX) / 2, z = (room.minZ + room.maxZ) / 2;
    const add = (kit, px, pz, size, rotation = 0) => {
      const scale = Math.min(1, (w - 0.55) / size[0], (d - 1.15) / size[1]);
      if (scale < 0.4) return;
      const fw = size[0] * scale, fd = size[1] * scale;
      const candidates = [{ x: px, z: pz }, ...[room.minX + fw / 2 + 0.12, room.maxX - fw / 2 - 0.12].flatMap(x => [room.minZ + fd / 2 + 0.12, room.maxZ - fd / 2 - 0.12].map(z => ({ x, z })))];
      const position = candidates.find(p => {
        if (doors.some(door => Math.abs(door.x - p.x) < fw / 2 + 0.36 && Math.abs(door.z - p.z) < fd / 2 + 0.36)) return false;
        if (colliders.filter(c => !c.id.startsWith("wall-")).some(c => Math.abs(c.center[0] - p.x) < c.size[0] / 2 + fw / 2 + 0.05 && Math.abs(c.center[2] - p.z) < c.size[2] / 2 + fd / 2 + 0.05)) return false;
        return [[-fw / 2, -fd / 2], [fw / 2, -fd / 2], [fw / 2, fd / 2], [-fw / 2, fd / 2]].every(([x, z]) => floors.some(f => f.roomId === room.id && inFloor({ x: p.x + x, z: p.z + z }, f)));
      });
      if (!position) return;
      const item = { id: `${room.id}-${kit}-${furniture.length}`, kit, roomId: room.id, position: [position.x, 0, position.z], scale, rotation };
      const footprint = { id: item.id, center: [position.x, 0.5, position.z], size: [fw, 1, fd] };
      furniture.push(item); colliders.push(footprint);
    };
    if (room.type === "study") {
      add("desk", x, room.minZ + 0.65, [2.05, 0.86]);
      add("chair", x - 0.5, room.minZ + 1.45, [0.6, 0.6]);
      add("bookshelf", room.maxX - 0.34, z, [0.5, 1.95]);
    } else if (room.type === "living") {
      add("sofa", x, room.maxZ - 0.65, [3.1, 0.95]);
      add("coffee_table", x, room.maxZ - 2.2, [1.45, 0.85]);
      add("plant", room.minX + 0.38, room.maxZ - 0.45, [0.4, 0.4]);
    } else if (room.type === "bedroom") add("bed", x, room.maxZ - Math.min(1.4, d * 0.32), [2.15, 2.7]);
    else if (room.type === "dining") add("dining", x, z - 0.5, [1.65, 1.15]);
    else if (room.type === "kitchen") add("kitchen", x, room.minZ + 0.48, [1.7, 0.62]);
    else if (room.type === "bath") add("vanity", x, room.minZ + 0.35, [1.25, 0.52]);
  }
  const blueprint = { version: 2, kind: "ha-replica", units: "estimated-meters", name: "我的家", actorRadius: 0.22, rooms, floors, walls, doors, colliders, furniture, roomSpawns: {}, warnings, imageAspectRatio: aspect };
  for (const room of rooms) {
    const cx = (room.minX + room.maxX) / 2, cz = (room.minZ + room.maxZ) / 2;
    const candidates = [];
    for (let x = room.minX + 0.3; x < room.maxX - 0.3; x += 0.15) for (let z = room.minZ + 0.3; z < room.maxZ - 0.3; z += 0.15) {
      const pose = { x: round(x), z: round(z) };
      if (replicaPoseIsValid(pose, blueprint) && floors.some(f => f.roomId === room.id && inFloor(pose, f)) && !doors.some(d => Math.hypot(x - d.x, z - d.z) < 0.4)) candidates.push(pose);
    }
    candidates.sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz));
    if (candidates[0]) blueprint.roomSpawns[room.id] = candidates[0];
    else warnings.push({ code: "room_not_walkable", roomId: room.id });
  }
  blueprint.spawn = blueprint.roomSpawns.entry ?? blueprint.roomSpawns.study ?? Object.values(blueprint.roomSpawns)[0];
  if (!blueprint.spawn) throw new Error("house_not_walkable");
  blueprint.devices = scene.devices.map(device => {
    const placement = device.spatialPlacement;
    const room = rooms.find(r => r.id === device.roomId);
    const position = placement?.placed ? point(placement.x, placement.y) : room ? { x: (room.minX + room.maxX) / 2 + (device.sceneX - (scene.rooms.find(r => r.id === room.id)?.x ?? 0)), z: (room.minZ + room.maxZ) / 2 } : null;
    return { id: device.id, name: device.name, type: device.type, roomId: device.roomId, logicalAsset: device.logicalAsset, online: device.online, placed: Boolean(placement?.placed), position: position ? [position.x, device.type === "light" ? 2.25 : 0.9, position.z] : null };
  });
  blueprint.lamps = blueprint.devices.filter(d => d.type === "light" && d.position).map(d => ({ id: d.id, position: d.position }));
  const allPoints = floors.flatMap(f => f.points);
  blueprint.bounds = { minX: Math.min(...allPoints.map(p => p.x)), maxX: Math.max(...allPoints.map(p => p.x)), minZ: Math.min(...allPoints.map(p => p.z)), maxZ: Math.max(...allPoints.map(p => p.z)) };
  return blueprint;
}
