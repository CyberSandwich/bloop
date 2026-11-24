import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWrangler, type Wrangler } from "./wrangler.ts";

const OLD_HOST = "bloop.dsap.workers.dev";

let wrangler: Wrangler;
beforeAll(async () => {
  wrangler = await startWrangler();
});
afterAll(() => wrangler?.stop());

/** fetch cannot set Host; this sends one as a request for the old workers.dev host would carry. */
function asOldHost(
  path: string,
  method = "GET",
): Promise<{ status: number; location: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`${wrangler.url}${path}`, { method, headers: { Host: OLD_HOST } }, (res) => {
      let body = "";
      res.on("data", (d) => {
        body += d;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("the old workers.dev host", () => {
  it.each(["/", "/privacy", "/a?c=ABC123", "/js/site.js", "/api/health", "/f/token/name.pdf?x=1", "/no-such-page?x=1"])(
    "answers 301 for %s to the same path and query on PUBLIC_ORIGIN",
    async (path) => {
      const res = await asOldHost(path);
      expect(res.status).toBe(301);
      expect(res.location).toBe(`${wrangler.url}${path}`);
      expect(res.body).toBe("");
    },
  );

  it("refuses a POST with 403 and no Location", async () => {
    const res = await asOldHost("/api/screens", "POST");
    expect(res.status).toBe(403);
    expect(res.location).toBeUndefined();
  });
});

describe("PUBLIC_ORIGIN's own host", () => {
  it("is not redirected: pages come from assets and the API from the routes", async () => {
    const page = await fetch(`${wrangler.url}/privacy`, { redirect: "manual" });
    expect(page.status).toBe(200);
    await page.arrayBuffer();
    const api = await fetch(`${wrangler.url}/api/health`, { redirect: "manual" });
    expect(api.status).toBe(200);
    await api.arrayBuffer();
  });
});
