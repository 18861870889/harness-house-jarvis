import { describe, expect, it, vi } from "vitest";
import { createSandboxService } from "./sandboxService.js";

const request = (commandId, input, extra = {}) => ({ commandId, sessionId: "resident", input, pose: { x: -2, z: 1 }, source: "text", ...extra });
const model = () => ({ choose: vi.fn(async ({ candidates, state }) => ({
  candidate: candidates.find((candidate) => state.includes("不要") ? candidate.id === "no_action" : candidate.actions.length && candidate.actions.every((action) => action.value === !state.startsWith("当前用户指令：关闭"))) ?? candidates.find((candidate) => candidate.id === "clarify"),
  probability: 0.95, margin: 0.9,
})) });

async function withService(test) {
  const client = model();
  const service = await createSandboxService({ client });
  try { await test(service, client); } finally { await service.close(); }
}

describe("simulation-only sandbox service", () => {
  it("derives microphone origin from validated pose and ignores camera selection", async () => {
    await withService(async (service) => {
      const result = await service.command(request("one", "开灯", { selectedRoom: "living" }));
      expect(result.result.status).toBe("executed");
      expect(result.result.actions.every((action) => action.logicalRoomId === "study")).toBe(true);
      expect(result.snapshot.mode).toBe("simulation-only");
      expect(service.runtime.kernel.adapter.getStatus().baseUrl).toBeNull();
    });
  });
  it("deduplicates retries without replacing origin timestamps or adding effects", async () => {
    await withService(async (service, client) => {
      await service.command(request("one", "打开书房射灯"));
      const retried = await service.command(request("one", "打开书房射灯"));
      expect(retried.result.replayed).toBe(true);
      expect(client.choose).toHaveBeenCalledTimes(1);
      expect(service.runtime.kernel.writes).toBe(1);
      expect(service.recording().events).toHaveLength(1);
      await expect(service.command(request("one", "打开书房射灯", { pose: { x: 2, z: -1 } }))).rejects.toThrow("command_id_conflict");
    });
  });
  it("rejects invalid positions and sources before model inference", async () => {
    await withService(async (service, client) => {
      await expect(service.command(request("one", "开灯", { pose: { x: 100, z: 0 } }))).rejects.toThrow("invalid_actor_pose");
      await expect(service.command(request("two", "开灯", { source: "ha" }))).rejects.toThrow("invalid_source");
      expect(client.choose).not.toHaveBeenCalled();
    });
  });
  it("does not assign a doorway command to an old discussion room", async () => {
    await withService(async (service) => {
      await service.command(request("one", "打开书房射灯"));
      const result = await service.command(request("two", "开灯", { pose: { x: 0, z: 0 } }));
      expect(result.result.status).toBe("needs_clarification");
      expect(service.runtime.kernel.writes).toBe(1);
    });
  });
  it("replays recordings in a separate household without changing the live sandbox", async () => {
    await withService(async (service) => {
      await service.command(request("one", "打开书房射灯"));
      const recording = service.recording();
      const before = service.snapshot();
      const replay = await service.replay(recording);
      expect(replay.results[0].matches).toBe(true);
      expect(replay.results[0].result.simulated).toBe(true);
      expect(service.snapshot()).toEqual(before);
      expect(service.runtime.kernel.writes).toBe(1);
      expect(service.recording().events).toHaveLength(1);
    });
  });
  it("rejects malformed replay data rather than accepting an imported device provider", async () => {
    await withService(async (service, client) => {
      await expect(service.replay({ version: 9, events: [] })).rejects.toThrow("invalid_recording");
      await expect(service.replay({ version: 1, blueprintVersion: 1, simulated: true, events: [{ request: request("x", "开灯", { pose: { x: 100, z: 0 } }), result: { status: "executed" } }] })).rejects.toThrow("invalid_actor_pose");
      expect(client.choose).not.toHaveBeenCalled();
    });
  });
  it("rejects incomplete, duplicated and malformed traces before replay inference", async () => {
    await withService(async (service, client) => {
      await service.command(request("one", "打开书房射灯"));
      const recording = service.recording();
      const calls = client.choose.mock.calls.length;
      await expect(service.replay({ ...recording, truncated: true })).rejects.toThrow("incomplete_recording");
      await expect(service.replay({ ...recording, events: [null] })).rejects.toThrow("invalid_recording");
      await expect(service.replay({ ...recording, events: [recording.events[0], recording.events[0]] })).rejects.toThrow("incomplete_recording");
      const missing = structuredClone(recording);
      missing.events[0].request.resumeFor = "not-in-trace";
      await expect(service.replay(missing)).rejects.toThrow("incomplete_recording");
      expect(client.choose).toHaveBeenCalledTimes(calls);
    });
  });
  it("compares concrete action values rather than only successful status", async () => {
    await withService(async (service) => {
      await service.command(request("one", "打开书房射灯"));
      const recording = service.recording();
      recording.events[0].result.actions[0].value = false;
      const replay = await service.replay(recording);
      expect(replay.results[0].matches).toBe(false);
      expect(replay.results[0].snapshot.home.things).toEqual(service.snapshot().home.things);
    });
  });
  it("does not merge the context of different residents during replay", async () => {
    await withService(async (service) => {
      await service.command(request("one", "打开书房射灯", { sessionId: "alice" }));
      await service.command(request("two", "开灯", { sessionId: "bob", pose: { x: 0, z: 0 } }));
      const replay = await service.replay(service.recording());
      expect(replay.results[1].result.status).toBe("needs_clarification");
      expect(replay.results.every((entry) => entry.matches)).toBe(true);
    });
  });
  it("keeps the house unchanged when local D1 is unavailable", async () => {
    await withService(async (service, client) => {
      client.choose.mockRejectedValue(new Error("d1_unavailable"));
      const before = service.snapshot();
      const data = await service.command(request("one", "打开书房射灯"));
      expect(data.result.status).toBe("failed");
      expect(data.snapshot.home).toEqual(before.home);
      expect(data.snapshot.effects).toBe(0);
      const retry = await service.command(request("one", "打开书房射灯"));
      expect(retry.result.replayed).toBe(true);
      expect(client.choose).toHaveBeenCalledTimes(1);
    });
  });
  it("cannot install device providers or entities from an imported trace", async () => {
    await withService(async (service) => {
      await service.command(request("one", "打开书房射灯"));
      const recording = service.recording();
      recording.provider = { id: "real", baseUrl: "http://192.168.0.1:8123", token: "untrusted-example" };
      recording.events[0].after.things[0].capabilities[0].binding.entityId = "switch.real_device";
      const replay = await service.replay(recording);
      expect(replay.results[0].result.simulated).toBe(true);
      expect(replay.results[0].snapshot.home.things[0].capabilities[0].binding.entityId).toBe("switch.demo_study_spot");
      expect(service.runtime.kernel.adapter.getStatus().baseUrl).toBeNull();
    });
  });
});
