// Every member and admin route spends the coarse per-IP meter before its first D1 read, walked from the route tables.
import { describe, expect, it } from "vitest";
import type { Statement } from "../../src/worker/auth/db.ts";
import {
  type AnyRoute,
  callRoute,
  memberWorld,
  recordingLimits,
  routesOf,
  seedMember,
  sid,
  spied,
} from "./member-fixture.ts";

describe("member routes: no D1 read before the per-IP meter", () => {
  it("every account and admin route, signed in or not, spends RL_MEMBER_IP before it touches D1", async () => {
    const tables: readonly AnyRoute[] = [...(await spied()).routes, ...(await routesOf("admin", "adminRoutes"))];
    const calls = tables.flatMap((r) => r.methods.map((m) => [r, m] as const));
    expect(calls.length).toBeGreaterThanOrEqual(12);
    for (const [r, method] of calls) {
      const path = r.pattern.pathname.replace(/:(\w+)/g, "A".repeat(22));
      for (const signedIn of [true, false]) {
        const world = memberWorld({ TEST_TIMING: "0" });
        const cookie = await seedMember(world.db, "m1", "admin@example.test");
        const { seen, bindings } = recordingLimits();
        const db = {
          ...world.db,
          prepare: (sql: string): Statement => {
            seen.push(["D1", sql]);
            return world.db.prepare(sql);
          },
        };
        const env = { ...world.env, ...bindings, DB: db };
        await callRoute(tables, env, method, path, signedIn ? { cookie: sid(cookie) } : {}).catch(() => undefined);
        const label = `${method} ${path} ${signedIn ? "signed in" : "signed out"}`;
        const firstRead = seen.findIndex(([name]) => name === "D1");
        const meter = seen.findIndex(([name]) => name === "RL_MEMBER_IP");
        expect(meter, label).toBeGreaterThanOrEqual(0);
        if (firstRead >= 0) expect(meter, label).toBeLessThan(firstRead);
      }
    }
  });
});
