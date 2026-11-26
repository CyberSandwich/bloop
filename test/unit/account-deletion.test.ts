import { describe, expect, it } from "vitest";
import { addSession, callRoute, memberWorld, publicId, seedMember, sid, spied } from "./member-fixture.ts";

describe("DATA-05 dsar: a deletion request", () => {
  it("DATA-05 dsar: a deletion request ends every screen and closes every other session, in one batch with the status", async () => {
    const world = memberWorld();
    const { calls, routes } = await spied();
    const a = await seedMember(world.db, "m1", "m@example.test");
    const b = await addSession(world.db, "m1");
    const otherId = await publicId(world.db, b);
    const res = await callRoute(routes, world.env, "DELETE", "/api/me", { cookie: sid(a) });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      ["endScreens", "m1", {}],
      ["closeSessions", "m1", [otherId]],
    ]);
    expect(world.db.raw.prepare("SELECT status FROM app_user WHERE id = 'm1'").get()).toEqual({ status: "deleting" });
    expect(world.db.raw.prepare("SELECT count(*) AS n FROM phone_session").get()).toEqual({ n: 1 });
  });

  it("DATA-05 dsar: a failed batch changes neither the status nor any session", async () => {
    const world = memberWorld();
    const { routes } = await spied();
    const a = await seedMember(world.db, "m1", "m@example.test");
    await addSession(world.db, "m1");
    // The second statement fails inside the batch, so the first must roll back with it.
    world.db.raw.exec(
      "CREATE TRIGGER no_delete BEFORE DELETE ON phone_session BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    await expect(callRoute(routes, world.env, "DELETE", "/api/me", { cookie: sid(a) })).rejects.toThrow(/refused/);
    expect(world.db.raw.prepare("SELECT status FROM app_user WHERE id = 'm1'").get()).toEqual({ status: "active" });
    expect(world.db.raw.prepare("SELECT count(*) AS n FROM phone_session").get()).toEqual({ n: 2 });
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
