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

  it("TEST_TIMING is refused on any non-local origin", () => {
    expect(problems({ ...PROD, TEST_TIMING: "1", CODE_TTL_SECONDS: "2" }).join()).toContain("TEST_TIMING");
    expect(problems({ ...PROD, TEST_TIMING: "1", PUBLIC_ORIGIN: "https://127.0.0.1.evil.example" }).join()).toContain(
      "TEST_TIMING",
    );
  });
});
