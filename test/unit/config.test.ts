import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/worker/config.ts";

const PROD = {
  PUBLIC_ORIGIN: "https://bloop.example",
  HASH_PEPPER: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  CODE_LENGTH: "6",
  CODE_TTL_SECONDS: "60",
  CODE_GRACE_SECONDS: "10",
  CLAIM_TIMEOUT_SECONDS: "300",
  UPLOAD_TIMEOUT_SECONDS: "900",
  SESSION_MAX_MINUTES: "90",
  DEMO_SESSION_MINUTES: "10",
  DEMO_ENABLED: "true",
  GUEST_DROP: "open",
};

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
    expect(problems({ ...PROD, SESSION_MAX_MINUTES: "300" }).join()).toContain("SESSION_MAX_MINUTES");
    expect(problems({ ...PROD, DEMO_SESSION_MINUTES: "120" }).join()).toContain("DEMO_SESSION_MINUTES");
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

  it("DEMO-03 off: DEMO_ENABLED is a strict true or false and defaults to nothing", () => {
    const off = parseConfig({ ...PROD, DEMO_ENABLED: "false" });
    expect(off.ok && off.config.demoEnabled).toBe(false);
    expect(problems({ ...PROD, DEMO_ENABLED: "yes" }).join()).toContain("DEMO_ENABLED");
    expect(problems({ ...PROD, DEMO_ENABLED: undefined }).join()).toContain("DEMO_ENABLED");
  });

  it("DROP-05 demo cap: the demo drop cap defaults to 10 MB and the session length is bounded by the live one", () => {
    const d = parseConfig(PROD);
    expect(d.ok && d.config.demoGuestMaxBytes).toBe(10_485_760);
    expect(d.ok && d.config.demoSessionMinutes).toBe(10);
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
