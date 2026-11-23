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

describe("security headers on a running Worker", () => {
  it("GET / is 200 with the landing policy", async () => {
    const res = await fetch(`${wrangler.url}/`);
    expect(res.status).toBe(200);
    expectBase(res);
    expect(res.headers.get("Content-Security-Policy")).toBe(LANDING_CSP);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
  });

  it("an unknown page is the 404 page with the default (landing) policy", async () => {
    const res = await fetch(`${wrangler.url}/no-such-page`);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain("This page isn't here.");
    expectBase(res);
    expect(res.headers.get("Content-Security-Policy")).toBe(LANDING_CSP);
  });

  it("an unknown API path is a problem+json 404 with the api policy", async () => {
    const res = await fetch(`${wrangler.url}/api/no-such-route`);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
    expect(await res.json()).toEqual({ type: "about:blank", status: 404, code: "not_found" });
    expectBase(res);
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("a method the route does not allow gets 405 with Allow", async () => {
    const res = await fetch(`${wrangler.url}/f/token/deck.pptx`, { method: "PROPFIND" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD");
    expectBase(res);
  });
});
