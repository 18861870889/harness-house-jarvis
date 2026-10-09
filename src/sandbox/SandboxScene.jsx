import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { HOUSE_BLUEPRINT, actorRoom, isValidActorPose } from "./houseBlueprint.js";
import { createWalker } from "./walker.js";
import ReplicaScene from "./ReplicaScene.jsx";

function disposeTree(tree) {
  const disposed = new Set();
  tree.traverse((node) => {
    const resources = [node.geometry, ...[node.material].flat().flatMap((material) => [material?.map, material])];
    for (const resource of resources) if (resource && !disposed.has(resource)) { resource.dispose(); disposed.add(resource); }
  });
}

export default function SandboxScene(props) {
  return props.snapshot?.blueprint?.kind === "ha-replica" ? <ReplicaScene {...props} /> : <SampleScene {...props} />;
}

function SampleScene({ snapshot, controls, onPose, onReady, onError }) {
  const host = useRef(null);
  const live = useRef({ snapshot, controls, onPose, onReady, onError });
  live.current = { snapshot, controls, onPose, onReady, onError };
  useEffect(() => {
    let disposed = false;
    let raf = 0;
    let walker;
    let root;
    let avatar;
    let resetRevision = -1;
    let teleportKey;
    let pose = { ...HOUSE_BLUEPRINT.spawn };
    let lastPoseTime = 0;
    let goalPath = [];
    let frames = 0;
    let lastTime = performance.now();
    let stallTime = 0;
    const keys = new Set();
    const element = host.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#eef4f2");
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); }
    catch { live.current.onError("浏览器无法创建三维画布，请检查 WebGL 是否开启。"); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.domElement.setAttribute("aria-label", "可交互的三维样板房");
    renderer.domElement.tabIndex = 0;
    element.append(renderer.domElement);
    const camera = new THREE.OrthographicCamera(-7, 7, 5, -5, 0.1, 80);
    camera.position.set(9, 11, 12);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.set(0, 0.35, 0);
    orbit.enableDamping = true;
    orbit.minZoom = 0.65;
    orbit.maxZoom = 2.4;
    orbit.maxPolarAngle = Math.PI / 2.3;
    orbit.update();
    scene.add(new THREE.HemisphereLight(0xe9f7ff, 0x758779, 1.2));
    scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const sun = new THREE.DirectionalLight(0xfff8eb, 2.5);
    sun.position.set(-3, 10, 7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 7, bottom: -7, near: 0.5, far: 30 });
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial({ color: 0xeef4f2, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.37;
    ground.receiveShadow = true;
    scene.add(ground);
    const actorRing = new THREE.Mesh(new THREE.RingGeometry(0.31, 0.35, 48), new THREE.MeshBasicMaterial({ color: 0x168b76, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
    actorRing.rotation.x = -Math.PI / 2;
    actorRing.position.y = 0.042;
    scene.add(actorRing);
    const lights = HOUSE_BLUEPRINT.lamps.map((lamp) => {
      const light = lamp.target ? new THREE.SpotLight(0xffdeb0, 0, 9, Math.PI / 3, 0.55, 1) : new THREE.PointLight(0xffdfb6, 0, 7, 1);
      light.position.set(...lamp.position);
      if (lamp.target) { light.target.position.set(...lamp.target); scene.add(light.target); }
      scene.add(light);
      return { lamp, light, bulb: null };
    });
    const resize = () => {
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      const aspect = width / height;
      const vertical = Math.max(12.8, 12.8 / aspect);
      camera.left = -vertical * aspect / 2; camera.right = vertical * aspect / 2;
      camera.top = vertical / 2; camera.bottom = -vertical / 2;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    const clearKeys = () => keys.clear();
    const keyDown = (event) => {
      if (event.target.closest?.("input, textarea, button, select, [contenteditable]")) return;
      if (["w", "a", "s", "d", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) { keys.add(event.key); event.preventDefault(); }
    };
    const keyUp = (event) => keys.delete(event.key);
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", clearKeys);
    const ray = new THREE.Raycaster();
    let pointerStart;
    const pointerDown = (event) => { pointerStart = { x: event.clientX, y: event.clientY }; renderer.domElement.focus({ preventScroll: true }); };
    const pointerUp = (event) => {
      if (!pointerStart || Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 6 || live.current.controls.locked) return;
      const rect = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
      const hit = new THREE.Vector3();
      if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit) || !isValidActorPose({ x: hit.x, z: hit.z })) return;
      goalPath = pose.x * hit.x < 0 ? [{ x: Math.sign(pose.x) * 0.65, z: 0 }, { x: Math.sign(hit.x) * 0.65, z: 0 }, { x: hit.x, z: hit.z }] : [{ x: hit.x, z: hit.z }];
    };
    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointerup", pointerUp);
    const updateDevices = () => {
      if (!root) return;
      const values = Object.fromEntries((live.current.snapshot?.home.things ?? []).flatMap((thing) => thing.capabilities.map((capability) => [capability.id, capability.state])));
      for (const { lamp, light, bulb } of lights) {
        const on = values[lamp.id] === true;
        light.intensity = on ? 12 * (lamp.brightnessId ? (values[lamp.brightnessId] ?? 40) / 100 : 1) : 0;
        if (bulb) { bulb.material.emissive.set(on ? 0xffd082 : 0x000000); bulb.material.emissiveIntensity = on ? 2 : 0; }
      }
      const screen = root.getObjectByName("living_tv_screen");
      if (screen) { screen.material.color.set(values.tv_power ? 0x74b8c4 : 0x182224); screen.material.emissive.set(values.tv_power ? 0x276770 : 0x000000); }
      const position = Number(values.curtain_position ?? 50) / 100;
      const left = root.getObjectByName("living_curtain_left");
      const right = root.getObjectByName("living_curtain_right");
      if (left && right) { left.position.x = 0.6 - position * 0.32; right.position.x = 1.05 + position * 0.32; }
      return values;
    };
    const animate = (time) => {
      if (disposed) return;
      raf = requestAnimationFrame(animate);
      const dt = Math.min((time - lastTime) / 1000, 0.033);
      lastTime = time;
      const config = live.current.controls;
      if (walker && resetRevision !== config.resetRevision) { walker.reset(); pose = walker.pose(); goalPath = []; resetRevision = config.resetRevision; }
      if (walker && config.teleport && teleportKey !== config.teleport.key) { walker.reset(config.teleport.pose); pose = walker.pose(); goalPath = []; teleportKey = config.teleport.key; }
      if (walker) {
        let dx = 0, dz = 0;
        if (!config.locked) {
          dx = Number(keys.has("d") || keys.has("ArrowRight")) - Number(keys.has("a") || keys.has("ArrowLeft")) + (config.direction?.x ?? 0);
          dz = Number(keys.has("s") || keys.has("ArrowDown")) - Number(keys.has("w") || keys.has("ArrowUp")) + (config.direction?.z ?? 0);
          if (dx || dz) goalPath = [];
          else if (goalPath.length) {
            const target = goalPath[0]; dx = target.x - pose.x; dz = target.z - pose.z;
            if (Math.hypot(dx, dz) < 0.09) { goalPath.shift(); dx = 0; dz = 0; }
          }
        } else { goalPath = []; clearKeys(); }
        const length = Math.hypot(dx, dz);
        if (length) { dx = dx / length * 2.1 * dt; dz = dz / length * 2.1 * dt; }
        const next = walker.move(dx, dz, dt);
        const moved = Math.hypot(next.x - pose.x, next.z - pose.z);
        stallTime = length && moved < 0.001 ? stallTime + dt : 0;
        if (stallTime > 0.5) goalPath = [];
        pose = next;
        if (avatar) {
          avatar.position.set(pose.x, moved > 0.002 ? Math.sin(time * 0.013) * 0.012 : 0, pose.z);
          if (moved > 0.002) avatar.rotation.y = Math.atan2(dx, dz);
        }
        actorRing.position.set(pose.x, 0.042, pose.z);
        if (time - lastPoseTime > 90) { live.current.onPose({ ...pose }); lastPoseTime = time; }
        if (config.mode === "follow") {
          orbit.enabled = false;
          camera.zoom += (1.9 - camera.zoom) * 0.1;
          camera.position.lerp(new THREE.Vector3(pose.x + 4.5, 6.5, pose.z + 6.7), 0.07);
          camera.lookAt(pose.x, 0.65, pose.z);
          camera.updateProjectionMatrix();
        } else {
          if (!orbit.enabled) { camera.position.set(9, 11, 12); orbit.target.set(0, 0.35, 0); camera.zoom = 1; camera.updateProjectionMatrix(); }
          orbit.enabled = true; orbit.update();
        }
      }
      const values = updateDevices();
      const rotor = root?.getObjectByName("fan_rotor");
      if (rotor && values?.fan_power) rotor.rotation.y += dt * 10;
      renderer.render(scene, camera);
      frames += 1;
    };
    raf = requestAnimationFrame(animate);
    Promise.allSettled([new GLTFLoader().loadAsync("/sandbox/house.glb"), createWalker()]).then(([asset, physicsResult]) => {
      const gltf = asset.status === "fulfilled" ? asset.value : null;
      const physics = physicsResult.status === "fulfilled" ? physicsResult.value : null;
      if (disposed || !gltf || !physics) {
        physics?.close(); if (gltf) disposeTree(gltf.scene);
        if (!disposed) live.current.onError(asset.reason?.message ?? physicsResult.reason?.message ?? "房屋载入失败。");
        return;
      }
      walker = physics;
      root = gltf.scene;
      root.traverse((node) => { if (node.isMesh) { node.castShadow = true; node.receiveShadow = true; node.material = node.material.clone(); } });
      scene.add(root);
      const modelAvatar = root.getObjectByName("avatar");
      if (!modelAvatar) throw new Error("missing_avatar_asset");
      scene.attach(modelAvatar);
      avatar = new THREE.Group(); avatar.add(modelAvatar); scene.add(avatar);
      modelAvatar.position.set(0, 0, 0);
      for (const entry of lights) entry.bulb = root.getObjectByName(entry.lamp.bulbName);
      window.__sandboxScene = {
        stats: () => ({ ready: true, frames, drawCalls: renderer.info.render.calls, pose: { ...pose }, room: actorRoom(pose), visual: {
          lamps: Object.fromEntries(lights.map(({ lamp, light }) => [lamp.id, light.intensity])),
          tvEmissive: root.getObjectByName("living_tv_screen")?.material.emissive.getHex(),
          fanAngle: root.getObjectByName("fan_rotor")?.rotation.y,
          curtainX: [root.getObjectByName("living_curtain_left")?.position.x, root.getObjectByName("living_curtain_right")?.position.x],
        } }),
        project: (x, z) => { const p = new THREE.Vector3(x, 0, z).project(camera); const r = renderer.domElement.getBoundingClientRect(); return { x: r.left + (p.x + 1) * r.width / 2, y: r.top + (1 - p.y) * r.height / 2 }; },
      };
      live.current.onReady();
    }).catch((error) => { walker?.close(); walker = null; if (!disposed) live.current.onError(error.message); });
    return () => {
      disposed = true; cancelAnimationFrame(raf); observer.disconnect(); walker?.close(); orbit.dispose();
      window.removeEventListener("keydown", keyDown); window.removeEventListener("keyup", keyUp); window.removeEventListener("blur", clearKeys);
      renderer.domElement.removeEventListener("pointerdown", pointerDown); renderer.domElement.removeEventListener("pointerup", pointerUp);
      disposeTree(scene);
      renderer.dispose(); renderer.domElement.remove(); delete window.__sandboxScene;
    };
  }, []);
  return <div className="sandbox-canvas" ref={host} />;
}
