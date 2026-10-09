import { createD1DemoHome } from "../adapters/d1DemoAdapter.js";

export function haHouseFixture() {
  const home = createD1DemoHome();
  home.provider.name = "Home Assistant fixture";
  home.syncedAt = "2026-10-09T00:00:00.000Z";
  home.spaces.push({ id: "corridor", name: "过道", aliases: [] });
  return { home, state: {
    floorPlanCoordinateMode: "image", floorPlanImageAspectRatio: 0.8, floorPlanImageName: "fixture.jpg",
    roomRects: {
      entry: { left: 5, top: 35, width: 15, height: 15 },
      dining: { left: 5, top: 5, width: 35, height: 30 },
      study: { left: 40, top: 5, width: 35, height: 30 },
      living: { left: 20, top: 50, width: 40, height: 35 },
      master: { left: 60, top: 50, width: 35, height: 35 },
      second: { left: 5, top: 50, width: 15, height: 35 },
      balcony: { left: 20, top: 85, width: 40, height: 10 },
    },
    customRooms: [{ id: "corridor", name: "过道", mapRect: { left: 20, top: 35, width: 55, height: 15 } }],
    customDeviceNames: {},
    deviceAssignments: { asset_study_书房射灯: "study", asset_entry_过道灯: "corridor" },
    devicePlacements: { asset_study_书房射灯: { placed: true, x: 60, y: 20, roomId: "study" } },
  } };
}
