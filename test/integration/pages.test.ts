import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_HEADERS, permissionsPolicy } from "../../src/worker/headers.ts";
import { minify, minifyCss } from "../../tools/build-assets.mjs";
import { startWrangler, type Wrangler } from "./wrangler.ts";

let wrangler: Wrangler;
beforeAll(async () => {
  wrangler = await startWrangler();
});
afterAll(() => wrangler?.stop());

// Written out in full, not derived from headers.ts, so a drifting policy fails here.
const APP_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'; upgrade-insecure-requests";

// The screen page alone may play a guest video, from its own origin (VID-01), and runs the viewers' workers under the
// one Trusted Types policy (ADR 0020). No file origin is configured in the harness, so none is added.
const SCREEN_CSP = APP_CSP.replace("font-src 'self';", "font-src 'self'; media-src 'self';")
  .replace("connect-src 'self';", "connect-src 'self'; worker-src 'self';")
  .replace("trusted-types 'none'", "trusted-types bloop-worker");

describe.each([
  ["/s", "bloop: Screen", "/js/screen.js"],
  ["/a", "bloop: Approve", "/js/phone.js"],
  ["/code", "bloop: Enter the Code", "/js/code.js"],
])("task page %s", (path, title, script) => {
  it("is 200 HTML with the app policy, never frameable", async () => {
    const res = await fetch(`${wrangler.url}${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toBe(path === "/s" ? SCREEN_CSP : APP_CSP);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    for (const [name, value] of Object.entries(BASE_HEADERS)) {
      if (name === "Permissions-Policy") continue;
      expect(res.headers.get(name), name).toBe(value);
    }
    const expected = path === "/s" ? permissionsPolicy("screen") : permissionsPolicy("wake");
    expect(res.headers.get("Permissions-Policy")).toBe(expected);
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
    expect(policy).toBe(permissionsPolicy("screen"));
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

  it("serves every module as built from the current source: minified, never the source or a stale build", async () => {
    const modules = readdirSync("public/js", { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".js"));
    expect(modules.length).toBeGreaterThan(20);
    for (const rel of modules) {
      const res = await fetch(`${wrangler.url}/js/${rel}`);
      expect(res.status, rel).toBe(200);
      expect(await res.text(), rel).toBe(minify(readFileSync(`public/js/${rel}`, "utf8"), `js/${rel}`).code);
    }
  });

  it("serves every stylesheet as built from the current source: stripped, never the source or a stale build", async () => {
    const sheets = readdirSync("public/css").filter((f) => f.endsWith(".css"));
    expect(sheets.length).toBeGreaterThan(5);
    for (const rel of sheets) {
      const res = await fetch(`${wrangler.url}/css/${rel}`);
      expect(res.status, rel).toBe(200);
      expect(await res.text(), rel).toBe(minifyCss(readFileSync(`public/css/${rel}`, "utf8"), `css/${rel}`));
    }
  });

  it("does not serve the type declaration shipped beside the vendored file", async () => {
    const res = await fetch(`${wrangler.url}/js/vendor/uqr.d.ts`);
    expect(res.status).toBe(404);
  });
});
