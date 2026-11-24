import { describe, expect, it } from "vitest";
import { offOrigin } from "../../src/worker/origin.ts";

const ORIGIN = "https://bloop.here";
const OLD = "https://bloop.dsap.workers.dev";

describe("offOrigin", () => {
  it("lets a request on the origin through", () => {
    expect(offOrigin(new Request(`${ORIGIN}/s?mode=demo`), ORIGIN)).toBeNull();
    expect(offOrigin(new Request(`${ORIGIN}/api/screens`, { method: "POST" }), ORIGIN)).toBeNull();
  });

  it("steps aside when PUBLIC_ORIGIN is not a URL, which the config check reports", () => {
    expect(offOrigin(new Request(`${OLD}/`), "not a url")).toBeNull();
  });

  it("compares origins, so a trailing slash in the variable does not matter", () => {
    expect(offOrigin(new Request(`${ORIGIN}/x`), `${ORIGIN}/`)).toBeNull();
  });

  it.each([
    "http://127.0.0.1:8787/api/health",
    "http://localhost:8787/",
    "https://www.bloop.here/security",
    "https://random.example/privacy",
    "https://notworkers.dev/",
  ])("leaves %s to the Origin and config checks", (from) => {
    expect(offOrigin(new Request(from), ORIGIN)).toBeNull();
    expect(offOrigin(new Request(from, { method: "POST", body: "{}" }), ORIGIN)).toBeNull();
  });

  it("leaves a local origin's own host alone", () => {
    expect(offOrigin(new Request("http://127.0.0.1:8787/s"), "http://127.0.0.1:8787")).toBeNull();
  });

  it.each([
    [`${OLD}/`, `${ORIGIN}/`],
    [`${OLD}/a?c=ABC123`, `${ORIGIN}/a?c=ABC123`],
    [`${OLD}/f/token/name.pdf?x=1&y=2`, `${ORIGIN}/f/token/name.pdf?x=1&y=2`],
    ["https://anything.workers.dev/privacy", `${ORIGIN}/privacy`],
    ["http://bloop.here/privacy?x=1", `${ORIGIN}/privacy?x=1`],
  ])("moves GET %s to %s, for an hour", async (from, to) => {
    const res = offOrigin(new Request(from), ORIGIN);
    expect(res?.status).toBe(301);
    expect(res?.headers.get("Location")).toBe(to);
    expect(res?.headers.get("Cache-Control")).toBe("max-age=3600");
    expect(res?.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(await res?.text()).toBe("");
  });

  it("moves HEAD too", () => {
    expect(offOrigin(new Request(`${OLD}/privacy`, { method: "HEAD" }), ORIGIN)?.status).toBe(301);
  });

  it("refuses a write, with no Location to follow", async () => {
    const res = offOrigin(new Request(`${OLD}/api/screens`, { method: "POST", body: "{}" }), ORIGIN);
    expect(res?.status).toBe(403);
    expect(res?.headers.get("Location")).toBeNull();
    expect(await res?.json()).toMatchObject({ code: "forbidden_origin" });
  });

  it("refuses a WebSocket upgrade", () => {
    const res = offOrigin(new Request(`${OLD}/api/ws?ref=x`, { headers: { Upgrade: "websocket" } }), ORIGIN);
    expect(res?.status).toBe(403);
    expect(res?.headers.get("Location")).toBeNull();
  });
});
