import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createWalker } from "./walker.js";
import { actorRoom, findWalkingPath, followWalkingPath } from "./houseBlueprint.js";
import { buildReplicaModel } from "./replicaModel.js";
import { sandboxDevices, deviceIsOn } from "./sandboxDeviceView.js";

function disposeTree(tree, seen = new Set()) {
  tree?.traverse(node => {
    const resources = [node.geometry, ...[node.material].flat().flatMap(material => [material?.map, material])];
    for (const resource of resources) if (resource && !seen.has(resource)) { resource.dispose(); seen.add(resource); }
  });
  return seen;
}

export default function ReplicaScene({ snapshot, controls, onPose, onReady, onError, onDevice }) {
  const host = useRef(null), live = useRef(null);
  live.current = { snapshot, controls, onPose, onReady, onError, onDevice };
  const blueprint = snapshot.blueprint;
  useEffect(() => {
    let disposed = false, raf = 0, walker, model, kit;
    let pose = { ...blueprint.spawn }, frames = 0, lastPoseTime = 0, lastTime = performance.now(), stall = 0;
    let resetRevision = -1, overviewRevision = -1, teleportKey, destinationKey, focusId, goalPath = [], lastSnapshot, devices = [];
    const element = host.current, keys = new Set();
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0xeef4f2);
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); }
    catch { live.current.onError("浏览器无法创建三维画布，请检查 WebGL。"); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.12;
    renderer.domElement.setAttribute("aria-label", "可交互的三维家庭户型"); renderer.domElement.tabIndex = 0;
    element.append(renderer.domElement);
    const b = blueprint.bounds, cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 150);
    const orbit = new OrbitControls(camera, renderer.domElement);
    const overview = () => { camera.position.set(cx + 8, 15, cz + 16); orbit.target.set(cx, 0.3, cz); camera.zoom = 1; orbit.update(); camera.updateProjectionMatrix(); };
    overview(); orbit.enableDamping = true; orbit.minZoom = 0.65; orbit.maxZoom = 3.3; orbit.maxPolarAngle = Math.PI / 2.3;
    scene.add(new THREE.HemisphereLight(0xecf8ff, 0x6f8475, 1.35), new THREE.AmbientLight(0xffffff, 0.75));
    const sun = new THREE.DirectionalLight(0xfffbf1, 2.4); sun.position.set(cx - 6, 15, cz + 8); sun.target.position.set(cx, 0, cz); scene.add(sun.target);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 0.5, far: 45 }); sun.shadow.normalBias = 0.03; scene.add(sun);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial({ color: 0xeef4f2, roughness: 1 })); ground.rotation.x = -Math.PI / 2; ground.position.y = -0.25; ground.receiveShadow = true; scene.add(ground);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.31, 0.35, 40), new THREE.MeshBasicMaterial({ color: 0x168b76, transparent: true, opacity: 0.9, side: THREE.DoubleSide })); ring.rotation.x = -Math.PI / 2; scene.add(ring);
    const roomLights = blueprint.rooms.map(room => {
      const light = new THREE.PointLight(0xffd9a1, 0, 5, 1.2); light.position.set((room.minX + room.maxX) / 2, 1.95, (room.minZ + room.maxZ) / 2); scene.add(light); return { room, light };
    });
    const resize = () => {
      const { width, height } = element.getBoundingClientRect(); if (!width || !height) return;
      const aspect = width / height;
      const span = Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ) + 2;
      const vertical = Math.max(span * 0.79, span / aspect);
      camera.left = -vertical * aspect / 2; camera.right = vertical * aspect / 2; camera.top = vertical / 2; camera.bottom = -vertical / 2;
      camera.updateProjectionMatrix(); renderer.setSize(width, height);
    };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    const clearKeys = () => keys.clear();
    const keyDown = event => { if (event.target.closest?.("input,textarea,button,select,[contenteditable]")) return; if (["w", "a", "s", "d", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); keys.add(event.key); } };
    const keyUp = event => keys.delete(event.key);
    window.addEventListener("keydown", keyDown); window.addEventListener("keyup", keyUp); window.addEventListener("blur", clearKeys);
    const ray = new THREE.Raycaster(); let pointerStart;
    const pointerDown = event => { pointerStart = { x: event.clientX, y: event.clientY }; renderer.domElement.focus({ preventScroll: true }); };
    const pointerUp = event => {
      if (!pointerStart || Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 6 || live.current.controls.locked) return;
      const rect = renderer.domElement.getBoundingClientRect(); ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
      const selected = model && ray.intersectObjects([...model.visualDevices.values()].map(v => v.node), true).find(hit => hit.object.userData.deviceId);
      if (selected) { live.current.onDevice?.(selected.object.userData.deviceId); return; }
      const hit = new THREE.Vector3();
      if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) goalPath = findWalkingPath(pose, { x: hit.x, z: hit.z }, blueprint);
    };
    renderer.domElement.addEventListener("pointerdown", pointerDown); renderer.domElement.addEventListener("pointerup", pointerUp);
    const animate = time => {
      if (disposed) return; raf = requestAnimationFrame(animate);
      const dt = Math.min((time - lastTime) / 1000, 0.033); lastTime = time;
      const config = live.current.controls;
      if (config.mode === "overview" && config.overviewRevision !== overviewRevision) { overview(); overviewRevision = config.overviewRevision; focusId = config.focusDeviceId; }
      if (walker && config.resetRevision !== resetRevision) { walker.reset(); pose = walker.pose(); goalPath = []; resetRevision = config.resetRevision; }
      if (walker && config.teleport?.key !== teleportKey) { if (config.teleport) { walker.reset(config.teleport.pose); pose = walker.pose(); goalPath = []; } teleportKey = config.teleport?.key; }
      if (walker && config.destination?.key !== destinationKey) { if (config.destination) goalPath = findWalkingPath(pose, config.destination.pose, blueprint); destinationKey = config.destination?.key; }
      if (walker) {
        let dx = 0, dz = 0, automatic = false;
        if (!config.locked) {
          dx = Number(keys.has("d") || keys.has("ArrowRight")) - Number(keys.has("a") || keys.has("ArrowLeft")) + (config.direction?.x ?? 0);
          dz = Number(keys.has("s") || keys.has("ArrowDown")) - Number(keys.has("w") || keys.has("ArrowUp")) + (config.direction?.z ?? 0);
          if (dx || dz) goalPath = [];
          else if (goalPath.length) { const delta = followWalkingPath(pose, goalPath, 2.1 * dt); dx = delta.x; dz = delta.z; automatic = true; }
        } else { goalPath = []; clearKeys(); }
        const length = Math.hypot(dx, dz); if (length && !automatic) { dx = dx / length * 2.1 * dt; dz = dz / length * 2.1 * dt; }
        const next = walker.move(dx, dz, dt), moved = Math.hypot(next.x - pose.x, next.z - pose.z);
        stall = length && moved < 0.001 ? stall + dt : 0; if (stall > 0.6) goalPath = []; pose = next;
        if (model) { model.avatar.position.set(pose.x, moved > 0.002 ? Math.sin(time * 0.013) * 0.01 : 0, pose.z); if (moved > 0.002) model.avatar.rotation.y = Math.atan2(dx, dz); }
        ring.position.set(pose.x, 0.025, pose.z);
        if (time - lastPoseTime > 90) { live.current.onPose({ ...pose }); lastPoseTime = time; }
      }
      if (config.mode === "follow") { orbit.enabled = false; camera.zoom += (2.4 - camera.zoom) * 0.1; camera.position.lerp(new THREE.Vector3(pose.x + 4.5, 6.5, pose.z + 6.7), 0.07); camera.lookAt(pose.x, 0.65, pose.z); camera.updateProjectionMatrix(); }
      else { if (!orbit.enabled) overview(); orbit.enabled = true; orbit.update(); }
      if (config.focusDeviceId !== focusId && model) {
        const visual = model.visualDevices.get(config.focusDeviceId);
        if (visual && config.mode !== "follow") { orbit.target.set(visual.node.position.x, 0.3, visual.node.position.z); camera.position.set(visual.node.position.x + 6, 11, visual.node.position.z + 12); camera.zoom = 1.5; camera.updateProjectionMatrix(); }
        focusId = config.focusDeviceId;
      }
      if (lastSnapshot !== live.current.snapshot) { devices = sandboxDevices(live.current.snapshot.home, blueprint); lastSnapshot = live.current.snapshot; }
      for (const device of devices) {
        const visual = model?.visualDevices.get(device.id); if (!visual) continue;
        const on = deviceIsOn(device);
        if (visual.bulb) { visual.bulb.material.emissive.set(on ? device.type === "light" ? 0xffc56d : 0x219880 : 0x000000); visual.bulb.material.emissiveIntensity = on ? 2 : 0; }
        if (visual.screen) { visual.screen.material.color.set(on ? 0x74b8c4 : 0x182224); visual.screen.material.emissive.set(on ? 0x276770 : 0x000000); }
        if (visual.fan && on) visual.fan.rotation.y += dt * (Number.isFinite(device.providerState?.percentage) ? device.providerState.percentage / 100 * 12 : 10);
        const position = device.providerState?.position ?? device.capabilities.find(c => c.domain === "cover")?.state;
        if (visual.curtains?.length && typeof position === "number") visual.curtains.forEach(({ mesh, initial }, i) => { mesh.position.x = initial + (i ? 1 : -1) * position / 100 * 0.35; });
        if (visual.rack && typeof position === "number") visual.rack.position.y = 0.75 + position / 100 * 0.75;
        if (visual.feeder && device.providerState?.feedCount) visual.feeder.material.emissive.set(0x219880);
        visual.marker.material.opacity = device.id === config.focusDeviceId ? 0.9 : 0;
      }
      for (const { room, light } of roomLights) light.intensity = Math.min(16, devices.filter(d => d.roomId === room.id && d.type === "light" && d.online !== false && deviceIsOn(d)).length * 6);
      renderer.render(scene, camera); frames++;
    };
    raf = requestAnimationFrame(animate);
    Promise.allSettled([new GLTFLoader().loadAsync("/sandbox/furniture-kit.glb"), new THREE.TextureLoader().loadAsync("/sandbox/ash-grain.png"), createWalker(blueprint.spawn, blueprint)]).then(([asset, grain, physics]) => {
      kit = asset.status === "fulfilled" ? asset.value.scene : null;
      const texture = grain.status === "fulfilled" ? grain.value : null;
      const world = physics.status === "fulfilled" ? physics.value : null;
      if (disposed || !kit || !texture || !world) { world?.close(); disposeTree(kit); texture?.dispose(); if (!disposed) live.current.onError(asset.reason?.message ?? grain.reason?.message ?? physics.reason?.message ?? "房屋载入失败。"); return; }
      walker = world; model = buildReplicaModel(blueprint, kit, texture); scene.add(model.root, model.avatar);
      window.__sandboxScene = {
        stats: () => ({ ready: true, frames, drawCalls: renderer.info.render.calls, pose: { ...pose }, room: actorRoom(pose, blueprint), kind: "ha-replica", blueprintId: blueprint.id, roomCount: blueprint.rooms.length, deviceCount: blueprint.devices.length, pathRemaining: goalPath.length, visual: {
          lamps: Object.fromEntries([...model.visualDevices].filter(([id]) => blueprint.lamps.some(l => l.id === id)).map(([id, v]) => [id, v.bulb.material.emissiveIntensity])),
          fanAngles: Object.fromEntries([...model.visualDevices].filter(([, v]) => v.fan).map(([id, v]) => [id, v.fan.rotation.y])),
          positions: Object.fromEntries(devices.filter(d => Number.isFinite(d.providerState?.position)).map(d => [d.id, d.providerState.position])),
        } }),
        project: (x, z) => { const p = new THREE.Vector3(x, 0, z).project(camera), r = renderer.domElement.getBoundingClientRect(); return { x: r.left + (p.x + 1) * r.width / 2, y: r.top + (1 - p.y) * r.height / 2 }; },
      };
      live.current.onReady();
    }).catch(error => { walker?.close(); walker = null; if (!disposed) live.current.onError(error.message); });
    return () => {
      disposed = true; cancelAnimationFrame(raf); observer.disconnect(); walker?.close(); orbit.dispose();
      window.removeEventListener("keydown", keyDown); window.removeEventListener("keyup", keyUp); window.removeEventListener("blur", clearKeys);
      renderer.domElement.removeEventListener("pointerdown", pointerDown); renderer.domElement.removeEventListener("pointerup", pointerUp);
      disposeTree(kit, disposeTree(scene)); renderer.dispose(); renderer.domElement.remove(); delete window.__sandboxScene;
    };
  }, [blueprint.id]);
  return <div className="sandbox-canvas" ref={host} />;
}
