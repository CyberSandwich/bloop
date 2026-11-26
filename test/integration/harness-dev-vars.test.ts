// A `limits` server still reads its dev secrets: wrangler loads the dev vars file beside its config, and the derived
// config lives elsewhere, so the harness points it at one. This test writes its own file; the repo's is never touched.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PEPPER } from "./pairing-client.ts";
import { startWrangler, type Wrangler } from "./wrangler.ts";

const dir = mkdtempSync(join(tmpdir(), "bloop-devvars-"));
let wrangler: Wrangler;
beforeAll(async () => {
  const devVars = join(dir, ".dev.vars");
  writeFileSync(devVars, `HASH_PEPPER=${PEPPER}\n`);
  wrangler = await startWrangler({}, { migrate: true, limits: { RL_MEMBER_IP: 5 }, devVars });
});
afterAll(async () => {
  await wrangler?.stop();
  rmSync(dir, { recursive: true, force: true });
});

it("a limits server takes HASH_PEPPER from its dev vars file: a member route answers 401, not the config-invalid 500", async () => {
  const res = await fetch(`${wrangler.url}/api/me/signout`, {
    method: "POST",
    headers: { Origin: wrangler.url, "Content-Type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(401);
});
