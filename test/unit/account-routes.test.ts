import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/worker/ids.ts";
import type { TestDb } from "./d1-shim.ts";
import { type AnyRoute, addSession, callRoute, memberWorld, routesOf, seedMember, sid } from "./member-fixture.ts";

/** The account routes with spies in place of the live layer and the block list. */
async function spied(blocked = false) {
  const calls: unknown[][] = [];
  const path = "../../src/worker/routes/account.ts";
  const { accountRoutesWith } = (await import(path)) as { accountRoutesWith: (deps: object) => readonly AnyRoute[] };
  const routes = accountRoutesWith({
    endScreens: async (_env: unknown, userId: string, scope?: object) => {
      calls.push(["endScreens", userId, scope ?? {}]);
    },
    closeSession: async (_env: unknown, publicId: string) => {
      calls.push(["closeSession", publicId]);
    },
    isBlocked: async () => blocked,
  });
  return { calls, routes };
}

const publicId = async (db: TestDb, value: string) =>
  (
    db.raw.prepare("SELECT public_id FROM phone_session WHERE id_hash = ?").get(await sha256Hex(value)) as {
      public_id: string;
    }
  ).public_id;

describe("AUTH-13 signout-all: every session and every screen end", () => {
  it("AUTH-13 signout-all: both sessions die, endScreens covers the account and each session is closed", async () => {
    const world = memberWorld();
    const { calls, routes } = await spied();
    const a = await seedMember(world.db, "m1", "m@example.test");
    const b = await addSession(world.db, "m1");
    const ids = [await publicId(world.db, a), await publicId(world.db, b)];
    const res = await callRoute(routes, world.env, "POST", "/api/me/signout-all", { cookie: sid(a) });
    expect(res.status).toBe(200);
    expect(world.db.raw.prepare("SELECT count(*) AS n FROM phone_session").get()).toEqual({ n: 0 });
    expect(calls[0]).toEqual(["endScreens", "m1", {}]);
    expect(calls.slice(1).sort()).toEqual(ids.map((id) => ["closeSession", id]).sort());
    expect(res.headers.getSetCookie().map((c) => c.split("=")[0])).toEqual([
      "__Host-bloop_sid",
      "__Host-bloop_in",
      "__Host-bloop_dev",
    ]);
  });

  it("AUTH-13 signout-all: a plain sign-out ends only this session and its own screens, and keeps the device", async () => {
    const world = memberWorld();
    const { calls, routes } = await spied();
    const a = await seedMember(world.db, "m1", "m@example.test");
    const other = await seedMember(world.db, "m2", "o@example.test");
    const id = await publicId(world.db, a);
    const res = await callRoute(routes, world.env, "POST", "/api/me/signout", { cookie: sid(a) });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      ["endScreens", "m1", { bySession: id }],
      ["closeSession", id],
    ]);
    expect(res.headers.getSetCookie().map((c) => c.split("=")[0])).toEqual(["__Host-bloop_sid", "__Host-bloop_in"]);
    expect(world.db.raw.prepare("SELECT count(*) AS n FROM phone_session").get()).toEqual({ n: 1 });
    expect((await callRoute(routes, world.env, "GET", "/api/me/sessions", { cookie: sid(other) })).status).toBe(200);
  });

  it("AUTH-13 signout-all: a deletion request ends every screen and closes every other session", async () => {
    const world = memberWorld();
    const { calls, routes } = await spied();
    const a = await seedMember(world.db, "m1", "m@example.test");
    const b = await addSession(world.db, "m1");
    const otherId = await publicId(world.db, b);
    const res = await callRoute(routes, world.env, "DELETE", "/api/me", { cookie: sid(a) });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      ["endScreens", "m1", {}],
      ["closeSession", otherId],
    ]);
  });
});

describe("the devices list: DELETE /api/me/sessions/:id", () => {
  it("ends another of the member's sessions and its screens; refuses the current one, a stranger's and a bad id", async () => {
    const world = memberWorld();
    const { calls, routes } = await spied();
    const mine = await seedMember(world.db, "m1", "m@example.test");
    const second = await addSession(world.db, "m1");
    const stranger = await seedMember(world.db, "m2", "o@example.test");
    const del = (id: string) =>
      callRoute(routes, world.env, "DELETE", `/api/me/sessions/${id}`, { cookie: sid(mine) }).then((r) => r.status);
    expect(await del(await publicId(world.db, mine))).toBe(400);
    expect(await del(await publicId(world.db, stranger))).toBe(404);
    expect(await del("not-an-id")).toBe(400);
    const secondId = await publicId(world.db, second);
    expect(await del(secondId)).toBe(204);
    expect(calls).toEqual([
      ["endScreens", "m1", { bySession: secondId }],
      ["closeSession", secondId],
    ]);
    const list = await callRoute(routes, world.env, "GET", "/api/me/sessions", { cookie: sid(mine) });
    expect(((await list.json()) as { current: boolean }[]).map((s) => s.current)).toEqual([true]);
  });
});

describe("restore: POST /api/me/restore", () => {
  const deleting = async (world: ReturnType<typeof memberWorld>, deleteAfter: number) => {
    const cookie = await seedMember(world.db, "m1", "m@example.test");
    world.db.raw.prepare("UPDATE app_user SET status = 'deleting', delete_after = ? WHERE id = 'm1'").run(deleteAfter);
    return cookie;
  };
  const status = (world: ReturnType<typeof memberWorld>) =>
    (world.db.raw.prepare("SELECT status FROM app_user WHERE id = 'm1'").get() as { status: string }).status;

  it("cancels the deletion inside the grace", async () => {
    const world = memberWorld();
    const { routes } = await spied();
    const cookie = await deleting(world, Date.now() + 86_400_000);
    const res = await callRoute(routes, world.env, "POST", "/api/me/restore", { cookie: sid(cookie) });
    expect(await res.json()).toEqual({ signedIn: true, deleting: false });
    expect(status(world)).toBe("active");
  });

  it("is restore_too_late past the grace, and for a blocked address however early", async () => {
    const late = memberWorld();
    const lateCookie = await deleting(late, Date.now() - 1);
    const res = await callRoute((await spied()).routes, late.env, "POST", "/api/me/restore", {
      cookie: sid(lateCookie),
    });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: "restore_too_late" });
    const blocked = memberWorld();
    const cookie = await deleting(blocked, Date.now() + 86_400_000);
    const refused = await callRoute((await spied(true)).routes, blocked.env, "POST", "/api/me/restore", {
      cookie: sid(cookie),
    });
    expect(await refused.json()).toMatchObject({ code: "restore_too_late" });
    expect(status(blocked)).toBe("deleting");
  });
});

describe("the admin view cookie: POST /api/admin/view", () => {
  it("an admin turns the view cookie on and off; it is HttpOnly and never readable by script", async () => {
    const world = memberWorld();
    const admin = await seedMember(world.db, "a1", "admin@example.test");
    const routes = await routesOf("admin", "adminRoutes");
    const on = await callRoute(routes, world.env, "POST", "/api/admin/view", {
      cookie: sid(admin),
      body: { open: true },
    });
    expect(await on.json()).toEqual({ viewing: true });
    expect(on.headers.getSetCookie()).toEqual([
      "__Host-bloop_view=open; Max-Age=86400; Path=/; Secure; HttpOnly; SameSite=Lax",
    ]);
    const off = await callRoute(routes, world.env, "POST", "/api/admin/view", {
      cookie: sid(admin),
      body: { open: false },
    });
    expect(off.headers.getSetCookie()).toEqual([
      "__Host-bloop_view=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax",
    ]);
    const bad = await callRoute(routes, world.env, "POST", "/api/admin/view", {
      cookie: sid(admin),
      body: { open: "yes" },
    });
    expect(bad.status).toBe(400);
  });
});
