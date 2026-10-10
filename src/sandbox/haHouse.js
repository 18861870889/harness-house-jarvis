import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
import { fetchHomeAssistantGraph } from "../adapters/homeAssistantRegistry.js";
import { mapHomeAssistantGraphToHcm } from "../adapters/homeAssistantCatalog.js";
import { applyHcmOverlay } from "../hcmOverlay.js";
import { createHouseSceneModel } from "../houseSceneModel.js";
import { createSpatialEditorModel, createSpatialEditorState, applySpatialEditorToScene } from "../spatialHomeEditor.js";
import { createHcmHome } from "../hcm.js";
import { createReplicaBlueprint } from "./replicaBlueprint.js";

const pick = (object, keys) => Object.fromEntries(keys.filter(k => object?.[k] !== undefined).map(k => [k, object[k]]));
const bindingKeys = ["provider", "entityId", "domain", "platform", "deviceId", "currentState", "deviceClass", "supportedFeatures", "min", "max", "step", "min_temp", "max_temp", "unit", "options", "hvacModes", "temperature", "currentTemperature", "currentPosition", "percentage", "percentageStep", "oscillating", "volumeLevel", "volumeMuted"];
function publicCapability(capability) {
  const result = { ...pick(capability, ["id", "name", "kind", "valueType", "state", "unit", "policy"]), binding: pick(capability.binding, bindingKeys) };
  if (capability.evidence?.constraints) result.evidence = { constraints: pick(capability.evidence.constraints, ["min", "max", "step", "unit"]) };
  if (capability.kind === "config" || /密码|密钥|password|secret|token|credential/i.test(`${capability.name} ${capability.binding?.entityId}`)) {
    result.state = "redacted";
    result.binding = pick(result.binding, ["provider", "entityId", "domain", "platform", "deviceId", "deviceClass"]);
  }
  return result;
}
export const houseDigest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function prepareHaHouse(rawHome, overlay = {}, rawState = {}) {
  if (!rawHome?.things?.length || !Array.isArray(rawHome.spaces) || rawHome.provider?.id !== "home_assistant") throw new Error("invalid_ha_snapshot");
  const state = createSpatialEditorState(rawState.state ?? rawState);
  if (state.floorPlanImage && state.floorPlanCoordinateMode !== "image" && Object.keys(state.roomRects).length) throw new Error("layout_needs_calibration");
  const configured = applyHcmOverlay(rawHome, overlay);
  const home = createHcmHome({ provider: { id: "home_assistant", name: "Home Assistant · 模拟副本" }, syncedAt: configured.syncedAt,
    spaces: configured.spaces.map(s => pick(s, ["id", "name", "aliases"])),
    things: configured.things.map(t => ({ ...pick(t, ["id", "name", "type", "spaceId", "online", "aliases", "policy"]), capabilities: t.capabilities.map(publicCapability) })),
  });
  home.controlGraph = structuredClone(configured.controlGraph);
  // Layout assignments change logical loads, never their physical switch/controller identity.
  const seedScene = createHouseSceneModel({ hcmHome: configured });
  // HA inventory changes must not delete already drawn, temporarily empty rooms.
  for (const id of Object.keys(state.roomRects)) if (!seedScene.rooms.some(r => r.id === id) && !state.customRooms.some(r => r.id === id)) {
    const defaults = { study: ["书房", "study"], living: ["客厅", "living"], dining: ["餐厅", "dining"], kitchen: ["厨房", "kitchen"], master: ["主卧", "bedroom"], second: ["次卧", "bedroom"], cat_room: ["猫猫房", "bedroom"], bath: ["公共卫生间", "bath"], master_bath: ["主卧卫生间", "bath"], balcony: ["阳台", "balcony"], entry: ["入户", "entry"] };
    const [name, type] = defaults[id] ?? [id, "generic"];
    seedScene.rooms.push({ id, name: state.roomNames[id] ?? configured.spaces.find(s => s.id === id)?.name ?? name, type, x: 0, z: 0, width: 1, depth: 1 });
  }
  const spatial = createSpatialEditorModel({ hcmHome: configured, sceneModel: seedScene, state });
  const scene = applySpatialEditorToScene(seedScene, spatial);
  const roomIds = new Set(scene.rooms.map(r => r.id));
  const parentByChild = Object.fromEntries(Object.entries(state.roomGroups).flatMap(([parent, children]) => roomIds.has(parent) ? children.map(child => [child, parent]) : []));
  for (const room of scene.rooms) {
    const existing = home.spaces.find(s => s.id === room.id);
    if (existing) { existing.aliases = [...new Set([...(existing.aliases ?? []), existing.name])]; existing.name = room.name; }
    else home.spaces.push({ id: room.id, name: room.name, aliases: [] });
  }
  for (const device of spatial.devices) {
    const roomId = parentByChild[device.assignedRoomId] ?? device.assignedRoomId;
    const thing = home.things.find(t => t.id === device.id);
    const asset = home.controlGraph.assets.find(a => a.id === device.id);
    const target = asset ?? thing;
    if (!target) continue;
    if (roomId && roomIds.has(roomId)) target.spaceId = roomId;
    if (device.displayName) { target.aliases = [...new Set([...(target.aliases ?? []), target.name])]; target.name = device.displayName; }
    if (asset) {
      asset.roomName = home.spaces.find(s => s.id === asset.spaceId)?.name ?? asset.roomName;
      for (const endpoint of home.controlGraph.endpoints.filter(e => asset.endpointIds.includes(e.id))) endpoint.targetSpaceId = asset.spaceId;
    }
  }
  const blueprint = createReplicaBlueprint(scene, state);
  blueprint.catalogCount = home.things.length;
  blueprint.logicalAssetCount = home.controlGraph.assets.length;
  const baselineId = houseDigest({ things: home.things, spaces: home.spaces, graph: { ...home.controlGraph, generatedAt: undefined }, blueprint });
  blueprint.id = houseDigest(blueprint);
  return { home, blueprint, baselineId };
}

export function readOnlyHaTransports({ baseUrl, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket, signal } = {}) {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.pathname !== "/" || base.search || base.hash) throw new Error("invalid_ha_url");
  const wsUrl = `${base.origin.replace(/^http/, "ws")}/api/websocket`;
  const sockets = new Set();
  class ReadOnlySocket extends WebSocketImpl {
    constructor(url) { if (url !== wsUrl) throw new Error("ha_read_only"); super(url); sockets.add(this); this.addEventListener?.("close", () => sockets.delete(this)); }
    send(data) {
      const message = JSON.parse(data);
      if (!["auth", "config/device_registry/list", "config/entity_registry/list", "config/area_registry/list"].includes(message.type)) throw new Error("ha_read_only");
      super.send(data);
    }
  }
  return {
    WebSocketImpl: ReadOnlySocket,
    async fetchImpl(url, options = {}) {
      if (url !== `${base.origin}/api/states` || options.method && options.method !== "GET") throw new Error("ha_read_only");
      return fetchImpl(url, { ...options, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(7000)]) : AbortSignal.timeout(7000) });
    },
    close() { for (const socket of sockets) socket.close(); sockets.clear(); },
  };
}

const readJson = (path, fallback) => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
export function readSandboxSourceConfig(path = resolve("data/sandbox-source.local.json")) {
  const config = readJson(path, {});
  const directory = process.env.HARNESS_SANDBOX_SOURCE_DIRECTORY ?? config.directory;
  if (!directory && !process.env.HA_BASE_URL && !process.env.HOME_ASSISTANT_URL) return null;
  const root = resolve(directory ?? ".");
  const fileEnv = existsSync(resolve(root, ".env")) ? parseEnv(readFileSync(resolve(root, ".env"), "utf8")) : {};
  return { directory: root, connection: {
    baseUrl: process.env.HA_BASE_URL ?? process.env.HOME_ASSISTANT_URL ?? config.baseUrl ?? fileEnv.HA_BASE_URL ?? fileEnv.HOME_ASSISTANT_URL,
    token: process.env.HA_TOKEN ?? process.env.HOME_ASSISTANT_TOKEN ?? fileEnv.HA_TOKEN ?? fileEnv.HOME_ASSISTANT_TOKEN,
  } };
}

export async function createHaHouseSource({ directory, connection = {}, cachePath, spatialState, graphLoader = fetchHomeAssistantGraph, fetchImpl, WebSocketImpl, now = Date.now } = {}) {
  const path = filename => resolve(directory, filename);
  let rawHome = readJson(cachePath ?? path("home_model_cache.json"), null);
  if (!rawHome) rawHome = readJson(path("home_model_cache.json"), null);
  let current;
  let connectionState = rawHome ? "cached" : "unavailable";
  let error = connection.baseUrl && connection.token ? null : "ha_not_configured";
  let attemptedAt = null;
  let pending = null;
  let closed = false;
  const abort = new AbortController();
  const transport = connection.baseUrl && connection.token ? readOnlyHaTransports({ ...connection, fetchImpl, WebSocketImpl, signal: abort.signal }) : null;
  function prepare(raw) {
    const overlay = readJson(path("data/home-model-overlay.local.json"), {});
    const editor = spatialState ?? readJson(path("data/spatial-editor.local.json"), {});
    return prepareHaHouse(raw, overlay, editor);
  }
  if (rawHome) current = prepare(rawHome.home ?? rawHome);
  const source = {
    house: () => current ? structuredClone(current) : null,
    status: () => ({ kind: "ha", readOnly: true, connectionState, error, attemptedAt, capturedAt: current?.home.syncedAt ?? null, latestBaselineId: current?.baselineId ?? null, layout: "saved-editor", physicalDeviceCount: current?.home.things.length ?? 0, logicalAssetCount: current?.home.controlGraph.assets.length ?? 0, roomCount: current?.blueprint.rooms.length ?? 0 }),
    async refresh() {
      if (closed) throw new Error("ha_source_closed");
      if (pending) return pending;
      attemptedAt = new Date(now()).toISOString();
      connectionState = "syncing";
      pending = (async () => {
        try {
          if (rawHome) current = prepare(rawHome.home ?? rawHome);
          if (!transport) throw new Error("ha_not_configured");
          const graph = await graphLoader({ ...connection, ...transport });
          if (closed) return;
          const nextRaw = mapHomeAssistantGraphToHcm(graph);
          const next = prepare(nextRaw);
          if (cachePath) { mkdirSync(dirname(cachePath), { recursive: true }); writeFileSync(cachePath, JSON.stringify(nextRaw), { mode: 0o600 }); }
          rawHome = nextRaw; current = next; connectionState = "live"; error = null;
        } catch (failure) {
          if (closed) return;
          connectionState = current ? "cached" : "unavailable";
          error = /invalid_house|walkable|layout|JSON/.test(failure.message) ? "invalid_saved_layout"
            : failure.message === "ha_not_configured" ? failure.message : failure.cause?.code === "ENOTFOUND" ? "ha_hostname_unavailable"
              : /401|authentication/.test(failure.message) ? "ha_authentication_failed" : /timeout|timed out/i.test(failure.message) || failure.name === "TimeoutError" ? "ha_timeout" : "ha_unavailable";
        }
        return source.status();
      })().finally(() => { pending = null; });
      return pending;
    },
    close() { closed = true; abort.abort(); transport?.close(); },
  };
  if (!current) { await source.refresh(); if (!current) { source.close(); throw new Error("ha_snapshot_unavailable"); } }
  return source;
}
