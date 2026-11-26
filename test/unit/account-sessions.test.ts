import { describe, expect, it } from "vitest";
import { deviceEpoch, isKnown, newDeviceValue } from "../../src/worker/auth/codes.ts";
import { sha256Hex } from "../../src/worker/ids.ts";
import {
  type AnyRoute,
  addSession,
  callRoute,
  cookieNames,
  memberWorld,
  ORIGIN,
  publicId,
  recordingLimits,
  seedMember,
  sid,
  spied,
} from "./member-fixture.ts";

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

describe("rate limits on GET /api/me, with real limits", () => {
  it("the per-IP meter comes before any read; the member's own only once a live session is read", async () => {
    const world = memberWorld({ TEST_TIMING: "0" });
    const { routes } = await spied();
    const live = await seedMember(world.db, "m1", "m@example.test");
    const none = recordingLimits();
    await callRoute(routes, { ...world.env, ...none.bindings }, "GET", "/api/me");
    expect(none.seen.map(([name]) => name)).toEqual(["RL_MEMBER_IP"]);
    const member = recordingLimits();
    await callRoute(routes, { ...world.env, ...member.bindings }, "GET", "/api/me", { cookie: sid(live) });
    expect(member.seen).toEqual([
      ["RL_MEMBER_IP", expect.any(String)],
      ["RL_MEMBER", "m1"],
    ]);
  });

  it("a refused per-IP meter answers 429 without touching D1", async () => {
    const world = memberWorld({ TEST_TIMING: "0" });
    const { routes } = await spied();
    const refused = recordingLimits(["RL_MEMBER_IP"]);
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
