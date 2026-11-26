import { describe, expect, it } from "vitest";
import { deviceEpoch, isKnown, newDeviceValue } from "../../src/worker/auth/codes.ts";
import { sha256Hex } from "../../src/worker/ids.ts";
import { declaredRateLimits } from "../env-vars.ts";
import type { TestDb } from "./d1-shim.ts";
import {
  type AnyRoute,
  addSession,
  callRoute,
  memberWorld,
  ORIGIN,
  routesOf,
  seedMember,
  sid,
} from "./member-fixture.ts";

type Deps = Record<string, unknown>;

/** The account routes with spies in place of the live layer and the block list; `over` replaces any of them. */
async function spied(blocked = false, over: Deps = {}) {
  const calls: unknown[][] = [];
  const path = "../../src/worker/routes/account.ts";
  const { accountRoutesWith } = (await import(path)) as { accountRoutesWith: (deps: object) => readonly AnyRoute[] };
  const routes = accountRoutesWith({
    endScreens: async (_env: unknown, userId: string, scope?: object) => {
      calls.push(["endScreens", userId, scope ?? {}]);
    },
    closeSessions: async (_env: unknown, userId: string, publicIds: readonly string[]) => {
      calls.push(["closeSessions", userId, [...publicIds].sort()]);
    },
    isBlocked: async () => blocked,
    ...over,
  });
  return { calls, routes };
}

const publicId = async (db: TestDb, value: string) =>
  (
    db.raw.prepare("SELECT public_id FROM phone_session WHERE id_hash = ?").get(await sha256Hex(value)) as {
      public_id: string;
    }
  ).public_id;

const cookieNames = (res: Response) => res.headers.getSetCookie().map((c) => c.split("=")[0]);

describe("AUTH-13 signout-all: every session and every screen end", () => {
  it("AUTH-13 signout-all: both sessions die, endScreens covers the account and one call closes every session", async () => {
    const world = memberWorld();
    const { calls, routes } = await spied();
    const a = await seedMember(world.db, "m1", "m@example.test");
    const b = await addSession(world.db, "m1");
    const ids = [await publicId(world.db, a), await publicId(world.db, b)].sort();
    const res = await callRoute(routes, world.env, "POST", "/api/me/signout-all", { cookie: sid(a) });
    expect(res.status).toBe(200);
    expect(world.db.raw.prepare("SELECT count(*) AS n FROM phone_session").get()).toEqual({ n: 0 });
    expect(calls).toEqual([
      ["endScreens", "m1", {}],
      ["closeSessions", "m1", ids],
    ]);
    expect(cookieNames(res)).toEqual(["__Host-bloop_sid", "__Host-bloop_in", "__Host-bloop_dev"]);
  });

  it("AUTH-13 signout-all: 150 sessions end in one statement, with no id list bound", async () => {
    const world = memberWorld();
    const { calls, routes } = await spied();
    const a = await seedMember(world.db, "m1", "m@example.test");
    for (let i = 0; i < 149; i++) await addSession(world.db, "m1");
    const res = await callRoute(routes, world.env, "POST", "/api/me/signout-all", { cookie: sid(a) });
    expect(res.status).toBe(200);
    expect(calls[1]?.[2]).toHaveLength(150);
    expect(world.db.raw.prepare("SELECT count(*) AS n FROM phone_session").get()).toEqual({ n: 0 });
  });

  it("AUTH-13 signout-all: a library that cannot be reached still ends the sessions and clears the cookies", async () => {
    const world = memberWorld();
    const path = "../../src/worker/auth/screens.ts";
    const { librarySessions } = (await import(path)) as { librarySessions: (on: boolean) => unknown };
    const broken = {
      jurisdiction: () => {
        throw new Error("namespace unavailable");
      },
      idFromName: () => {
        throw new Error("namespace unavailable");
      },
    };
    const env = { ...world.env, USER_LIBRARY: broken };
    const { routes } = await spied(false, { closeSessions: librarySessions(true) });
    const a = await seedMember(world.db, "m1", "m@example.test");
    for (const path of ["/api/me/signout-all", "/api/me/signout"]) {
      const cookie = path === "/api/me/signout" ? await addSession(world.db, "m1") : a;
      const res = await callRoute(routes, env, "POST", path, { cookie: sid(cookie) });
      expect(res.status, path).toBe(200);
      expect(await res.json()).toEqual({ signedIn: false });
      expect(cookieNames(res).slice(0, 2)).toEqual(["__Host-bloop_sid", "__Host-bloop_in"]);
    }
    expect(world.db.raw.prepare("SELECT count(*) AS n FROM phone_session").get()).toEqual({ n: 0 });
  });
});

describe("sign-out", () => {
  it("a plain sign-out ends only this session and its own screens, and keeps the device", async () => {
    const world = memberWorld();
    const { calls, routes } = await spied();
    const a = await seedMember(world.db, "m1", "m@example.test");
    const other = await seedMember(world.db, "m2", "o@example.test");
    const id = await publicId(world.db, a);
    const res = await callRoute(routes, world.env, "POST", "/api/me/signout", { cookie: sid(a) });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      ["endScreens", "m1", { bySession: id }],
      ["closeSessions", "m1", [id]],
    ]);
    expect(cookieNames(res)).toEqual(["__Host-bloop_sid", "__Host-bloop_in"]);
    expect(world.db.raw.prepare("SELECT count(*) AS n FROM phone_session").get()).toEqual({ n: 1 });
    expect((await callRoute(routes, world.env, "GET", "/api/me/sessions", { cookie: sid(other) })).status).toBe(200);
  });

  it("a dead or missing session still clears the session and hint cookies, and ends nothing", async () => {
    const world = memberWorld();
    const { calls, routes } = await spied();
    for (const path of ["/api/me/signout", "/api/me/signout-all"]) {
      for (const cookie of [sid("A".repeat(43)), undefined]) {
        const res = await callRoute(routes, world.env, "POST", path, cookie ? { cookie } : {});
        expect(res.status, path).toBe(401);
        expect(cookieNames(res).slice(0, 2), path).toEqual(["__Host-bloop_sid", "__Host-bloop_in"]);
      }
    }
    expect(calls).toEqual([]);
  });
});

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

describe("AUTH-18 epoch: a known-device value dies with every change that forgets devices", () => {
  const PEPPER = "p".repeat(32);
  const epoch = (world: ReturnType<typeof memberWorld>) => deviceEpoch(world.db, "m1");
  const addPasskey = (world: ReturnType<typeof memberWorld>) =>
    world.db.raw
      .prepare(
        "INSERT INTO passkey (id, user_id, public_key, sign_count, backed_up, name, created_at) VALUES ('cred-1', 'm1', x'00', 0, 1, 'Passkey', 0)",
      )
      .run();

  it("AUTH-18 epoch: a device value minted before sign out everywhere is refused after it, on every device", async () => {
    const world = memberWorld();
    const { routes } = await spied();
    const a = await seedMember(world.db, "m1", "m@example.test");
    await addSession(world.db, "m1");
    const before = await epoch(world);
    const laptop = await newDeviceValue(PEPPER, "m1", before);
    const phone = await newDeviceValue(PEPPER, "m1", before);
    expect(await isKnown(laptop, PEPPER, "m1", before)).toBe(true);
    expect((await callRoute(routes, world.env, "POST", "/api/me/signout-all", { cookie: sid(a) })).status).toBe(200);
    const after = await epoch(world);
    expect(after).toBe(before + 1);
    for (const value of [laptop, phone]) expect(await isKnown(value, PEPPER, "m1", after)).toBe(false);
    expect(await isKnown(await newDeviceValue(PEPPER, "m1", after), PEPPER, "m1", after)).toBe(true);
  });

  it("AUTH-18 epoch: a plain sign-out keeps the device known", async () => {
    const world = memberWorld();
    const a = await seedMember(world.db, "m1", "m@example.test");
    await callRoute((await spied()).routes, world.env, "POST", "/api/me/signout", { cookie: sid(a) });
    expect(await epoch(world)).toBe(0);
  });

  it("AUTH-18 epoch: removing a passkey moves it; a refused removal does not", async () => {
    const world = memberWorld();
    const { routes } = await spied();
    const a = await seedMember(world.db, "m1", "m@example.test");
    addPasskey(world);
    const remove = (id: string) =>
      callRoute(routes, world.env, "DELETE", `/api/me/passkeys/${id}`, { cookie: sid(a) }).then((r) => r.status);
    expect(await remove("cred-2")).toBe(404);
    expect(await epoch(world)).toBe(0);
    expect(await remove("cred-1")).toBe(204);
    expect(await epoch(world)).toBe(1);
  });

  it("AUTH-18 epoch: a deletion request moves it in the same batch as the status", async () => {
    const world = memberWorld();
    const a = await seedMember(world.db, "m1", "m@example.test");
    await callRoute((await spied()).routes, world.env, "DELETE", "/api/me", { cookie: sid(a) });
    expect(world.db.raw.prepare("SELECT status, device_epoch FROM app_user WHERE id = 'm1'").get()).toEqual({
      status: "deleting",
      device_epoch: 1,
    });
  });

  it("AUTH-18 epoch: ending one other session moves it; a refused id does not", async () => {
    const world = memberWorld();
    const { routes } = await spied();
    const mine = await seedMember(world.db, "m1", "m@example.test");
    const other = await addSession(world.db, "m1");
    const end = (id: string) =>
      callRoute(routes, world.env, "DELETE", `/api/me/sessions/${id}`, { cookie: sid(mine) }).then((r) => r.status);
    expect(await end("A".repeat(22))).toBe(404);
    expect(await epoch(world)).toBe(0);
    expect(await end(await publicId(world.db, other))).toBe(204);
    expect(await epoch(world)).toBe(1);
  });

  it("AUTH-18 epoch: sign out everywhere is one batch: a failed delete leaves the epoch and every session", async () => {
    const world = memberWorld();
    const { routes } = await spied();
    const a = await seedMember(world.db, "m1", "m@example.test");
    await addSession(world.db, "m1");
    world.db.raw.exec(
      "CREATE TRIGGER no_delete BEFORE DELETE ON phone_session BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    await expect(callRoute(routes, world.env, "POST", "/api/me/signout-all", { cookie: sid(a) })).rejects.toThrow(
      /refused/,
    );
    expect(await epoch(world)).toBe(0);
    expect(world.db.raw.prepare("SELECT count(*) AS n FROM phone_session").get()).toEqual({ n: 2 });
  });
});

describe("rate limits on GET /api/me, with real limits", () => {
  const counting = (refuse: string[] = []) => {
    const seen: [string, string][] = [];
    const bindings = Object.fromEntries(
      Object.keys(declaredRateLimits()).map((name) => [
        name,
        {
          limit: async ({ key }: { key: string }) => {
            seen.push([name, key]);
            return { success: !refuse.includes(name) };
          },
        },
      ]),
    );
    return { seen, bindings };
  };

  it("the per-IP meter comes before any read; the member's own only once a live session is read", async () => {
    const world = memberWorld({ TEST_TIMING: "0" });
    const { routes } = await spied();
    const live = await seedMember(world.db, "m1", "m@example.test");
    const none = counting();
    await callRoute(routes, { ...world.env, ...none.bindings }, "GET", "/api/me");
    expect(none.seen.map(([name]) => name)).toEqual(["RL_MEMBER_IP"]);
    const member = counting();
    await callRoute(routes, { ...world.env, ...member.bindings }, "GET", "/api/me", { cookie: sid(live) });
    expect(member.seen).toEqual([
      ["RL_MEMBER_IP", expect.any(String)],
      ["RL_MEMBER", "m1"],
    ]);
  });

  it("a refused per-IP meter answers 429 without touching D1", async () => {
    const world = memberWorld({ TEST_TIMING: "0" });
    const { routes } = await spied();
    const refused = counting(["RL_MEMBER_IP"]);
    const noDb = {
      prepare: () => {
        throw new Error("D1 read");
      },
    };
    const res = await callRoute(routes, { ...world.env, ...refused.bindings, DB: noDb }, "GET", "/api/me", {
      cookie: sid("A".repeat(43)),
    });
    expect(res.status).toBe(429);
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
      ["closeSessions", "m1", [secondId]],
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

describe("passkey names: PATCH /api/me/passkeys/:id", () => {
  it("takes letters, digits, emoji with ZWJ, space, hyphen and apostrophe; refuses bidi, zero-width space and URLs", async () => {
    const world = memberWorld();
    const { routes } = await spied();
    const cookie = await seedMember(world.db, "m1", "m@example.test");
    world.db.raw
      .prepare(
        "INSERT INTO passkey (id, user_id, public_key, sign_count, backed_up, name, created_at) VALUES ('cred-1', 'm1', x'00', 0, 1, 'Passkey', 0)",
      )
      .run();
    const rename = (name: string) =>
      callRoute(routes, world.env, "PATCH", "/api/me/passkeys/cred-1", { cookie: sid(cookie), body: { name } });
    for (const name of ["Duke's iPhone 15", "Büro-Laptop", "  MacBook  ", "👩\u200D💻 work", "x".repeat(40)]) {
      expect((await rename(name)).status, name).toBe(200);
    }
    expect(world.db.raw.prepare("SELECT name FROM passkey").get()).toEqual({ name: "x".repeat(40) });
    for (const name of [
      "evil\u202Egnp.exe",
      "a\u200Bb",
      "\u2066x\u2069",
      "https://evil.example",
      "bloop.here/signin",
      "x".repeat(41),
      "",
      "  ",
      "line\nbreak",
    ]) {
      expect((await rename(name)).status, JSON.stringify(name)).toBe(400);
    }
    expect(world.db.raw.prepare("SELECT name FROM passkey").get()).toEqual({ name: "x".repeat(40) });
  });
});

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

describe("GET /api/me: signed in only for a real session", () => {
  const me = async (world: ReturnType<typeof memberWorld>, url: string, headers: Record<string, string> = {}) => {
    const { routes } = await spied();
    const r = routes.find((x) => x.methods.includes("GET") && x.pattern.pathname === "/api/me") as AnyRoute;
    const res = await r.handler(new Request(url, { headers }), world.env, r.pattern.exec(url) as URLPatternResult, {});
    return { res, body: (await res.json()) as Record<string, unknown> };
  };

  it("the mock identity answers a cookieless request only on a local origin, from a local request", async () => {
    const local = memberWorld();
    expect((await me(local, "http://localhost:8787/api/me")).body).toMatchObject({ source: "mock", signedIn: true });
    const deployed = memberWorld({ PUBLIC_ORIGIN: "https://bloop.example", TEST_TIMING: "0" });
    for (const [world, url, headers] of [
      [deployed, "https://bloop.example/api/me", { "CF-Connecting-IP": "203.0.113.7" }],
      [deployed, "http://localhost:8787/api/me", {}],
      [local, "http://localhost:8787/api/me", { "CF-Connecting-IP": "203.0.113.7" }],
    ] as const) {
      const { body } = await me(world, url, headers);
      expect(body, url).toEqual({ source: "mock", signedIn: false, launchMode: "preview" });
    }
  });

  it("a cookie that names no live session reads as signed out and clears nothing", async () => {
    const world = memberWorld();
    const { res, body } = await me(world, "http://localhost:8787/api/me", { Cookie: sid("A".repeat(43)) });
    expect(body).toMatchObject({ signedIn: false });
    expect(cookieNames(res)).toEqual([]);
    const live = await seedMember(world.db, "m1", "m@example.test");
    const signedIn = await me(world, "http://localhost:8787/api/me", { Cookie: sid(live) });
    expect(signedIn.body).toMatchObject({ signedIn: true });
    expect(cookieNames(signedIn.res)).toEqual([]);
  });

  it("AUTH-08 rotate: a slow GET that answers after a sign-in rotated its cookie clears nothing, so the new one lives", async () => {
    const world = memberWorld();
    const old = await seedMember(world.db, "m1", "m@example.test");
    const fresh = await addSession(world.db, "m1");
    const oldHash = await sha256Hex(old);
    const url = "http://localhost:8787/api/me";
    const route = (await spied()).routes.find(
      (x) => x.methods.includes("GET") && x.pattern.pathname === "/api/me",
    ) as AnyRoute;
    const slow = route.handler(
      new Request(url, { headers: { Cookie: sid(old) } }),
      world.env,
      route.pattern.exec(url) as URLPatternResult,
      {},
    );
    // The sign-in's rotation commits while the GET is in flight, before it reads the session table.
    world.db.raw.prepare("DELETE FROM phone_session WHERE id_hash = ?").run(oldHash);
    const res = await slow;
    expect(((await res.json()) as { signedIn: boolean }).signedIn).toBe(false);
    expect(cookieNames(res)).toEqual([]);
    expect((await me(world, url, { Cookie: sid(fresh) })).body).toMatchObject({ signedIn: true });
  });
});

describe("AUTH-15 csrf: every account write route", () => {
  it("AUTH-15 csrf: a foreign Origin, a cross-site fetch, a non-JSON body and an unknown key are each refused, changing nothing", async () => {
    const world = memberWorld();
    const { calls, routes } = await spied();
    const cookie = await seedMember(world.db, "m1", "m@example.test");
    const writes = routes.flatMap((r) => r.methods.filter((m) => m !== "GET").map((m) => [r, m] as const));
    expect(writes.length).toBeGreaterThanOrEqual(7);
    const cases: [Record<string, string>, string, number][] = [
      [{ Origin: "https://evil.example", "Content-Type": "application/json" }, "{}", 403],
      [{ Origin: ORIGIN, "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" }, "{}", 403],
      [{ Origin: ORIGIN, "Content-Type": "text/plain" }, "{}", 415],
      [
        { Origin: ORIGIN, "Content-Type": "application/json" },
        JSON.stringify({ name: "x", open: true, extra: 1 }),
        400,
      ],
    ];
    for (const [r, method] of writes) {
      const url = `${ORIGIN}${r.pattern.pathname.replace(/:(\w+)/g, "A".repeat(22))}`;
      for (const [headers, body, status] of cases) {
        const request = new Request(url, { method, headers: { ...headers, Cookie: sid(cookie) }, body });
        const res = await r.handler(request, world.env, r.pattern.exec(url) as URLPatternResult, {});
        expect(res.status, `${method} ${r.pattern.pathname} ${JSON.stringify(headers)}`).toBe(status);
      }
    }
    expect(calls).toEqual([]);
    expect(world.db.raw.prepare("SELECT status FROM app_user WHERE id = 'm1'").get()).toEqual({ status: "active" });
    expect(world.db.raw.prepare("SELECT count(*) AS n FROM phone_session").get()).toEqual({ n: 1 });
  });
});
