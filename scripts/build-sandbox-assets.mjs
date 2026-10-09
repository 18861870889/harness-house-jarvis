import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { HOUSE_BLUEPRINT } from "../src/sandbox/houseBlueprint.js";

const work = resolve("build/house-sandbox");
const output = resolve("public/sandbox");
mkdirSync(work, { recursive: true });
mkdirSync(output, { recursive: true });
const manifest = resolve(work, "blueprint.json");
writeFileSync(manifest, `${JSON.stringify(HOUSE_BLUEPRINT, null, 2)}\n`);
const mac = "/Applications/Blender.app/Contents/MacOS/Blender";
const blender = process.env.BLENDER_PATH ?? (existsSync(mac) ? mac : "blender");
const result = spawnSync(blender, ["--background", "--factory-startup", "--disable-autoexec", "--python", resolve("scripts/build-sandbox-model.py"), "--", manifest, output, work], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
