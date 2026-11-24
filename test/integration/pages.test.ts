import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_HEADERS, permissionsPolicy } from "../../src/worker/headers.ts";
import { startWrangler, type Wrangler } from "./wrangler.ts";

let wrangler: Wrangler;
beforeAll(async () => {
  wrangler = await startWrangler();
});
afterAll(() => wrangler?.stop());

// Written out in full, not derived from headers.ts, so a drifting policy fails here.
const APP_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'; upgrade-insecure-requests";

describe.each([
  ["/s", "bloop screen", "/js/screen.js"],
  ["/a", "Approve on bloop", "/js/phone.js"],
  ["/code", "Enter the code on bloop", "/js/code.js"],
])("task page %s", (path, title, script) => {
  it("is 200 HTML with the app policy, never frameable", async () => {
    const res = await fetch(`${wrangler.url}${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toBe(APP_CSP);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    for (const [name, value] of Object.entries(BASE_HEADERS)) {
      if (name === "Permissions-Policy" && path === "/s") continue;
      expect(res.headers.get(name), name).toBe(value);
    }
    const html = await res.text();
    expect(html).toContain(`<title>${title}</title>`);
    expect(html).toContain(`src="${script}"`);
  });

  it("serves its script as JavaScript", async () => {
    const res = await fetch(`${wrangler.url}${script}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/javascript/);
  });
});

describe("/s keeps fullscreen and wake lock for itself", () => {
  it("allows only those two features", async () => {
    const res = await fetch(`${wrangler.url}/s`);
    const policy = res.headers.get("Permissions-Policy") ?? "";
    expect(policy).toBe(permissionsPolicy(true));
    expect(policy).toContain("fullscreen=(self)");
    expect(policy).toContain("screen-wake-lock=(self)");
    expect(policy).toContain("camera=()");
  });
});

describe("shared assets", () => {
  it("serves the stylesheets, the font and the vendored QR library", async () => {
    for (const [path, type] of [
      ["/css/base.css", /text\/css/],
      ["/css/site.css", /text\/css/],
      ["/css/app.css", /text\/css/],
      ["/fonts/inter-latin.woff2", /font\/woff2|application\/octet-stream/],
      ["/js/vendor/uqr.js", /javascript/],
    ] as const) {
      const res = await fetch(`${wrangler.url}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Content-Type"), path).toMatch(type);
    }
  });

  it("does not serve the type declaration shipped beside the vendored file", async () => {
    const res = await fetch(`${wrangler.url}/js/vendor/uqr.d.ts`);
    expect(res.status).toBe(404);
  });
});
