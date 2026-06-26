import React, { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { createHouseSceneModel, getSceneRoomName } from "./houseSceneModel.js";
import { deviceTypeNames, rooms } from "./simulator.js";

const roomColor = {
  entry: 0xe8f3f0,
  living: 0xf4f2eb,
  dining: 0xeaf5f1,
  kitchen: 0xf5eee6,
  study: 0xe7f2f3,
  bedroom: 0xf2eeea,
  bath: 0xe7f3f3,
  balcony: 0xe5f2e9,
  generic: 0xedf3f1,
};

const deviceOffsets = {
  entry_light: [0, 0],
  entry_motion: [0.75, -0.2],
  front_door: [-0.9, -0.55],
  living_light: [-0.5, -0.2],
  living_tv: [1.5, 0.9],
  living_curtain: [0.9, -1.25],
  living_camera: [1.78, -1.1],
  robot: [-1.25, 0.75],
  cat_feeder: [0.7, -0.6],
  kitchen_light: [0, -0.3],
  kitchen_fan: [0.62, 0.68],
  kitchen_presence: [-0.58, 0.72],
  study_light: [0, 0],
  study_ac: [0.72, 0.75],
  study_fan: [-0.68, -0.4],
  study_presence: [-0.85, 0.75],
  master_light: [-0.55, -0.25],
  master_ac: [0.82, 0.68],
  master_curtain: [0, -1.02],
  second_light: [-0.4, -0.1],
  second_ac: [0.62, 0.62],
  bath_light: [-0.3, -0.25],
  gas_heater: [0.45, 0.45],
  balcony_light: [-0.28, 0.05],
  drying_rack: [0.35, 0.65],
  washer: [-0.45, -0.62],
  dryer: [0.45, -0.62],
};

function disposeObject(object) {
  object.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (material.map) material.map.dispose();
        material.dispose();
      }
    }
  });
}

function createTextSprite(text, options = {}) {
  const {
    width = 360,
    height = 96,
    fontSize = 30,
    background = "rgba(255, 255, 255, 0.9)",
    foreground = "#183431",
    border = "rgba(55, 104, 97, 0.22)",
  } = options;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  roundRect(ctx, 0, 0, width, height, 22);
  ctx.fillStyle = background;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = border;
  ctx.stroke();
  ctx.fillStyle = foreground;
  ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lines = String(text).split("\n").slice(0, 2);
  lines.forEach((line, index) => {
    ctx.fillText(line, width / 2, height / 2 + (index - (lines.length - 1) / 2) * (fontSize + 8));
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(width / 130, height / 130, 1);
  return sprite;
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function statusForDevice(device) {
  if (device.statusLabel) return device.statusLabel;
  switch (device.type) {
    case "light":
      return device.on ? `${device.brightness}%` : "关";
    case "ac":
      return device.on ? `${device.temperature}°C` : "关";
    case "fan":
      return device.on ? `${device.speed || 1}档` : "关";
    case "curtain":
      return `${safePercent(device.position, 0)}%`;
    case "tv":
      return device.on ? "开" : "关";
    case "robot_vacuum":
      return device.status === "cleaning" ? "清扫中" : "待命";
    case "pet_feeder":
      return `${device.portionsToday}份`;
    case "gas_heater":
      return device.on ? `${device.temperature}°C` : "关";
    case "presence_sensor":
    case "motion_sensor":
      return device.detected ? "有人" : "无人";
    case "door_sensor":
      return device.open ? "开启" : "关闭";
    case "camera":
      return device.privacyMode ? "隐私" : device.on ? "开启" : "关闭";
    case "washer":
    case "dryer":
      return device.status === "running" ? `${device.minutesLeft}m` : device.status;
    case "drying_rack":
      return `${safePercent(device.position, 0)}%`;
    default:
      return "";
  }
}

function devicePosition(device) {
  if (typeof device.sceneX === "number" && typeof device.sceneZ === "number") {
    return [device.sceneX, device.sceneZ];
  }
  const room = rooms.find((item) => item.id === device.roomId);
  if (!room) return [0, 0];
  const [ox, oz] = deviceOffsets[device.id] ?? [0, 0];
  return [room.x + ox, room.z + oz];
}

function isActive(device) {
  if (device.executing || device.preview) return true;
  if (device.source === "hcm") return Boolean(device.active);
  if ("on" in device) return device.on;
  if ("detected" in device) return device.detected;
  if ("open" in device) return device.open;
  if (device.type === "robot_vacuum") return device.status === "cleaning";
  if (["washer", "dryer"].includes(device.type)) return device.status === "running";
  if (device.type === "pet_feeder") return device.portionsToday > 0;
  return false;
}

export default function ThreeHouse({ devices, sceneModel, selectedRoomId, onSelectRoom }) {
  const model = useMemo(
    () => sceneModel ?? createHouseSceneModel({ simulatorRooms: rooms, simulatorDevices: devices }),
    [devices, sceneModel],
  );
  const containerRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const houseGroupRef = useRef(null);
  const animatedRef = useRef([]);
  const onSelectRoomRef = useRef(onSelectRoom);
  const raycasterRef = useRef(new THREE.Raycaster());
  const pointerRef = useRef(new THREE.Vector2());

  useEffect(() => {
    onSelectRoomRef.current = onSelectRoom;
  }, [onSelectRoom]);

  useEffect(() => {
    const container = containerRef.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf2f7f5);
    scene.fog = new THREE.Fog(0xf2f7f5, 13, 30);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(44, 1, 0.1, 100);
    camera.position.set(6.8, 8.2, 7.2);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    rendererRef.current = renderer;
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enableRotate = true;
    controls.enablePan = true;
    controls.enableZoom = true;
    controls.minDistance = 7;
    controls.maxDistance = 18;
    controls.maxPolarAngle = Math.PI / 2.15;
    controls.target.set(0, 0, 0);
    controlsRef.current = controls;

    const ambient = new THREE.HemisphereLight(0xffffff, 0xc3d5d0, 2.15);
    scene.add(ambient);

    const moon = new THREE.DirectionalLight(0xfff8e8, 2.55);
    moon.position.set(5, 9, 4);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    scene.add(moon);

    const rim = new THREE.DirectionalLight(0x82d8c5, 0.72);
    rim.position.set(-7, 5, -3);
    scene.add(rim);

    const grid = new THREE.GridHelper(18, 18, 0xcadbd6, 0xe2ece9);
    grid.position.y = -0.06;
    scene.add(grid);

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    const handleClick = (event) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointerRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointerRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycasterRef.current.setFromCamera(pointerRef.current, camera);
      const intersects = raycasterRef.current.intersectObjects(scene.children, true);
      const roomHit = intersects.find((hit) => hit.object.userData?.roomId);
      if (roomHit) onSelectRoomRef.current?.(roomHit.object.userData.roomId);
    };
    renderer.domElement.addEventListener("click", handleClick);

    let frameId = 0;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      const time = performance.now() / 1000;
      for (const item of animatedRef.current) {
        if (item.kind === "fan" && item.active) item.object.rotation.y += 0.16;
        if (item.kind === "sensor" && item.active) {
          const scale = 1 + Math.sin(time * 4) * 0.12;
          item.object.scale.set(scale, scale, scale);
        }
        if (item.kind === "robot" && item.active) {
          item.object.position.x += Math.sin(time * 1.8) * 0.003;
          item.object.position.z += Math.cos(time * 1.6) * 0.003;
          item.object.rotation.y += 0.03;
        }
        if (item.kind === "light" && item.active) {
          item.object.material.emissiveIntensity = 1.2 + Math.sin(time * 3) * 0.08;
        }
      }
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frameId);
      renderer.domElement.removeEventListener("click", handleClick);
      resizeObserver.disconnect();
      controls.dispose();
      disposeObject(scene);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (houseGroupRef.current) {
      scene.remove(houseGroupRef.current);
      disposeObject(houseGroupRef.current);
    }

    animatedRef.current = [];
    const house = new THREE.Group();
    house.name = "harness-house-model";
    scene.add(house);
    houseGroupRef.current = house;

    addRooms(house, model.rooms, selectedRoomId);
    addFurniture(house, model.rooms);
    addDevices(house, model.devices, selectedRoomId, animatedRef.current);
  }, [model, selectedRoomId]);

  return (
    <div className="scene-shell" ref={containerRef}>
      <div className="scene-hud">
        <span>{model.source === "hcm" ? "3D HCM House" : "3D Simulated House"}</span>
        <strong>{selectedRoomId ? getSceneRoomName(selectedRoomId, model.rooms) : "全屋"}</strong>
      </div>
      <div className="scene-controls-hint">拖拽旋转 · 滚轮缩放 · 右键平移</div>
    </div>
  );
}

function addRooms(group, sceneRooms, selectedRoomId) {
  for (const room of sceneRooms) {
    const active = room.selected ?? room.id === selectedRoomId;
    const occupied = Boolean(room.occupied);
    const alert = room.layers?.includes("alert");
    const preview = room.layers?.includes("preview");
    const executing = room.layers?.includes("execution");
    const floorMaterial = new THREE.MeshStandardMaterial({
      color: active ? 0xcce9e2 : alert ? 0xf2d6d2 : roomColor[room.type] ?? 0xedf3f1,
      roughness: 0.78,
      metalness: 0.02,
      emissive: active ? 0x78bcae : alert ? 0xd88982 : preview ? 0x69b9aa : executing ? 0xd7a044 : 0x000000,
      emissiveIntensity: active || alert || preview || executing ? 0.08 : 0,
    });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(room.width, 0.1, room.depth), floorMaterial);
    floor.position.set(room.x, 0, room.z);
    floor.receiveShadow = true;
    floor.userData.roomId = room.id;
    group.add(floor);

    addWalls(group, room, active);

    const label = createTextSprite(room.name, {
      width: 240,
      height: 70,
      fontSize: 30,
      background: active ? "rgba(219, 242, 236, 0.95)" : "rgba(255, 255, 255, 0.9)",
      foreground: active ? "#126f65" : "#314b47",
      border: active ? "rgba(22, 143, 131, 0.48)" : "rgba(55, 104, 97, 0.2)",
    });
    label.position.set(room.x, 0.92, room.z);
    group.add(label);

    if (occupied) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.36, 0.02, 12, 48),
        new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.82 }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.set(room.x - room.width * 0.33, 0.14, room.z + room.depth * 0.32);
      group.add(ring);
    }

    if (!occupied && room.presence) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.28, 0.014, 12, 40),
        new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.28 }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.set(room.x - room.width * 0.33, 0.14, room.z + room.depth * 0.32);
      group.add(ring);
    }

    if (executing || preview || alert) addRoomLayerBadge(group, room, { executing, preview, alert });
  }
}

function addRoomLayerBadge(group, room, { executing, preview, alert }) {
  const color = alert ? 0xef4444 : executing ? 0xf59e0b : 0x2dd4bf;
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(Math.min(room.width, room.depth) * 0.34, 0.025, 12, 72),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.78 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.set(room.x, 0.18, room.z);
  group.add(ring);
}

function addWalls(group, room, active) {
  const material = new THREE.MeshStandardMaterial({
    color: active ? 0xb7dfd6 : 0xf9fcfb,
    transparent: true,
    opacity: active ? 0.62 : 0.48,
    roughness: 0.72,
    metalness: 0.01,
  });
  const wallHeight = 0.75;
  const wallThickness = 0.07;
  const segments = [
    [room.width, wallThickness, 0, -room.depth / 2],
    [room.width, wallThickness, 0, room.depth / 2],
    [wallThickness, room.depth, -room.width / 2, 0],
    [wallThickness, room.depth, room.width / 2, 0],
  ];
  for (const [w, d, ox, oz] of segments) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, wallHeight, d), material.clone());
    wall.position.set(room.x + ox, wallHeight / 2, room.z + oz);
    wall.castShadow = true;
    wall.userData.roomId = room.id;
    group.add(wall);
  }
}

function addFurniture(group, sceneRooms) {
  const roomById = new Map(sceneRooms.map((room) => [room.id, room]));
  const materials = {
    bed: new THREE.MeshStandardMaterial({ color: 0xe6ddd3, roughness: 0.84 }),
    sofa: new THREE.MeshStandardMaterial({ color: 0xa9cec5, roughness: 0.86 }),
    table: new THREE.MeshStandardMaterial({ color: 0xcfae89, roughness: 0.8 }),
    wood: new THREE.MeshStandardMaterial({ color: 0xb98d67, roughness: 0.82 }),
  };
  const living = roomById.get("living");
  const dining = roomById.get("dining");
  const master = roomById.get("master");
  const second = roomById.get("second");
  const catRoom = roomById.get("cat_room");
  const kitchen = roomById.get("kitchen");

  if (living) {
    addBox(group, [1.8, 0.22, 0.68], [living.x - 0.3, 0.16, living.z - 0.8], materials.sofa);
    addBox(group, [0.9, 0.16, 0.55], [living.x - 0.35, 0.13, living.z], materials.table);
    addBox(group, [0.95, 0.55, 0.18], [living.x + living.width * 0.32, 0.32, living.z + 0.2], materials.wood);
  }
  if (dining) addBox(group, [1.0, 0.15, 0.65], [dining.x, 0.14, dining.z], materials.table);
  if (master) addBox(group, [1.55, 0.18, 1.05], [master.x, 0.14, master.z + 0.05], materials.bed);
  if (second) addBox(group, [1.25, 0.18, 0.95], [second.x, 0.14, second.z + 0.05], materials.bed);
  if (catRoom) addBox(group, [1.2, 0.16, 0.82], [catRoom.x - 0.15, 0.13, catRoom.z + 0.25], materials.bed);
  if (kitchen) addBox(group, [0.55, 0.44, 1.5], [kitchen.x - kitchen.width * 0.25, 0.25, kitchen.z], materials.wood);
}

function addBox(group, size, position, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

function addDevices(group, devices, selectedRoomId, animated) {
  for (const device of Object.values(devices)) {
    const [x, z] = devicePosition(device);
    const active = isActive(device);
    const color = device.alert
      ? 0xef4444
      : device.executing
        ? 0xf59e0b
        : device.preview
          ? 0x2dd4bf
          : active
            ? 0xfbbf24
            : device.risk === "high"
              ? 0xef4444
              : 0x94a3b8;

    if (device.type === "light") {
      addLightDevice(group, device, x, z, animated);
    } else if (device.type === "fan") {
      addFanDevice(group, device, x, z, animated);
    } else if (device.type === "curtain") {
      addCurtainDevice(group, device, x, z);
    } else if (device.type === "tv") {
      addTvDevice(group, device, x, z);
    } else if (device.type === "ac") {
      addPanelDevice(group, device, x, z, 0x7dd3fc);
    } else if (device.type === "switch_panel") {
      addPanelDevice(group, device, x, z, 0xfbbf24);
    } else if (device.type === "hub") {
      addPanelDevice(group, device, x, z, 0x5eead4);
    } else if (device.type === "scale") {
      addPanelDevice(group, device, x, z, 0xc4b5fd);
    } else if (device.type === "robot_vacuum") {
      addRobotDevice(group, device, x, z, animated);
    } else if (device.type === "camera") {
      addCameraDevice(group, device, x, z);
    } else {
      addGenericDevice(group, device, x, z, color, animated);
    }

    if (shouldShowDeviceLabel(device, active, selectedRoomId)) {
      const label = createTextSprite(`${device.name}\n${statusForDevice(device)}`, {
        width: 250,
        height: 72,
        fontSize: 20,
        background: active ? "rgba(255, 247, 220, 0.96)" : "rgba(255, 255, 255, 0.92)",
        foreground: active ? "#8b5d12" : "#314b47",
        border: active ? "rgba(201, 130, 22, 0.54)" : "rgba(55, 104, 97, 0.24)",
      });
      label.scale.multiplyScalar(0.82);
      label.position.set(x, 1.1, z);
      group.add(label);
    }

    if (device.executing || device.preview || device.alert) addDeviceLayerRing(group, device, x, z);
  }
}

function addDeviceLayerRing(group, device, x, z) {
  const color = device.alert ? 0xef4444 : device.executing ? 0xf59e0b : 0x2dd4bf;
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.3, 0.018, 12, 44),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.84 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.set(x, 0.08, z);
  group.add(ring);
}

function shouldShowDeviceLabel(device, active, selectedRoomId) {
  if (device.roomId === selectedRoomId) return true;
  if (device.executing || device.preview || device.alert) return true;
  if (device.risk === "high") return true;
  if (!active) return false;
  return ["light", "ac", "fan", "curtain", "tv", "robot_vacuum", "pet_feeder"].includes(device.type);
}

function addLightDevice(group, device, x, z, animated) {
  const active = device.on;
  const bulbMaterial = new THREE.MeshStandardMaterial({
    color: active ? 0xfff2ad : 0x718096,
    emissive: active ? 0xffa726 : 0x000000,
    emissiveIntensity: active ? 1.2 : 0,
    roughness: 0.28,
  });
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.16, 24, 24), bulbMaterial);
  bulb.position.set(x, 0.55, z);
  bulb.castShadow = true;
  group.add(bulb);
  animated.push({ kind: "light", object: bulb, active });

  if (active) {
    const light = new THREE.PointLight(0xffb74d, Math.max(0.6, safeNumber(device.brightness, 60) / 60), 3.2);
    light.position.set(x, 1.1, z);
    group.add(light);
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.58, 32, 32),
      new THREE.MeshBasicMaterial({ color: 0xffb84d, transparent: true, opacity: 0.12 }),
    );
    glow.position.set(x, 0.5, z);
    group.add(glow);
  }
}

function addFanDevice(group, device, x, z, animated) {
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.025, 0.4, 12),
    new THREE.MeshStandardMaterial({ color: 0x94a3b8 }),
  );
  pole.position.set(x, 0.32, z);
  group.add(pole);

  const hub = new THREE.Group();
  hub.position.set(x, 0.6, z);
  for (let i = 0; i < 3; i += 1) {
    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.025, 0.075),
      new THREE.MeshStandardMaterial({ color: device.on ? 0x67e8f9 : 0x64748b, roughness: 0.45 }),
    );
    blade.position.x = 0.2;
    blade.rotation.y = (Math.PI * 2 * i) / 3;
    hub.add(blade);
  }
  group.add(hub);
  animated.push({ kind: "fan", object: hub, active: device.on });
}

function addCurtainDevice(group, device, x, z) {
  const openness = safePercent(device.position, 0) / 100;
  const rail = new THREE.Mesh(
    new THREE.BoxGeometry(1.35, 0.04, 0.05),
    new THREE.MeshStandardMaterial({ color: 0xd1d5db }),
  );
  rail.position.set(x, 0.78, z);
  group.add(rail);

  const curtainWidth = Math.max(0.12, 0.64 * (1 - openness));
  const material = new THREE.MeshStandardMaterial({
    color: 0x60a5fa,
    transparent: true,
    opacity: 0.72,
    roughness: 0.62,
  });
  const left = new THREE.Mesh(new THREE.BoxGeometry(curtainWidth, 0.55, 0.035), material);
  const right = new THREE.Mesh(new THREE.BoxGeometry(curtainWidth, 0.55, 0.035), material.clone());
  left.position.set(x - 0.38, 0.48, z);
  right.position.set(x + 0.38, 0.48, z);
  group.add(left, right);
}

function safeNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function safePercent(value, fallback) {
  return Math.max(0, Math.min(100, safeNumber(value, fallback)));
}

function addTvDevice(group, device, x, z) {
  const screen = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.44, 0.05),
    new THREE.MeshStandardMaterial({
      color: device.on ? 0x38bdf8 : 0x020617,
      emissive: device.on ? 0x0ea5e9 : 0x000000,
      emissiveIntensity: device.on ? 0.8 : 0,
      roughness: 0.22,
    }),
  );
  screen.position.set(x, 0.48, z);
  group.add(screen);
}

function addPanelDevice(group, device, x, z, accent) {
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.52, 0.26, 0.16),
    new THREE.MeshStandardMaterial({
      color: device.on ? accent : 0x475569,
      emissive: device.on ? accent : 0x000000,
      emissiveIntensity: device.on ? 0.24 : 0,
      roughness: 0.44,
    }),
  );
  body.position.set(x, 0.42, z);
  body.castShadow = true;
  group.add(body);
}

function addRobotDevice(group, device, x, z, animated) {
  const robot = new THREE.Mesh(
    new THREE.CylinderGeometry(0.25, 0.25, 0.12, 36),
    new THREE.MeshStandardMaterial({
      color: device.status === "cleaning" ? 0x22c55e : 0x64748b,
      roughness: 0.36,
      metalness: 0.25,
    }),
  );
  robot.position.set(x, 0.13, z);
  robot.castShadow = true;
  group.add(robot);
  animated.push({ kind: "robot", object: robot, active: device.status === "cleaning" });
}

function addCameraDevice(group, device, x, z) {
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.2, 0.22),
    new THREE.MeshStandardMaterial({
      color: device.privacyMode ? 0x475569 : 0x111827,
      emissive: device.on && !device.privacyMode ? 0x22d3ee : 0x000000,
      emissiveIntensity: device.on && !device.privacyMode ? 0.45 : 0,
    }),
  );
  body.position.set(x, 0.5, z);
  group.add(body);
  const lens = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 16, 16),
    new THREE.MeshBasicMaterial({ color: device.on && !device.privacyMode ? 0x67e8f9 : 0x334155 }),
  );
  lens.position.set(x, 0.5, z - 0.13);
  group.add(lens);
}

function addGenericDevice(group, device, x, z, color, animated) {
  const active = isActive(device);
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.16, 0.18, 24),
    new THREE.MeshStandardMaterial({
      color,
      emissive: active ? color : 0x000000,
      emissiveIntensity: active ? 0.25 : 0,
      roughness: 0.48,
    }),
  );
  mesh.position.set(x, 0.18, z);
  mesh.castShadow = true;
  group.add(mesh);

  if (["presence_sensor", "motion_sensor", "door_sensor"].includes(device.type)) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.27, 0.018, 12, 36),
      new THREE.MeshBasicMaterial({
        color: active ? 0x38bdf8 : 0x64748b,
        transparent: true,
        opacity: active ? 0.8 : 0.4,
      }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, 0.27, z);
    group.add(ring);
    animated.push({ kind: "sensor", object: ring, active });
  }
}
