import RAPIER from "@dimforge/rapier3d-compat";
import { HOUSE_BLUEPRINT, isValidActorPose } from "./houseBlueprint.js";

let initialized;
export async function createWalker(spawn = HOUSE_BLUEPRINT.spawn) {
  initialized ??= RAPIER.init();
  await initialized;
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.createCollider(RAPIER.ColliderDesc.cuboid(6, 0.1, 3).setTranslation(0, -0.1, 0));
  for (const { center, size } of HOUSE_BLUEPRINT.colliders) world.createCollider(RAPIER.ColliderDesc.cuboid(...size.map((n) => n / 2)).setTranslation(...center));
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, 0.8, spawn.z));
  const collider = world.createCollider(RAPIER.ColliderDesc.capsule(0.55, HOUSE_BLUEPRINT.actorRadius), body);
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
      body.setNextKinematicTranslation({ x: p.x + delta.x, y: p.y + delta.y, z: p.z + delta.z });
      world.step();
      return { x: body.translation().x, z: body.translation().z };
    },
    reset(pose = HOUSE_BLUEPRINT.spawn) {
      if (!isValidActorPose(pose)) throw new Error("invalid_actor_pose");
      body.setTranslation({ x: pose.x, y: 0.8, z: pose.z }, true);
      body.setNextKinematicTranslation({ x: pose.x, y: 0.8, z: pose.z });
      world.step();
    },
    close: () => world.free(),
  };
}
