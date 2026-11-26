import { describe, expect, it } from "vitest";
import { deviceEpoch } from "../../src/worker/auth/codes.ts";
import { type AnyRoute, addSession, callRoute, GRAPH, memberWorld, seedMember, sid } from "./member-fixture.ts";

async function watched() {
  const calls: unknown[][] = [];
  // A non-literal specifier: auth.ts's type graph needs the Workers types the test tsconfig omits.
  const path = "../../src/worker/routes/auth.ts";
  const { authRoutesWith } = (await import(path)) as { authRoutesWith: (deps: object) => readonly AnyRoute[] };
  const routes = authRoutesWith({
    endScreens: async (_env: unknown, userId: string, scope?: object) => {
      calls.push(["endScreens", userId, scope ?? {}]);
    },
    closeSessions: async (_env: unknown, userId: string, publicIds: readonly string[]) => {
      calls.push(["closeSessions", userId, publicIds.length]);
    },
  });
  return { calls, routes };
}

describe("AUTH-07 disconnect: the grant and every session go, with sign out everywhere's cleanup", () => {
  it("AUTH-07 disconnect: ends every screen and session in one call each, and moves the device epoch", async () => {
    const world = memberWorld(GRAPH);
    const { calls, routes } = await watched();
    const cookie = await seedMember(world.db, "e1", "e@example.test", { method: "entra" }, { tid: "tenant-a" });
    await addSession(world.db, "e1", { method: "entra" });
    const res = await callRoute(routes, world.env, "POST", "/api/me/disconnect", { cookie: sid(cookie) });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      ["endScreens", "e1", {}],
      ["closeSessions", "e1", 2],
    ]);
    expect(world.db.raw.prepare("SELECT count(*) AS n FROM phone_session").get()).toEqual({ n: 0 });
    expect(await deviceEpoch(world.db, "e1")).toBe(1);
  });
});
