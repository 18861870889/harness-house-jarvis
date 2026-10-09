import { describe, expect, it } from "vitest";
import { createWalker } from "./walker.js";

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
