import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiRuntime } from "../experiments/harnessComparison/piRuntime.js";
import { HOUSE_BLUEPRINT, actorRoom, isValidActorPose, createSandboxHome } from "./houseBlueprint.js";
import { createHash } from "node:crypto";

const validId = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id);
function validateRequest(request, blueprint) {
  if (!validId(request?.commandId) || !validId(request?.sessionId) || typeof request.input !== "string" || !request.input.trim() || request.input.length > 500 || request.resumeFor && !validId(request.resumeFor)) throw new Error("invalid_request");
  if (!isValidActorPose(request.pose, blueprint)) throw new Error("invalid_actor_pose");
  if (!["text", "voice", "replay"].includes(request.source)) throw new Error("invalid_source");
  return { sessionId: request.sessionId, commandId: request.commandId, input: request.input.trim(), pose: { x: request.pose.x, z: request.pose.z }, source: request.source, ...(request.resumeFor ? { resumeFor: request.resumeFor } : {}) };
}
const signature = (result) => JSON.stringify({ status: result.status, actions: (result.actions ?? []).map(({ logicalAssetId, thingId, capabilityId, value }) => [logicalAssetId ?? thingId, capabilityId, value]) });
function validateRecording(recording, blueprint, baselineId) {
  if (recording?.version !== (blueprint.kind === "ha-replica" ? 2 : 1) || recording.blueprintVersion !== blueprint.version || recording.simulated !== true || !Array.isArray(recording.events) || !recording.events.length || recording.events.length > 20) throw new Error("invalid_recording");
  if (blueprint.kind === "ha-replica" && recording.baselineId !== baselineId) throw new Error("recording_baseline_mismatch");
  if (recording.truncated) throw new Error("incomplete_recording");
  const seen = new Map();
  return recording.events.map((event) => {
    if (!event || typeof event.result?.status !== "string" || event.result.actions !== undefined && (!Array.isArray(event.result.actions) || event.result.actions.some((action) => !action || typeof action !== "object"))) throw new Error("invalid_recording");
    const request = validateRequest(event.request, blueprint);
    if (seen.has(request.commandId) || request.resumeFor && seen.get(request.resumeFor) !== request.sessionId) throw new Error("incomplete_recording");
    seen.set(request.commandId, request.sessionId);
    return request;
  });
}

export async function createSandboxService({ client, now = Date.now, decisionVersion = "v2", initialHome = createSandboxHome(), blueprint = HOUSE_BLUEPRINT, baselineId = createHash("sha256").update(JSON.stringify(initialHome)).digest("hex") } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "house-sandbox-"));
  let runtime;
  const baseline = structuredClone(initialHome);
  let home = structuredClone(baseline);
  let capturedAt = now();
  let busy = false;
  let closed = false;
  const identities = new Map();
  const events = [];
  let truncated = false;
  try {
    runtime = await createPiRuntime({ directory, client, initialHome: home, now, decisionVersion, terminalRooms: Object.fromEntries([...blueprint.rooms.map(r => [`sandbox-${r.id}`, r.id]), ["sandbox-doorway", null]]) });
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
  const service = {
    runtime,
    snapshot: () => structuredClone({ mode: "simulation-only", decisionVersion, blueprintVersion: blueprint.version, blueprint, baselineId, home, capturedAt, busy, effects: runtime.kernel.writes }),
    recording: () => structuredClone({ version: blueprint.kind === "ha-replica" ? 2 : 1, decisionVersion, blueprintVersion: blueprint.version, baselineId, simulated: true, truncated, events }),
    async command(raw, { signal } = {}) {
      if (closed) throw new Error("sandbox_closed");
      if (busy) throw new Error("runtime_busy");
      const request = validateRequest(raw, blueprint);
      const fingerprint = JSON.stringify(request);
      let identity = identities.get(request.commandId);
      if (identity && identity.fingerprint !== fingerprint) throw new Error("command_id_conflict");
      if (!identity) {
        if (identities.size >= 1000) throw new Error("sandbox_capacity_reached");
        const room = actorRoom(request.pose, blueprint);
        identity = { fingerprint, envelope: { sessionId: request.sessionId, commandId: request.commandId, input: request.input,
          ...(request.resumeFor ? { resumeFor: request.resumeFor } : {}), origin: { terminalId: room ? `sandbox-${room}` : "sandbox-doorway", observedAt: now() } } };
        identities.set(request.commandId, identity);
      }
      busy = true;
      const before = structuredClone(home);
      try {
        const result = await runtime.run(identity.envelope, { signal });
        home = await runtime.kernel.adapter.discoverHcmHome();
        capturedAt = now();
        if (!result.replayed) {
          events.push({ request, result, ...(blueprint.kind === "ha-replica" ? {} : { before, after: structuredClone(home) }), capturedAt });
          if (events.length > 20) { events.shift(); truncated = true; }
        }
        return { result, snapshot: { ...service.snapshot(), busy: false }, recordingCount: events.length };
      } finally { busy = false; }
    },
    async replay(recording, { signal } = {}) {
      if (closed) throw new Error("sandbox_closed");
      if (busy) throw new Error("runtime_busy");
      const requests = validateRecording(recording, blueprint, baselineId);
      busy = true;
      let isolated;
      try {
        isolated = await createSandboxService({ client, now, decisionVersion, initialHome: baseline, blueprint, baselineId });
        const mapping = new Map();
        const sessions = new Map();
        const pending = new Map();
        const results = [];
        for (const [index, request] of requests.entries()) {
          signal?.throwIfAborted();
          const id = `replay-${index}`;
          const mappedResume = request.resumeFor ? mapping.get(request.resumeFor) : undefined;
          if (request.resumeFor && !mappedResume) throw new Error("incomplete_recording");
          // A newer model may answer an old question without asking. Never
          // attach the old reply to a different or already completed proposal.
          const resumeFor = decisionVersion === "v3" && pending.get(request.sessionId) !== mappedResume ? undefined : mappedResume;
          mapping.set(request.commandId, id);
          if (!sessions.has(request.sessionId)) sessions.set(request.sessionId, `replay-session-${sessions.size}`);
          const { resumeFor: _oldResume, ...raw } = request;
          const { result } = await isolated.command({ ...raw, commandId: id, sessionId: sessions.get(request.sessionId), source: "replay", ...(resumeFor ? { resumeFor } : {}) }, { signal });
          if (result.status === "needs_clarification") pending.set(request.sessionId, id); else pending.delete(request.sessionId);
          results.push({ input: request.input, pose: request.pose, result, snapshot: isolated.snapshot(), matches: signature(result) === signature(recording.events[index].result ?? {}) });
          if (["failed", "execution_unknown", "cancelled"].includes(result.status)) break;
        }
        return { simulated: true, results };
      } finally { await isolated?.close(); busy = false; }
    },
    async close() {
      if (busy) throw new Error("runtime_busy");
      if (closed) return;
      await runtime.close();
      closed = true;
      rmSync(directory, { recursive: true, force: true });
    },
  };
  return service;
}
