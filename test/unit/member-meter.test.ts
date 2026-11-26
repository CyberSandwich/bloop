// Every member and admin route, and the member page gate, spends the coarse per-IP meter before its first session
// read. The walk loads every route module, so a member route a new module adds is covered without a list to update.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Statement } from "../../src/worker/auth/db.ts";
import type { Variant } from "../../src/worker/page-registry.ts";
import { type PageEnv, servePage } from "../../src/worker/pages.ts";
import {
  type AnyRoute,
  callRoute,
  GRAPH,
  memberWorld,
  recordingLimits,
  seedMember,
  setMode,
  sid,
} from "./member-fixture.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const ROUTES = fileURLToPath(new URL("../../src/worker/routes/", import.meta.url));
const MEMBER_PATH = /^\/api\/(me|admin|uploads)(\/|$)/;

const isRoute = (v: unknown): v is AnyRoute =>
  typeof v === "object" && v !== null && "pattern" in v && "methods" in v && "handler" in v;

/**
 * Every exported route table in the route modules that name a member or admin path, filtered to those paths. Only
 * those are imported: another module pulls in assets (a .pptx) the unit runner cannot load.
 */
async function memberRoutes(): Promise<AnyRoute[]> {
  const found: AnyRoute[] = [];
  const named = (f: string) => /["'`]\/api\/(me|admin|uploads)\b/.test(readFileSync(`${ROUTES}${f}`, "utf8"));
  for (const file of readdirSync(ROUTES).filter((f) => f.endsWith(".ts") && named(f))) {
    for (const value of Object.values(await import(`${ROUTES}${file}`)))
      if (Array.isArray(value)) found.push(...value.filter(isRoute));
  }
  return found.filter((r) => MEMBER_PATH.test(r.pattern.pathname));
}

/** A member world whose limiter and D1 both log into `seen`, in order; `refuse` names limits that say no. */
async function metered(refuse: string[] = []) {
  const world = memberWorld({ ...GRAPH, TEST_TIMING: "0" });
  const cookie = await seedMember(world.db, "m1", "admin@example.test");
  const { seen, bindings } = recordingLimits(refuse);
  const db = {
    ...world.db,
    prepare: (sql: string): Statement => {
      seen.push(["D1", sql]);
      return world.db.prepare(sql);
    },
  };
  return { world, cookie, seen, env: { ...world.env, ...bindings, DB: db } };
}

describe("AUTH-19 meter: no D1 read before the per-IP meter", () => {
  it("AUTH-19 meter: every member and admin route in every route module, with a live or a forged cookie, spends RL_MEMBER_IP before it touches D1", async () => {
    const routes = await memberRoutes();
    const calls = routes.flatMap((r) => r.methods.map((m) => [r, m] as const));
    expect(calls.map(([r, m]) => `${m} ${r.pattern.pathname}`)).toContain("POST /api/me/disconnect");
    for (const [r, method] of calls) {
      const path = r.pattern.pathname.replace(/:(\w+)/g, "A".repeat(22));
      for (const live of [true, false]) {
        const { cookie, seen, env } = await metered();
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

describe("AUTH-19 meter: the member page gate", () => {
  const PRIVACY: Variant[] = [{ path: "/privacy", kind: "both" }];
  const page = async (env: object, path: string, cookie?: string, variants?: Variant[]) => {
    const assets = {
      fetch: async (request: Request) => {
        const at = new URL(request.url).pathname;
        return at === "/.missing" ? new Response("not found", { status: 404 }) : new Response(`asset ${at}`);
      },
    };
    const headers: Record<string, string> = cookie ? { Cookie: cookie } : {};
    const res = await servePage(
      new Request(`http://localhost:8787${path}`, { headers }),
      { ...env, ASSETS: assets } as unknown as PageEnv,
      variants,
    );
    return { status: res.status, text: await res.text() };
  };
  const sessionReads = (seen: [string, string][]) =>
    seen.flatMap(([name, sql], i) => (name === "D1" && sql.includes("phone_session") ? [i] : []));

  it("AUTH-19 meter: a session cookie of the wrong shape is dropped before any session read or meter", async () => {
    const { world, seen, env } = await metered();
    setMode(world.db, "preview");
    const signedOut = await page(env, "/library");
    seen.length = 0;
    expect(await page(env, "/library", sid("not-a-session"))).toEqual(signedOut);
    expect(sessionReads(seen)).toEqual([]);
    expect(seen.some(([name]) => name === "RL_MEMBER_IP")).toBe(false);
  });

  it("AUTH-19 meter: a well-formed cookie spends RL_MEMBER_IP before the session lookup", async () => {
    const { world, cookie, seen, env } = await metered();
    setMode(world.db, "preview");
    expect(await page(env, "/library", sid(cookie))).toEqual({ status: 200, text: "asset /library" });
    const meter = seen.findIndex(([name]) => name === "RL_MEMBER_IP");
    expect(meter).toBeGreaterThanOrEqual(0);
    expect(sessionReads(seen)[0]).toBeGreaterThan(meter);
  });

  it("AUTH-19 meter: over RL_MEMBER_IP a page renders as for a signed-out visitor, a 200 for the open view, never an error", async () => {
    const { world, cookie, seen, env } = await metered(["RL_MEMBER_IP"]);
    setMode(world.db, "preview");
    expect(await page(env, "/library", sid(cookie))).toEqual(await page(env, "/library"));
    const viewer = `${sid(cookie)}; __Host-bloop_view=open`;
    expect(await page(env, "/privacy", viewer, PRIVACY)).toEqual({ status: 200, text: "asset /privacy" });
    expect(sessionReads(seen)).toEqual([]);
  });

  it("AUTH-19 meter: over RL_MEMBER_IP an admin's /admin is the unknown path's 404, as for a signed-out visitor", async () => {
    const { world, cookie, env } = await metered(["RL_MEMBER_IP"]);
    setMode(world.db, "preview");
    const signedOut = await page(env, "/admin");
    expect(signedOut.status).toBe(404);
    expect(await page(env, "/admin", sid(cookie))).toEqual(signedOut);
  });

  it("AUTH-19 meter: with the limits live, a non-admin member's /admin spends the meter and is the 404", async () => {
    const { world, seen, env } = await metered();
    setMode(world.db, "preview");
    const member = await seedMember(world.db, "m2", "member@example.test");
    expect(await page(env, "/admin", sid(member))).toEqual(await page(env, "/admin"));
    expect(seen.some(([name]) => name === "RL_MEMBER_IP")).toBe(true);
  });

  it("AUTH-19 meter: a missing RL_MEMBER_IP binding hides the page, logs once, and never answers 500", async () => {
    const { world, cookie, env } = await metered();
    setMode(world.db, "preview");
    const { RL_MEMBER_IP: _gone, ...bare } = env as Record<string, unknown>;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const signedOut = await page(bare, "/library");
      for (let i = 0; i < 2; i++) expect(await page(bare, "/library", sid(cookie))).toEqual(signedOut);
      expect(signedOut.status).toBe(404);
      const missing = errors.mock.calls.filter(([line]) => String(line) === "rate-limit binding missing: RL_MEMBER_IP");
      expect(missing).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
  });

  it("AUTH-19 meter: the admin open view with a malformed session cookie spends no meter and shows today's page", async () => {
    const { world, seen, env } = await metered();
    setMode(world.db, "preview");
    const viewer = `${sid("not-a-session")}; __Host-bloop_view=open`;
    expect(await page(env, "/privacy", viewer, PRIVACY)).toEqual({ status: 200, text: "asset /privacy" });
    expect(seen.some(([name]) => name === "RL_MEMBER_IP")).toBe(false);
    expect(sessionReads(seen)).toEqual([]);
  });
});
