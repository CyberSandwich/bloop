import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/worker/config.ts";
import { declaredRateLimits, PROD_VARS as PROD } from "../env-vars.ts";

const problems = (env: Record<string, unknown>) => {
  const r = parseConfig(env);
  return r.ok ? [] : r.problems;
};

describe("config", () => {
  it("parses the production defaults into the machine config", () => {
    const r = parseConfig(PROD);
    expect(r.ok && r.config.machine).toEqual({
      codeTtlSeconds: 60,
      codeGraceSeconds: 10,
      claimTimeoutSeconds: 300,
      closeAfterSeconds: 600,
      maxCodesPerMinute: 6,
      endedMinSeconds: 3,
    });
    expect(r.ok && r.config.testTiming).toBe(false);
  });

  it("fails closed on a missing or malformed value", () => {
    expect(problems({ ...PROD, HASH_PEPPER: undefined }).join()).toContain("HASH_PEPPER");
    expect(problems({ ...PROD, HASH_PEPPER: "short" }).join()).toContain("HASH_PEPPER");
    expect(problems({ ...PROD, CODE_LENGTH: "5" }).join()).toContain("CODE_LENGTH");
    expect(problems({ ...PROD, GUEST_DROP: "maybe" }).join()).toContain("GUEST_DROP");
    expect(problems({ ...PROD, PUBLIC_ORIGIN: "not a url" }).join()).toContain("PUBLIC_ORIGIN");
  });

  it("refuses timings below the production floors without TEST_TIMING", () => {
    expect(problems({ ...PROD, CODE_TTL_SECONDS: "2" }).join()).toContain("CODE_TTL_SECONDS");
    expect(problems({ ...PROD, CODE_GRACE_SECONDS: "1" }).join()).toContain("CODE_GRACE_SECONDS");
    expect(problems({ ...PROD, CLAIM_TIMEOUT_SECONDS: "5" }).join()).toContain("CLAIM_TIMEOUT_SECONDS");
    expect(problems({ ...PROD, SESSION_MAX_MINUTES: "0.05" }).join()).toContain("SESSION_MAX_MINUTES");
    expect(problems({ ...PROD, SESSION_MAX_MINUTES: "721" }).join()).toContain("SESSION_MAX_MINUTES");
    expect(problems({ ...PROD, SESSION_MAX_MINUTES: "720", DEMO_MAX_MINUTES: "120" })).toEqual([]);
    expect(problems({ ...PROD, DEMO_MAX_MINUTES: "120" }).join()).toContain("DEMO_MAX_MINUTES");
    expect(problems({ ...PROD, SESSION_DEFAULT_MINUTES: "0.5" }).join()).toContain("SESSION_DEFAULT_MINUTES");
  });

  it("SESS-01 config: both caps hold the shortest length the phone may set, and the default sits between it and the cap", () => {
    expect(problems({ ...PROD, SESSION_MAX_MINUTES: "4", DEMO_MAX_MINUTES: "4" }).join()).toContain(
      "SESSION_MAX_MINUTES",
    );
    expect(problems({ ...PROD, DEMO_MAX_MINUTES: "3" }).join()).toContain("DEMO_MAX_MINUTES");
    expect(problems({ ...PROD, SESSION_DEFAULT_MINUTES: "4" }).join()).toContain("SESSION_DEFAULT_MINUTES");
    expect(problems({ ...PROD, SESSION_DEFAULT_MINUTES: "91" }).join()).toContain("SESSION_DEFAULT_MINUTES");
    expect(
      problems({ ...PROD, SESSION_MAX_MINUTES: "5", DEMO_MAX_MINUTES: "5", SESSION_DEFAULT_MINUTES: "5" }),
    ).toEqual([]);
  });

  it("SESS-01 length: every session starts at 60 minutes by default, and the backstops wait out the longest session", () => {
    const d = parseConfig(PROD);
    expect(d.ok && d.config.sessionDefaultMinutes).toBe(60);
    // Two 300 s claim windows, a 900 s upload, the 90 minute cap.
    expect(d.ok && d.config.longestSessionMs).toBe((600 + 900 + 90 * 60) * 1000);
    const c = parseConfig({ ...PROD, SESSION_DEFAULT_MINUTES: "30" });
    expect(c.ok && c.config.sessionDefaultMinutes).toBe(30);
  });

  it("PC-02 sid-powers: LINK_MINTS_PER_ITEM is at least 1, so no item is ever left with only its first link", () => {
    expect(problems({ ...PROD, LINK_MINTS_PER_ITEM: "0" }).join()).toContain("LINK_MINTS_PER_ITEM");
    expect(problems({ ...PROD, LINK_MINTS_PER_ITEM: "1" })).toEqual([]);
  });

  it("TEST_TIMING lowers the floors on a local origin", () => {
    const env = {
      ...PROD,
      PUBLIC_ORIGIN: "http://127.0.0.1:8787",
      TEST_TIMING: "1",
      CODE_TTL_SECONDS: "2",
      CODE_GRACE_SECONDS: "1",
      CLAIM_TIMEOUT_SECONDS: "3",
      SESSION_MAX_MINUTES: "0.05",
    };
    const r = parseConfig(env);
    expect(r.ok && r.config.sessionMaxMinutes).toBe(0.05);
    expect(r.ok && r.config.testTiming).toBe(true);
  });

  it("DATA-02 retention: periods default to 180, 90 and 7 days and are configurable", () => {
    const d = parseConfig(PROD);
    expect(d.ok && [d.config.auditRetentionDays, d.config.metricsRetentionDays, d.config.demoRetentionDays]).toEqual([
      180, 90, 7,
    ]);
    const c = parseConfig({ ...PROD, AUDIT_RETENTION_DAYS: "30", METRICS_RETENTION_DAYS: "14" });
    expect(c.ok && [c.config.auditRetentionDays, c.config.metricsRetentionDays]).toEqual([30, 14]);
    expect(problems({ ...PROD, AUDIT_RETENTION_DAYS: "0" }).join()).toContain("AUDIT_RETENTION_DAYS");
  });

  it("DEMO-02 flood: the demo cap defaults to 100, is configurable and the hold covers a claim window plus a session", () => {
    const d = parseConfig(PROD);
    expect(d.ok && d.config.demoMaxConcurrent).toBe(100);
    expect(d.ok && d.config.demoHoldMs).toBe((300 + 10 * 60) * 1000);
    const c = parseConfig({ ...PROD, DEMO_MAX_CONCURRENT: "5" });
    expect(c.ok && c.config.demoMaxConcurrent).toBe(5);
    expect(problems({ ...PROD, DEMO_MAX_CONCURRENT: "0" }).join()).toContain("DEMO_MAX_CONCURRENT");
    expect(problems({ ...PROD, DEMO_MAX_CONCURRENT: "many" }).join()).toContain("DEMO_MAX_CONCURRENT");
  });

  it("F14 DEMO-02 flood: one IP may hold 12 demo screens at once by default, configurable", () => {
    const d = parseConfig(PROD);
    expect(d.ok && d.config.demoMaxPerIp).toBe(12);
    const c = parseConfig({ ...PROD, DEMO_MAX_PER_IP: "5" });
    expect(c.ok && c.config.demoMaxPerIp).toBe(5);
    expect(problems({ ...PROD, DEMO_MAX_PER_IP: "0" }).join()).toContain("DEMO_MAX_PER_IP");
  });

  it("PAIR-13 rate limit binding required: the list is exactly the bindings wrangler.jsonc declares", async () => {
    // A non-literal specifier: env.ts needs the Workers types, which the test tsconfig leaves out.
    const path = "../../src/worker/env.ts";
    const { RATE_LIMIT_BINDINGS } = (await import(path)) as { RATE_LIMIT_BINDINGS: readonly string[] };
    expect([...RATE_LIMIT_BINDINGS].sort()).toEqual(Object.keys(declaredRateLimits()).sort());
  });

  it("PAIR-13 rate limit binding required: a config with no binding still parses, so the sweep and the alarms run", () => {
    const bare = Object.fromEntries(Object.entries(PROD).filter(([k]) => !k.startsWith("RL_")));
    expect(problems(bare)).toEqual([]);
  });

  it("DEMO-02 flood: the demo claim binding is no looser than the live one, which runs first and would hide it", () => {
    const limits = declaredRateLimits();
    expect(limits.RL_CLAIM).toBe(20);
    expect(limits.RL_DEMO_CLAIM).toBeLessThanOrEqual(limits.RL_CLAIM ?? 0);
  });

  it("DEMO-03 off: DEMO_ENABLED is a strict true or false and defaults to nothing", () => {
    const off = parseConfig({ ...PROD, DEMO_ENABLED: "false" });
    expect(off.ok && off.config.demoEnabled).toBe(false);
    expect(problems({ ...PROD, DEMO_ENABLED: "yes" }).join()).toContain("DEMO_ENABLED");
    expect(problems({ ...PROD, DEMO_ENABLED: undefined }).join()).toContain("DEMO_ENABLED");
  });

  it("DROP-05 demo cap: the demo drop cap defaults to 25 MB and the session length is bounded by the live one", () => {
    const d = parseConfig(PROD);
    expect(d.ok && d.config.demoGuestMaxBytes).toBe(26_214_400);
    expect(d.ok && d.config.demoMaxMinutes).toBe(10);
    expect(problems({ ...PROD, DEMO_GUEST_MAX_BYTES: "0" }).join()).toContain("DEMO_GUEST_MAX_BYTES");
  });

  it("SITE-07 export-auth: the export token is absent when unset or empty and must be 32 characters otherwise", () => {
    const unset = parseConfig(PROD);
    expect(unset.ok && unset.config.itExportToken).toBeNull();
    const empty = parseConfig({ ...PROD, IT_EXPORT_TOKEN: "" });
    expect(empty.ok && empty.config.itExportToken).toBeNull();
    expect(problems({ ...PROD, IT_EXPORT_TOKEN: "short" }).join()).toContain("IT_EXPORT_TOKEN");
  });

  it("TEST_TIMING is refused on any non-local origin", () => {
    expect(problems({ ...PROD, TEST_TIMING: "1", CODE_TTL_SECONDS: "2" }).join()).toContain("TEST_TIMING");
    expect(problems({ ...PROD, TEST_TIMING: "1", PUBLIC_ORIGIN: "https://127.0.0.1.evil.example" }).join()).toContain(
      "TEST_TIMING",
    );
  });
});
