// Every member and admin route spends the coarse per-IP meter before its first D1 read. The walk loads every route
// module, so a member route a new module adds is covered without a list to update.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Statement } from "../../src/worker/auth/db.ts";
import { type AnyRoute, callRoute, GRAPH, memberWorld, recordingLimits, seedMember, sid } from "./member-fixture.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const ROUTES = fileURLToPath(new URL("../../src/worker/routes/", import.meta.url));
const MEMBER_PATH = /^\/api\/(me|admin)(\/|$)/;

const isRoute = (v: unknown): v is AnyRoute =>
  typeof v === "object" && v !== null && "pattern" in v && "methods" in v && "handler" in v;

/**
 * Every exported route table in the route modules that name a member or admin path, filtered to those paths. Only
 * those are imported: another module pulls in assets (a .pptx) the unit runner cannot load.
 */
async function memberRoutes(): Promise<AnyRoute[]> {
  const found: AnyRoute[] = [];
  const named = (f: string) => /["'`]\/api\/(me|admin)\b/.test(readFileSync(`${ROUTES}${f}`, "utf8"));
  for (const file of readdirSync(ROUTES).filter((f) => f.endsWith(".ts") && named(f))) {
    for (const value of Object.values(await import(`${ROUTES}${file}`)))
      if (Array.isArray(value)) found.push(...value.filter(isRoute));
  }
  return found.filter((r) => MEMBER_PATH.test(r.pattern.pathname));
}

describe("AUTH-19 meter: no D1 read before the per-IP meter", () => {
  it("AUTH-19 meter: every member and admin route in every route module, with a live or a forged cookie, spends RL_MEMBER_IP before it touches D1", async () => {
    const routes = await memberRoutes();
    const calls = routes.flatMap((r) => r.methods.map((m) => [r, m] as const));
    expect(calls.map(([r, m]) => `${m} ${r.pattern.pathname}`)).toContain("POST /api/me/disconnect");
    for (const [r, method] of calls) {
      const path = r.pattern.pathname.replace(/:(\w+)/g, "A".repeat(22));
      for (const live of [true, false]) {
        const world = memberWorld({ ...GRAPH, TEST_TIMING: "0" });
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
        const value = live ? cookie : "A".repeat(43);
        await callRoute([r], env, method, path, { cookie: sid(value) }).catch(() => undefined);
        const label = `${method} ${path} ${live ? "live" : "forged"} cookie`;
        const firstRead = seen.findIndex(([name]) => name === "D1");
        // Each variant must reach D1, so a route that skips it under one cookie cannot hide behind the others.
        expect(firstRead, label).toBeGreaterThanOrEqual(0);
        const meter = seen.findIndex(([name]) => name === "RL_MEMBER_IP");
        expect(meter, label).toBeGreaterThanOrEqual(0);
        expect(meter, label).toBeLessThan(firstRead);
      }
    }
  });
});
