import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/worker/config.ts";

const base = {
  PUBLIC_ORIGIN: "https://bloop.example",
  HASH_PEPPER: "p".repeat(40),
  CODE_LENGTH: "6",
  CODE_TTL_SECONDS: "60",
  CODE_GRACE_SECONDS: "10",
  CLAIM_TIMEOUT_SECONDS: "300",
  UPLOAD_TIMEOUT_SECONDS: "900",
  SESSION_MAX_MINUTES: "90",
  DEMO_MAX_MINUTES: "10",
  DEMO_ENABLED: "true",
  GUEST_DROP: "open",
};
const key = Buffer.alloc(32, 5).toString("base64");
const graph = {
  ...base,
  FILE_SOURCE: "graph",
  ENTRA_CLIENT_ID: "client-id",
  ENTRA_CLIENT_SECRET: "x".repeat(12),
  TOKEN_KEKS: JSON.stringify({ k1: key }),
  TOKEN_KEK_CURRENT: "k1",
  COOKIE_KEY: key,
};

const problems = (env: Record<string, unknown>) => {
  const r = parseConfig(env);
  return r.ok ? "" : r.problems.join("; ");
};

describe("config: file source and token vault", () => {
  it("SRC-04 isolation: defaults to the mock source with no Graph configuration at all", () => {
    const r = parseConfig(base);
    expect(r.ok && r.config).toMatchObject({
      fileSource: "mock",
      tokenMode: "refresh",
      grantIdleDays: 30,
      graph: null,
      downloadHosts: ["*.sharepoint.com", "*.files.1drv.com", "my.microsoftpersonalcontent.com"],
    });
  });

  it("empty strings count as unset, so wrangler.jsonc can ship empty Entra values", () => {
    const r = parseConfig({ ...base, ENTRA_CLIENT_ID: "", ENTRA_CLIENT_SECRET: "", TOKEN_KEKS: "", COOKIE_KEY: "" });
    expect(r.ok && r.config.graph).toBeNull();
  });

  it("SRC-04 isolation: the mock source ignores Entra settings even when they are present", () => {
    const r = parseConfig({ ...graph, FILE_SOURCE: "mock" });
    expect(r.ok && r.config.graph).toBeNull();
  });

  it("parses a complete Graph configuration", () => {
    const r = parseConfig({ ...graph, ENTRA_SCOPES: "openid  offline_access Files.Read" });
    expect(r.ok && r.config.graph).toEqual({
      authority: "https://login.microsoftonline.com/organizations/v2.0",
      clientId: "client-id",
      clientSecret: "x".repeat(12),
      scopes: ["openid", "offline_access", "Files.Read"],
      keks: { keys: { k1: key }, current: "k1" },
      cookieKey: key,
    });
  });

  it("SRC-04 isolation: FILE_SOURCE=graph fails closed on every missing piece", () => {
    for (const missing of ["ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET", "COOKIE_KEY", "TOKEN_KEKS"]) {
      expect(problems({ ...graph, [missing]: undefined }), missing).toContain(missing);
      expect(problems({ ...graph, [missing]: "" }), missing).toContain(missing);
    }
    expect(problems({ ...graph, TOKEN_KEK_CURRENT: "k9" })).toContain("TOKEN_KEKS");
  });

  it("refuses a malformed key, KEK list, mode or authority", () => {
    expect(problems({ ...graph, COOKIE_KEY: "short" })).toContain("COOKIE_KEY");
    expect(problems({ ...graph, TOKEN_KEKS: "not json" })).toContain("TOKEN_KEKS");
    expect(problems({ ...graph, TOKEN_KEKS: JSON.stringify({ k1: "short" }) })).toContain("TOKEN_KEKS");
    expect(problems({ ...graph, TOKEN_KEKS: JSON.stringify(["a"]) })).toContain("TOKEN_KEKS");
    expect(problems({ ...base, TOKEN_MODE: "forever" })).toContain("TOKEN_MODE");
    expect(problems({ ...base, FILE_SOURCE: "onedrive" })).toContain("FILE_SOURCE");
    expect(problems({ ...graph, ENTRA_SCOPES: "Files.Read" })).toContain("ENTRA_SCOPES");
    expect(problems({ ...base, GRANT_IDLE_DAYS: "0" })).toContain("GRANT_IDLE_DAYS");
  });

  it("an http authority is accepted only on a local origin", () => {
    const http = { ...graph, ENTRA_AUTHORITY: "http://127.0.0.1:9/organizations/v2.0" };
    expect(problems(http)).toContain("ENTRA_AUTHORITY");
    const local = { ...http, PUBLIC_ORIGIN: "http://127.0.0.1:8787", TEST_TIMING: "1" };
    expect(problems(local)).toBe("");
  });

  it("TOKEN_MODE=session parses", () => {
    const r = parseConfig({ ...graph, TOKEN_MODE: "session" });
    expect(r.ok && r.config.tokenMode).toBe("session");
  });
});
