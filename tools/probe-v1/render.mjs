// Throwaway probe: per-step render cost, and whole-job seconds per page at 1 and 2 CPUs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GEN, IMAGE, docker, healthy, runJob, start, stop } from "../../container/test/lib.mjs";

const script = join(fileURLToPath(new URL(".", import.meta.url)), "render-steps.sh");
const steps = readFileSync(script, "utf8");

for (const cpus of [1, 2]) {
  console.log(`\n== steps at --cpus ${cpus}`);
  const r = docker(
    "run", "--rm", "--network", "none", "--read-only", "--cpus", String(cpus),
    "--tmpfs", "/tmp:rw,mode=1777,size=4g", "-v", `${GEN}:/fx:ro`, "--entrypoint", "bash", IMAGE, "-c", steps,
  );
  console.log(r.out, r.err);
}

for (const [cpus, workers] of [[1, "auto"], [2, "auto"]]) {
  const env = { BLOOP_TIMEOUT_RASTERIZE: "3600", BLOOP_TIMEOUT_CONVERT: "3600" };
  const c = start({ cpus, env });
  try {
    await healthy(c);
    const r = await runJob(c, join(GEN, "deck-100.pptx"), "pptx");
    const s = r.stageAt;
    const rast = r.ms - (s.rasterize ?? r.ms);
    console.log(`job cpus=${cpus} workers=${workers}: total ${(r.ms / 1000).toFixed(1)} s, rasterize ${(rast / 1000).toFixed(1)} s = ${(rast / 100000).toFixed(2)} s/page, state ${r.status.state}`);
  } finally {
    stop(c);
  }
}
