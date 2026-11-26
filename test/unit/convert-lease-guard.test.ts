import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/worker/config.ts";
import { STAGE_TIMEOUT_S } from "../../src/worker/convert/contract.ts";
import { containerEnv, PROFILES } from "../../src/worker/convert/profile.ts";
import { CAPS, CONVERT_LEASE_FLOOR_SECONDS, resolveCaps } from "../../src/worker/spend/caps.ts";
import { PROD_VARS } from "../env-vars.ts";

/** inspect, then the longest stage, then the transfers: the chain container-lease.test.ts holds under the lease. */
const TRANSFERS = 300;

describe("CONV-02 lease guard: a deploy cannot make the lease shorter than a job", () => {
  it("the floor is the longest chain: inspect, the video ceiling and the transfers", () => {
    expect(CONVERT_LEASE_FLOOR_SECONDS).toBe(STAGE_TIMEOUT_S.inspect + STAGE_TIMEOUT_S.video + TRANSFERS);
    expect(CAPS.lease_max_convert_seconds.default).toBeGreaterThanOrEqual(CONVERT_LEASE_FLOOR_SECONDS);
  });

  it("a CAP_LEASE_CONVERT_SECONDS below the floor fails the config and says why; the floor and unset pass", () => {
    const low = parseConfig({ ...PROD_VARS, CAP_LEASE_CONVERT_SECONDS: String(CONVERT_LEASE_FLOOR_SECONDS - 1) });
    expect(low.ok).toBe(false);
    expect(low.ok ? [] : low.problems.join("\n")).toMatch(/CAP_LEASE_CONVERT_SECONDS: must be at least 1770: .*lease/);
    expect(parseConfig({ ...PROD_VARS, CAP_LEASE_CONVERT_SECONDS: String(CONVERT_LEASE_FLOOR_SECONDS) }).ok).toBe(true);
    expect(parseConfig({ ...PROD_VARS }).ok).toBe(true);
  });

  it("only the deploy is guarded: an /admin row can still lower the lease, and admission then refuses the jobs it cannot hold", () => {
    expect(resolveCaps({}, { lease_max_convert_seconds: 600 }).lease_max_convert_seconds).toBe(600);
    expect(resolveCaps({ CAP_LEASE_CONVERT_SECONDS: "3000" }).lease_max_convert_seconds).toBe(3000);
  });

  it("no stage timeout is passed to the container or set in wrangler, so BLOOP_TIMEOUT_VIDEO stays at the contract's ceiling", () => {
    for (const profile of Object.values(PROFILES))
      expect(Object.keys(containerEnv(profile, 1)).filter((k) => k.startsWith("BLOOP_TIMEOUT"))).toEqual([]);
    expect(readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8")).not.toMatch(/BLOOP_TIMEOUT/);
    expect(STAGE_TIMEOUT_S.video).toBe(1440);
  });
});
