// /signin and /invite as served: the policy that lets Turnstile in and nothing else, and the invite token's privacy.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CSP, headersFor } from "../../src/worker/headers.ts";
import { staticHeaders } from "../../tools/static-headers.mjs";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const TURNSTILE = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

describe("Turnstile through the one Trusted Types policy (ADR 0022)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("the auth pages name the bloop-worker policy and allow Turnstile's origin for scripts and frames only", () => {
    for (const policy of ["auth", "report"] as const) {
      expect(CSP[policy]).toContain("require-trusted-types-for 'script'; trusted-types bloop-worker;");
      expect(CSP[policy]).toContain("script-src 'self' https://challenges.cloudflare.com;");
      expect(CSP[policy]).toContain("frame-src https://challenges.cloudflare.com;");
      expect(CSP[policy]).toMatch(/connect-src 'self';/);
    }
  });

  it("the policy passes Turnstile's exact URL and refuses any other, a changed query included", async () => {
    const made: string[] = [];
    vi.stubGlobal("trustedTypes", {
      createPolicy: (name: string, rules: { createScriptURL: (u: string) => string }) => {
        made.push(name);
        return { createScriptURL: (u: string) => `trusted:${rules.createScriptURL(u)}` };
      },
    });
    const { TURNSTILE_URL, scriptUrl } = await import("../../public/js/core/tt.js");
    expect(TURNSTILE_URL).toBe(TURNSTILE);
    expect(scriptUrl(TURNSTILE)).toBe(`trusted:${TURNSTILE}`);
    for (const bad of [
      "https://challenges.cloudflare.com/turnstile/v0/api.js",
      `${TURNSTILE}&onload=x`,
      "https://challenges.cloudflare.com.evil.example/turnstile/v0/api.js?render=explicit",
      "/js/auth/turnstile.js",
    ])
      expect(() => scriptUrl(bad), bad).toThrow("script URL not allowed");
    expect(made).toEqual(["bloop-worker"]);
  });

  it("the loader names no script URL of its own: it asks tt.js, loaded on intent", () => {
    const loader = read("public/js/auth/turnstile.js");
    expect(loader).not.toContain("challenges.cloudflare.com");
    expect(loader).toContain('await import("../core/tt.js")');
    expect(loader).toContain("script.src = scriptUrl(TURNSTILE_URL)");
    expect(loader).toMatch(/execution: "execute",\s*appearance: "interaction-only"/);
    // The page imports it on the email field's first focus, never at load.
    expect(read("public/js/signin.js")).not.toMatch(/^import .*turnstile/m);
  });
});

describe("the invite token", () => {
  it("INV-01 no-referrer: /invite sends no Referer, by header and by meta", () => {
    expect(headersFor("auth")["Referrer-Policy"]).toBe("no-referrer");
    expect(staticHeaders(read("public/_headers"), "/invite", "bloop.here")["referrer-policy"]).toBe("no-referrer");
    expect(read("public/invite.html")).toContain('<meta name="referrer" content="no-referrer">');
  });

  it("INV-01 fragment: the page drops #t= from the address before its first request, and keeps it only for Terms", () => {
    const page = read("public/js/invite.js");
    const dropped = page.indexOf('history.replaceState(null, "", location.pathname)');
    expect(dropped).toBeGreaterThan(0);
    expect(dropped).toBeLessThan(page.indexOf("api.post("));
    expect(page).not.toMatch(/localStorage/);
    // Kept in this tab's sessionStorage only while Terms is open, and removed on the next load.
    expect(page).toContain('const KEPT = "bloop.invite"');
    expect(page).toContain("store.remove(KEPT)");
    expect(page).toMatch(/byId\("terms"\)\.addEventListener\("click", \(\) => store\.set\(KEPT, token\)\)/);
  });
});
