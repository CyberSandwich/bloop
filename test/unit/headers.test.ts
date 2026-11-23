import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BASE_HEADERS,
  CSP,
  headersFor,
  type Policy,
  permissionsPolicy,
  withHeaders,
} from "../../src/worker/headers.ts";

/** Resolves public/_headers for one path the way Cloudflare does: matching blocks in order, `! Name` detaches. */
function staticHeaders(path: string): Record<string, string> {
  const out = new Map<string, string>();
  let applies = false;
  for (const line of readFileSync(new URL("../../public/_headers", import.meta.url), "utf8").split("\n")) {
    if (line.trim() === "") continue;
    if (!line.startsWith(" ")) {
      applies = line === "/*" || line === path;
      continue;
    }
    if (!applies) continue;
    const text = line.trim();
    if (text.startsWith("! ")) {
      out.delete(text.slice(2).toLowerCase());
      continue;
    }
    const colon = text.indexOf(":");
    const name = text.slice(0, colon).trim().toLowerCase();
    // Cloudflare joins repeated names with a comma, which would corrupt a CSP; every override must detach first.
    if (out.has(name)) throw new Error(`${path}: ${name} set twice without detaching`);
    out.set(name, text.slice(colon + 1).trim());
  }
  return Object.fromEntries(out);
}

const lower = (headers: Record<string, string>) =>
  Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

const pages: [string, Policy, boolean][] = [
  ["/", "landing", false],
  ["/s", "app", true],
  ["/a", "app", false],
  ["/code", "app", false],
  ["/g", "app", false],
  ["/me", "app", false],
  ["/security", "landing", false],
  ["/privacy", "landing", false],
  ["/.well-known/security.txt", "landing", false],
  ["/anything-else", "landing", false],
];

describe("public/_headers matches headers.ts", () => {
  for (const [path, policy, screen] of pages) {
    it(`${path} gets the ${policy} policy`, () => {
      const expected = lower({ ...headersFor(policy), "Permissions-Policy": permissionsPolicy(screen) });
      expect(staticHeaders(path)).toEqual(expected);
    });
  }
});

describe("headers.ts", () => {
  it("every policy carries the base headers", () => {
    for (const policy of ["landing", "app", "api", "file-pptx", "file-pdf"] as const) {
      expect(headersFor(policy)).toMatchObject(BASE_HEADERS);
    }
  });

  it("SITE-08 headers: HSTS for two years on every policy, subdomains included", () => {
    for (const policy of ["landing", "app", "api", "file-pptx", "file-pdf"] as const) {
      expect(headersFor(policy)["Strict-Transport-Security"]).toBe("max-age=63072000; includeSubDomains");
    }
    expect(CSP.app).toContain("upgrade-insecure-requests");
  });

  it("OPEN-05 headers: no Referer on any response", () => {
    for (const policy of ["landing", "app", "api", "file-pptx", "file-pdf"] as const) {
      expect(headersFor(policy)["Referrer-Policy"]).toBe("no-referrer");
    }
  });

  it("SITE-02 csp: pages allow no inline or eval script and no Trusted Types policy", () => {
    for (const policy of ["landing", "app"] as const) {
      expect(CSP[policy]).toContain("script-src 'self';");
      expect(CSP[policy]).not.toMatch(/unsafe-(inline|eval)/);
      expect(CSP[policy]).toContain("require-trusted-types-for 'script'");
      expect(CSP[policy]).toContain("trusted-types 'none'");
    }
  });

  it("api and file responses are never cached", () => {
    for (const policy of ["api", "file-pptx", "file-pdf"] as const) {
      expect(headersFor(policy)["Cache-Control"]).toBe("no-store");
    }
  });

  it("withHeaders overrides what a handler set and keeps status and body", async () => {
    const res = withHeaders(new Response("x", { status: 418, headers: { "X-Frame-Options": "SAMEORIGIN" } }), "api");
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("x");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
