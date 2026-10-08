import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["server.mjs", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: {
    ...process.env,
    HARNESS_DECISION_BACKEND: "d1",
    HARNESS_D1_DEMO: "1",
    HARNESS_EXECUTION_MODE: "real",
    D1_ENDPOINT: process.env.D1_ENDPOINT || "http://192.168.1.154:8080/v1/systemone",
    D1_MODEL: process.env.D1_MODEL || "d1-3b-q4",
  },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 0; });
