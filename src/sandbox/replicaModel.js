import * as THREE from "three";

function cloneAsset(kit, name) {
  const template = kit.getObjectByName(`kit_${name}`);
  if (!template) throw new Error(`missing_furniture_asset:${name}`);
  const clone = template.clone(true);
  clone.traverse(node => { if (node.isMesh) { node.material = node.material.clone(); node.castShadow = true; node.receiveShadow = true; } });
  return clone;
}
function roomLabel(room) {
  const canvas = document.createElement("canvas");
  canvas.width = 384; canvas.height = 80;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(250,253,251,.92)";
  ctx.roundRect(3, 3, 378, 74, 10); ctx.fill();
  ctx.font = `500 ${room.name.length > 5 ? 34 : 40}px -apple-system, PingFang SC, sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = "#416758"; ctx.fillText(room.name, 192, 41, 350);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, toneMapped: false }));
  const width = Math.min(1.9, (room.maxX - room.minX) * 0.85);
  sprite.scale.set(width, width * 80 / 384, 1);
  sprite.position.set((room.minX + room.maxX) / 2, 0.13, room.maxZ - 0.28);
  sprite.renderOrder = 4;
  return sprite;
}

export function buildReplicaModel(blueprint, kit, texture) {
  const root = new THREE.Group();
  root.name = "ha-house-replica";
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.repeat.set(0.9, 0.9);
  const wood = new THREE.MeshStandardMaterial({ color: 0xf0f2eb, map: texture, roughness: 0.85 });
  const tile = new THREE.MeshStandardMaterial({ color: 0xe3ebeb, roughness: 0.8 });
  const plaster = new THREE.MeshStandardMaterial({ color: 0xf7f8f5, roughness: 0.9 });
  for (const floor of blueprint.floors) {
    const shape = new THREE.Shape(floor.points.map(p => new THREE.Vector2(p.x, -p.z)));
    const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.15, bevelEnabled: false }), ["bath", "kitchen", "balcony"].includes(floor.type) ? tile : wood);
    mesh.rotation.x = -Math.PI / 2; mesh.position.y = -0.15; mesh.receiveShadow = true;
    root.add(mesh);
  }
  for (const wall of blueprint.walls) {
    const length = Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, 0.8, 0.09), plaster);
    mesh.position.set((wall.start.x + wall.end.x) / 2, 0.4, (wall.start.z + wall.end.z) / 2);
    mesh.rotation.y = -Math.atan2(wall.end.z - wall.start.z, wall.end.x - wall.start.x);
    mesh.castShadow = true; mesh.receiveShadow = true; root.add(mesh);
  }
  for (const furniture of blueprint.furniture) {
    const model = cloneAsset(kit, furniture.kit);
    model.position.set(...furniture.position); model.scale.setScalar(furniture.scale); model.rotation.y = furniture.rotation;
    root.add(model);
  }
  for (const room of blueprint.rooms) root.add(roomLabel(room));
  const visualDevices = new Map();
  for (const device of blueprint.devices.filter(d => d.position)) {
    const node = new THREE.Group(); node.name = `device_${device.id}`; node.userData.deviceId = device.id;
    node.position.set(...device.position);
    let bulb, fan, screen, curtains;
    if (device.type === "light") {
      const fixture = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.06, 20), plaster);
      bulb = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.035, 20), new THREE.MeshStandardMaterial({ color: 0xe6ece3, emissive: 0x000000, roughness: 0.4 }));
      bulb.position.y = -0.04; node.add(fixture, bulb);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.35, 8), new THREE.MeshStandardMaterial({ color: 0x83948d }));
      stem.position.y = 0.17; node.add(stem);
    } else if (["tv", "fan", "curtain"].includes(device.type)) {
      const model = cloneAsset(kit, device.type);
      model.scale.setScalar(device.type === "tv" ? 0.58 : device.type === "curtain" ? 0.75 : 0.8);
      node.position.y = 0; node.add(model);
      fan = model.getObjectByName("fan_rotor"); screen = model.getObjectByName("living_tv_screen");
      curtains = [model.getObjectByName("living_curtain_left"), model.getObjectByName("living_curtain_right")].filter(Boolean).map(mesh => ({ mesh, initial: mesh.position.x }));
    } else if (device.type === "ac") {
      const shell = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.24, 0.16), plaster);
      const vent = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.025, 0.018), new THREE.MeshStandardMaterial({ color: 0x5e7370 }));
      vent.position.set(0, -0.07, 0.09); node.add(shell, vent); node.position.y = 1.55;
    } else {
      const sensor = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.18, 0.1), plaster);
      bulb = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), new THREE.MeshStandardMaterial({ color: 0x879891, emissive: 0x000000 }));
      bulb.position.set(0, 0, 0.06); node.add(sensor, bulb);
    }
    const marker = new THREE.Mesh(new THREE.RingGeometry(0.14, 0.19, 24), new THREE.MeshBasicMaterial({ color: 0x418b92, transparent: true, opacity: 0, side: THREE.DoubleSide, depthTest: false }));
    marker.rotation.x = -Math.PI / 2; marker.position.y = 0.11 - node.position.y; marker.renderOrder = 3; node.add(marker);
    node.traverse(mesh => { mesh.userData.deviceId = device.id; if (mesh.isMesh) mesh.castShadow = true; });
    marker.castShadow = false;
    root.add(node);
    visualDevices.set(device.id, { node, bulb, fan, screen, curtains, marker });
  }
  const avatar = kit.getObjectByName("avatar")?.clone(true);
  if (!avatar) throw new Error("missing_avatar_asset");
  avatar.position.set(0, 0, 0);
  avatar.traverse(node => { if (node.isMesh) { node.material = node.material.clone(); node.castShadow = true; } });
  return { root, avatar, visualDevices };
}
