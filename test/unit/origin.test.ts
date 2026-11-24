import { describe, expect, it } from "vitest";
import { offOrigin } from "../../src/worker/origin.ts";

const ORIGIN = "https://bloop.here";
const OLD = "https://bloop.dsap.workers.dev";

describe("offOrigin", () => {
  it("lets a request on the origin through", () => {
    expect(offOrigin(new Request(`${ORIGIN}/s?mode=demo`), ORIGIN)).toBeNull();
    expect(offOrigin(new Request(`${ORIGIN}/api/screens`, { method: "POST" }), ORIGIN)).toBeNull();
  });

  it.each([
    [`${OLD}/`, `${ORIGIN}/`],
    [`${OLD}/a?c=ABC123`, `${ORIGIN}/a?c=ABC123`],
    [`${OLD}/f/token/name.pdf?x=1&y=2`, `${ORIGIN}/f/token/name.pdf?x=1&y=2`],
    [`http://bloop.here/privacy`, `${ORIGIN}/privacy`],
    [`https://www.bloop.here/security`, `${ORIGIN}/security`],
  ])("moves GET %s for good to %s", async (from, to) => {
    const res = offOrigin(new Request(from), ORIGIN);
    expect(res?.status).toBe(301);
    expect(res?.headers.get("Location")).toBe(to);
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
