import { describe, expect, it } from "vitest";
import { callRoute, memberWorld, routesOf, seedMember, sid } from "./member-fixture.ts";

describe("the admin view cookie: POST /api/admin/view", () => {
  it("an admin turns the view cookie on (8 hours) and off, each with its admin_action row; it is HttpOnly", async () => {
    const world = memberWorld();
    const admin = await seedMember(world.db, "a1", "admin@example.test");
    const routes = await routesOf("admin", "adminRoutes");
    const toggle = (body: unknown) =>
      callRoute(routes, world.env, "POST", "/api/admin/view", { cookie: sid(admin), body });
    const on = await toggle({ open: true, reason: "  check the open landing  " });
    expect(await on.json()).toEqual({ viewing: true });
    expect(on.headers.getSetCookie()).toEqual([
      "__Host-bloop_view=open; Max-Age=28800; Path=/; Secure; HttpOnly; SameSite=Lax",
    ]);
    // Control and format characters are dropped before the reason is stored: it stays one plain line.
    const off = await toggle({ open: false, reason: "do\u202Ene\r\n" });
    expect(off.headers.getSetCookie()).toEqual([
      "__Host-bloop_view=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax",
    ]);
    const rows = world.db.raw
      .prepare("SELECT admin_user_id, action, target_kind, target_id, reason FROM admin_action ORDER BY id")
      .all();
    expect(rows).toEqual([
      {
        admin_user_id: "a1",
        action: "view.open",
        target_kind: "user",
        target_id: "a1",
        reason: "check the open landing",
      },
      { admin_user_id: "a1", action: "view.close", target_kind: "user", target_id: "a1", reason: "done" },
    ]);
    for (const body of [
      { open: "yes", reason: "x" },
      { open: true },
      { open: true, reason: "   " },
      { open: true, reason: "\u200B\u202E\n" },
      { open: true, reason: "r".repeat(501) },
    ]) {
      const bad = await toggle(body);
      expect(bad.status, JSON.stringify(body)).toBe(400);
      expect(await bad.json()).toMatchObject({ code: "bad_request" });
      expect(bad.headers.getSetCookie()).toEqual([]);
    }
    expect(world.db.raw.prepare("SELECT count(*) AS n FROM admin_action").get()).toEqual({ n: 2 });
  });

  it("a reason is stored whole up to 500 characters and refused past it, never cut", async () => {
    const world = memberWorld();
    const admin = await seedMember(world.db, "a1", "admin@example.test");
    const routes = await routesOf("admin", "adminRoutes");
    const toggle = (reason: string) =>
      callRoute(routes, world.env, "POST", "/api/admin/view", { cookie: sid(admin), body: { open: true, reason } });
    expect((await toggle("r".repeat(500))).status).toBe(200);
    // Control characters do not count toward the limit, since they are dropped first.
    expect((await toggle(`${"s".repeat(500)}\u200B\n`)).status).toBe(200);
    const tooLong = await toggle("t".repeat(501));
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toMatchObject({ code: "bad_request" });
    const stored = world.db.raw.prepare("SELECT reason FROM admin_action ORDER BY id").all() as { reason: string }[];
    expect(stored.map((r) => r.reason)).toEqual(["r".repeat(500), "s".repeat(500)]);
  });
});
