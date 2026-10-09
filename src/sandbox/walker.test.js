import { describe, expect, it } from "vitest";
import { createWalker } from "./walker.js";
import { prepareHaHouse } from "./haHouse.js";
import { haHouseFixture } from "./haHouse.fixture.js";
import { actorRoom, findWalkingPath, followWalkingPath } from "./houseBlueprint.js";

describe("Rapier sample-home walking", () => {
  it("walks through the door without penetrating a closed partition", async () => {
    const walker = await createWalker({ x: -1.5, z: 0 });
    try {
      for (let i = 0; i < 100; i++) walker.move(0.03, 0);
      expect(walker.pose().x).toBeGreaterThan(1);
      walker.reset({ x: -1.5, z: 2 });
      for (let i = 0; i < 100; i++) walker.move(0.03, 0);
      expect(walker.pose().x).toBeLessThan(-0.29);
    } finally { walker.close(); }
  });
  it("stops at furniture and rejects resets into it", async () => {
    const walker = await createWalker({ x: -3.5, z: 1 });
    try {
      for (let i = 0; i < 100; i++) walker.move(0, -0.03);
      expect(walker.pose().z).toBeGreaterThan(-0.3);
      expect(() => walker.reset({ x: -3.5, z: -1.75 })).toThrow("invalid_actor_pose");
    } finally { walker.close(); }
  });
});

describe("Rapier edited-house routing", () => {
  it("reaches every configured room without cutting corners at lower frame rates", async () => {
    const { home, state } = haHouseFixture();
    const { blueprint } = prepareHaHouse(home, {}, state);
    for (const room of blueprint.rooms) {
      const path = findWalkingPath(blueprint.spawn, blueprint.roomSpawns[room.id], blueprint);
      const walker = await createWalker(blueprint.spawn, blueprint);
      try {
        for (let i = 0; path.length && i < 3000; i++) {
          const delta = followWalkingPath(walker.pose(), path, 0.07);
          walker.move(delta.x, delta.z, 1 / 30);
        }
        expect(path, room.name).toHaveLength(0);
        expect(actorRoom(walker.pose(), blueprint)).toBe(room.id);
      } finally { walker.close(); }
    }
  });
});
