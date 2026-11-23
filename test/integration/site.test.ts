import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_HEADERS } from "../../src/worker/headers.ts";
import { startWrangler, type Wrangler } from "./wrangler.ts";

let wrangler: Wrangler;
beforeAll(async () => {
  wrangler = await startWrangler();
});
afterAll(() => wrangler?.stop());

// Written out in full, not derived from headers.ts, so a drifting policy fails here.
const LANDING_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'; upgrade-insecure-requests";

function expectBase(res: Response) {
  for (const [name, value] of Object.entries(BASE_HEADERS)) expect(res.headers.get(name), name).toBe(value);
}

describe.each([
  ["/", 200, LANDING_CSP, "<title>bloop: your slides on any screen</title>", /text\/html/],
  ["/it", 200, LANDING_CSP, "<title>bloop for IT and AV</title>", /text\/html/],
  ["/privacy", 200, LANDING_CSP, "<title>bloop privacy notice</title>", /text\/html/],
  ["/.well-known/security.txt", 200, LANDING_CSP, "Contact: mailto:", /text\/plain/],
  ["/no-such-page", 404, LANDING_CSP, "This page isn't here.", /text\/html/],
  ["/it/deeper/still", 404, LANDING_CSP, "Go to the home page", /text\/html/],
] as const)("%s", (path, status, csp, marker, type) => {
  it(`is ${status} with its policy and the base headers`, async () => {
    const res = await fetch(`${wrangler.url}${path}`);
    expect(res.status).toBe(status);
    expect(res.headers.get("Content-Type")).toMatch(type);
    expect(res.headers.get("Content-Security-Policy")).toBe(csp);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expectBase(res);
    expect(await res.text()).toContain(marker);
  });
});

describe("security.txt (RFC 9116)", () => {
  it("has a Contact and an Expires in the future, within a year and a bit", async () => {
    const text = await (await fetch(`${wrangler.url}/.well-known/security.txt`)).text();
    expect(text).toMatch(/^Contact: mailto:\S+@\S+$/m);
    const expires = /^Expires: (\S+)$/m.exec(text)?.[1] ?? "";
    const at = Date.parse(expires);
    expect(at).toBeGreaterThan(Date.now());
    expect(at - Date.now()).toBeLessThan(400 * 86_400_000);
  });
});

describe("site assets", () => {
  it.each([
    ["/js/site.js", /javascript/],
    ["/og.png", /image\/png/],
    ["/favicon.svg", /image\/svg\+xml/],
    ["/apple-touch-icon.png", /image\/png/],
    ["/fonts/inter-latin.woff2", /font\/woff2|octet-stream/],
  ])("serves %s", async (path, type) => {
    const res = await fetch(`${wrangler.url}${path}`);
    expect(res.status, path).toBe(200);
    expect(res.headers.get("Content-Type"), path).toMatch(type);
    await res.arrayBuffer();
  });

  it("serves no source asset and no removed file", async () => {
    for (const path of ["/fonts/InterVariable.woff2", "/tools/og.svg", "/js/landing.js", "/robin.bin"]) {
      const res = await fetch(`${wrangler.url}${path}`);
      expect(res.status, path).toBe(404);
      await res.arrayBuffer();
    }
  });
});
