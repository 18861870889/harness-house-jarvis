import RAPIER from "@dimforge/rapier3d-compat";
import { HOUSE_BLUEPRINT, isValidActorPose } from "./houseBlueprint.js";

let initialized;
export async function createWalker(spawn = HOUSE_BLUEPRINT.spawn, blueprint = HOUSE_BLUEPRINT) {
  initialized ??= RAPIER.init();
  await initialized;
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const bounds = blueprint.bounds ?? { minX: -6, maxX: 6, minZ: -3, maxZ: 3 };
  world.createCollider(RAPIER.ColliderDesc.cuboid((bounds.maxX - bounds.minX) / 2, 0.1, (bounds.maxZ - bounds.minZ) / 2).setTranslation((bounds.maxX + bounds.minX) / 2, -0.1, (bounds.maxZ + bounds.minZ) / 2));
  for (const { center, size, rotation = 0 } of blueprint.colliders) world.createCollider(RAPIER.ColliderDesc.cuboid(...size.map(n => n / 2)).setTranslation(...center).setRotation({ x: 0, y: Math.sin(rotation / 2), z: 0, w: Math.cos(rotation / 2) }));
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, 0.8, spawn.z));
  const collider = world.createCollider(RAPIER.ColliderDesc.capsule(0.55, blueprint.actorRadius), body);
  const controller = world.createCharacterController(0.01);
  controller.enableSnapToGround(0.3);
  world.step();
  return {
    pose: () => ({ x: body.translation().x, z: body.translation().z }),
    move(dx, dz, dt = 1 / 60) {
      world.timestep = Math.max(1 / 120, Math.min(1 / 30, dt));
      controller.computeColliderMovement(collider, { x: dx, y: -0.12, z: dz });
      const p = body.translation();
      const delta = controller.computedMovement();
      if (!isValidActorPose({ x: p.x + delta.x, z: p.z + delta.z }, blueprint)) { delta.x = 0; delta.z = 0; }
      body.setNextKinematicTranslation({ x: p.x + delta.x, y: p.y + delta.y, z: p.z + delta.z });
      world.step();
      return { x: body.translation().x, z: body.translation().z };
    },
    reset(pose = blueprint.spawn) {
      if (!isValidActorPose(pose, blueprint)) throw new Error("invalid_actor_pose");
      body.setTranslation({ x: pose.x, y: 0.8, z: pose.z }, true);
      body.setNextKinematicTranslation({ x: pose.x, y: 0.8, z: pose.z });
      world.step();
    },
    close: () => world.free(),
  };
}
