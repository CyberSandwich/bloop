// An invalid Worker config must not switch spend protection off: the */5 cron still runs the breaker and says why.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWrangler, type Wrangler } from "./wrangler.ts";

let wrangler: Wrangler;

beforeAll(async () => {
  wrangler = await startWrangler({ CAP_POOL_CONVERT: "typo-not-a-number" }, { migrate: true });
});
afterAll(async () => {
  await wrangler?.stop();
});

describe("COST-16 a bad spend var", () => {
  it("COST-16 the breaker still runs on the */5 cron and alerts config_invalid with the var name, never its value", async () => {
    const res = await fetch(`${wrangler.url}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("*/5 * * * *")}`);
    expect(res.status).toBe(200);
    await wrangler.logged("config_invalid");
    const line = wrangler
      .output()
      .split("\n")
      .find((l) => l.includes('"evt":"breaker"') && l.includes("config_invalid"));
    expect(line).toContain("CAP_POOL_CONVERT");
    expect(wrangler.output()).not.toContain("typo-not-a-number");
  });

  it("COST-16 the hourly and daily jobs stay idle on a bad config", async () => {
    const run = (cron: string) => fetch(`${wrangler.url}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(cron)}`);
    expect((await run("30 3 * * *")).status).toBe(200);
    expect((await run("0 * * * *")).status).toBe(200);
    // wrangler relays a Worker's log lines late: give the retention line, had it run, time to show.
    await wrangler.logged('"evt":"retention"', 3000);
    expect(wrangler.output()).not.toContain('"evt":"retention"');
    expect(wrangler.output()).not.toContain("cron_job_failed");
  });
});
