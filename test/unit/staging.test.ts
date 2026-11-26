import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/worker/config.ts";
import { wranglerConfig } from "../../tools/wrangler-config.mjs";
import {
  D1_NAME,
  d1IdFrom,
  lockedWranglerVersion,
  missingSecrets,
  PLACEHOLDER,
  SECRETS,
  withD1Id,
} from "../../tools/staging.mjs";

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
const live = wranglerConfig(read("wrangler.jsonc"));
const staging = live.env.staging;

/** The variables that differ from production on purpose: the origin, the test keys and the tiny caps. */
const OVERRIDDEN = [
  "PUBLIC_ORIGIN",
  "FILE_ORIGIN",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "GUEST_MAX_BYTES",
  "DEMO_GUEST_MAX_BYTES",
  "GUEST_STORAGE_BUDGET_BYTES",
  "LIBRARY_QUOTA_BYTES",
  "LIBRARY_MAX_FILE_BYTES",
  "LIBRARY_MAX_FILES",
  "R2_CLASS_A_MONTHLY_CAP",
  "R2_CLASS_B_MONTHLY_CAP",
  "DEMO_MAX_CONCURRENT",
  "DEMO_MAX_PER_IP",
];

describe("staging: env.staging in wrangler.jsonc", () => {
  it("is its own script with no route, and its own D1 and EU buckets, none of production's", () => {
    expect(staging.name).toBe("bloop-staging");
    expect(staging.routes).toEqual([]);
    expect(staging.d1_databases).toEqual([
      { binding: "DB", database_name: D1_NAME, database_id: PLACEHOLDER, migrations_dir: "migrations" },
    ]);
    expect(staging.r2_buckets).toEqual([
      { binding: "GUEST_FILES", bucket_name: "bloop-staging-guest", jurisdiction: "eu" },
      { binding: "LIBRARY", bucket_name: "bloop-staging-library", jurisdiction: "eu" },
    ]);
    for (const bucket of live.r2_buckets) expect(JSON.stringify(staging)).not.toContain(bucket.bucket_name);
  });

  it("repeats the bindings wrangler does not inherit, so the two cannot drift, and runs only the */5 breaker cron", () => {
    expect(staging.durable_objects).toEqual(live.durable_objects);
    expect(staging.triggers).toEqual({ crons: ["*/5 * * * *"] });
    expect(live.triggers.crons).toContain("*/5 * * * *");
    expect(staging.migrations).toBeUndefined();
    expect(staging.ratelimits.map((r: { name: string; simple: unknown }) => [r.name, r.simple])).toEqual(
      live.ratelimits.map((r: { name: string; simple: unknown }) => [r.name, r.simple]),
    );
  });

  it("keeps its rate-limit namespaces apart from production's", () => {
    const ids = (list: { namespace_id: string }[]) => list.map((r) => r.namespace_id);
    expect(ids(staging.ratelimits).filter((id) => ids(live.ratelimits).includes(id))).toEqual([]);
  });

  it("has every production variable, and differs only in the listed overrides", () => {
    expect(Object.keys(staging.vars)).toEqual(expect.arrayContaining(Object.keys(live.vars)));
    const differs = Object.keys(staging.vars).filter((key) => staging.vars[key] !== live.vars[key]);
    expect(differs.sort()).toEqual([...OVERRIDDEN].sort());
  });

  it("uses Cloudflare's published Turnstile test keys and tiny caps, on its own workers.dev origin", () => {
    expect(staging.vars.TURNSTILE_SITE_KEY).toBe("1x00000000000000000000AA");
    expect(staging.vars.TURNSTILE_SECRET_KEY).toBe("1x0000000000000000000000000000000AA");
    expect(staging.vars.PUBLIC_ORIGIN).toBe("https://bloop-staging.dsap.workers.dev");
    for (const key of ["LIBRARY_QUOTA_BYTES", "GUEST_STORAGE_BUDGET_BYTES", "R2_CLASS_A_MONTHLY_CAP"]) {
      expect(Number(staging.vars[key]), key).toBeLessThan(Number(live.vars[key]));
    }
  });

  it("parses as a valid configuration with the secrets the job makes", () => {
    const secrets = Object.fromEntries(Object.entries(SECRETS).map(([name, make]) => [name, (make as () => string)()]));
    const result = parseConfig({ ...staging.vars, ...secrets, DEMO_ENABLED: "true" });
    expect(result.ok ? [] : result.problems).toEqual([]);
  });

  it("is never the production origin or an email-sending, converting or direct-upload staging", () => {
    expect(staging.vars.PUBLIC_ORIGIN).not.toBe(live.vars.PUBLIC_ORIGIN);
    expect(staging.vars.CONVERT_MODE).not.toBe("stub");
    expect(staging.vars.DEV_MAILBOX).toBeUndefined();
  });
});

describe("staging: tools/staging.mjs", () => {
  it("finds the staging database by name in `wrangler d1 list --json`", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(
      d1IdFrom(
        JSON.stringify([
          { uuid: "x", name: "bloop" },
          { uuid: id, name: "bloop-staging" },
        ]),
      ),
    ).toBe(id);
    expect(d1IdFrom(JSON.stringify([{ uuid: "x", name: "bloop" }]))).toBeNull();
  });

  it("puts the D1 id where the placeholder is, and refuses a non-UUID or a config without the placeholder", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(withD1Id(read("wrangler.jsonc"), id)).toContain(`"database_id": "${id}"`);
    expect(() => withD1Id(read("wrangler.jsonc"), "not-an-id")).toThrow(/UUID/);
    expect(() => withD1Id("{}", id)).toThrow(/not in the config/);
  });

  it("lists the secrets still to set, and sets all of them for a Worker that does not exist yet", () => {
    expect(missingSecrets(JSON.stringify([{ name: "COOKIE_KEY" }, { name: "HASH_PEPPER" }]))).toEqual(
      Object.keys(SECRETS).filter((name) => name !== "COOKIE_KEY" && name !== "HASH_PEPPER"),
    );
    expect(missingSecrets(JSON.stringify(Object.keys(SECRETS).map((name) => ({ name }))))).toEqual([]);
  });

  it("makes long random values, and TOKEN_KEKS as JSON with the current key id", () => {
    for (const [name, make] of Object.entries(SECRETS)) {
      const value = (make as () => string)();
      expect(value.length, name).toBeGreaterThanOrEqual(32);
      expect((make as () => string)(), name).not.toBe(value);
    }
    expect(Object.keys(JSON.parse((SECRETS.TOKEN_KEKS as () => string)()))).toEqual([live.vars.TOKEN_KEK_CURRENT]);
  });
});

describe("staging: .github/workflows/staging.yml", () => {
  const yml = read(".github/workflows/staging.yml");

  it("runs for the staging branch only, and skips with a log line until the resources exist", () => {
    expect(yml).toContain("branches: [staging]");
    expect(yml).toContain("if: github.ref_name == 'staging'\n");
    expect(yml).not.toContain("ci/");
    expect(yml).toContain("Staging skipped: no CLOUDFLARE_API_TOKEN");
    expect(yml).toContain("steps.resources.outputs.ready == 'true'");
  });

  it("installs without scripts and runs wrangler from the lockfile by path, never npx", () => {
    expect(yml).toContain("npm ci --ignore-scripts");
    expect(yml).not.toMatch(/npx|npm ci(?! --ignore-scripts)/);
    expect(read("tools/staging.mjs")).not.toContain("npx");
    expect(lockedWranglerVersion(read("package-lock.json"))).toBe(
      JSON.parse(read("node_modules/wrangler/package.json")).version,
    );
    expect(() => lockedWranglerVersion("{}")).toThrow(/does not pin/);
  });

  it("generates secrets in the job and never writes one to the log", () => {
    expect(yml).toContain("node tools/staging.mjs deploy");
    expect(yml).not.toMatch(/echo[^\n]*\$\{\{ *secrets\./);
    expect(read("tools/staging.mjs")).not.toMatch(/console\.log\([^)]*(SECRETS\[|value)/);
  });
});
