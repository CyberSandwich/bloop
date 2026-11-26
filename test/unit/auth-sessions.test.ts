import { describe, expect, it } from "vitest";
import {
  BIND_COOKIE,
  BIND_MAX_AGE_SECONDS,
  DEVICE_COOKIE,
  HINT_COOKIE,
  SESSION_COOKIE,
  setStrict,
  signedInCookies,
  signedOutCookies,
} from "../../src/worker/auth/cookies.ts";
import { deviceLabel, SESSION_MAX_AGE_SECONDS, Sessions } from "../../src/worker/auth/sessions.ts";
import { sha256Hex } from "../../src/worker/ids.ts";
import { type TestDb, testDb } from "./d1-shim.ts";
import { seedMember } from "./member-fixture.ts";

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;

function setup() {
  const db = testDb();
  const clock = { t: T0 };
  const now = () => clock.t;
  return { db, clock, now, sessions: new Sessions(db, now) };
}

const row = (db: TestDb, value: string) =>
  sha256Hex(value).then(
    (hash) =>
      db.raw.prepare("SELECT public_id, method, label, reauth_at FROM phone_session WHERE id_hash = ?").get(hash) as
        | { public_id: string; method: string; label: string | null; reauth_at: number | null }
        | undefined,
  );

describe("AUTH-08 rotate: every authentication issues a new value and deletes the presented one", () => {
  for (const method of ["code", "passkey:cred-1", "entra"] as const) {
    it(`AUTH-08 rotate: a ${method} sign-in replaces the presented session and gets a new public id`, async () => {
      const { db, now, sessions } = setup();
      const before = await seedMember(db, "u1", "m@example.test", {}, { now });
      const old = await row(db, before);
      const after = await sessions.create("u1", before, { method, label: "Safari on iPhone", reauthAt: T0 });
      expect(after).not.toBe(before);
      expect(after).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await sessions.resolve(before)).toBeNull();
      expect(await sessions.resolve(after)).toBe("u1");
      const fresh = await row(db, after);
      expect(fresh).toEqual({ public_id: expect.any(String), method, label: "Safari on iPhone", reauth_at: T0 });
      expect(fresh?.public_id).not.toBe(old?.public_id);
      expect(db.raw.prepare("SELECT count(*) AS n FROM phone_session").get()).toEqual({ n: 1 });
    });
  }

  it("AUTH-08 rotate: an invite sign-in (a code) with a planted pre-auth value never adopts it", async () => {
    const { db, now, sessions } = setup();
    // An attacker's own session value, planted in the victim's browser before the victim signs in.
    const planted = await seedMember(db, "attacker", "a@example.test", {}, { now });
    db.raw
      .prepare(
        "INSERT INTO app_user (id, tid, oid, email_norm, created_at, last_seen_at) VALUES (?, 'email', ?, ?, 0, 0)",
      )
      .run("victim", "victim", "v@example.test");
    const mine = await sessions.create("victim", planted, { method: "code", label: null, reauthAt: T0 });
    expect(await sessions.resolve(planted)).toBeNull();
    expect(await sessions.resolve(mine)).toBe("victim");
  });

  it("AUTH-08 rotate: a reauth rotates the value but keeps the public id, so the session's screens stay its own", async () => {
    const { db, clock, now, sessions } = setup();
    const before = await seedMember(db, "u1", "m@example.test", { reauthAt: null }, { now });
    const old = await row(db, before);
    clock.t += 60_000;
    const after = await sessions.create("u1", before, {
      method: "code",
      label: null,
      publicId: old?.public_id as string,
      reauthAt: clock.t,
    });
    expect(after).not.toBe(before);
    expect(await sessions.resolve(before)).toBeNull();
    expect(await row(db, after)).toMatchObject({ public_id: old?.public_id, reauth_at: clock.t });
  });

  it("AUTH-08 rotate: a rotation that cannot insert leaves the presented session working (one batch)", async () => {
    const { db, now, sessions } = setup();
    const mine = await seedMember(db, "u1", "m@example.test", {}, { now });
    const theirs = await seedMember(db, "u2", "o@example.test", {}, { now });
    const taken = (await row(db, theirs))?.public_id as string;
    await expect(
      sessions.create("u1", mine, { method: "code", label: null, publicId: taken, reauthAt: T0 }),
    ).rejects.toThrow();
    expect(await sessions.resolve(mine)).toBe("u1");
  });
});

describe("sessions: the devices list and its writes", () => {
  it("list shows only the user's live sessions, newest use first, marks the current one and hides credential ids", async () => {
    const { db, clock, now, sessions } = setup();
    const a = await seedMember(db, "u1", "m@example.test", { label: "Chrome on Mac" }, { now });
    clock.t += 1000;
    const b = await sessions.create("u1", null, {
      method: "passkey:secret-cred",
      label: "Safari on iPhone",
      reauthAt: null,
    });
    await seedMember(db, "u2", "o@example.test", {}, { now });
    const list = await sessions.list("u1", await sha256Hex(b));
    expect(list.map((s) => [s.label, s.method, s.current])).toEqual([
      ["Safari on iPhone", "passkey", true],
      ["Chrome on Mac", "code", false],
    ]);
    expect(JSON.stringify(list)).not.toContain("secret-cred");
    expect(list.every((s) => /^[A-Za-z0-9_-]{22}$/.test(s.id))).toBe(true);
    clock.t += 31 * DAY;
    expect(await sessions.list("u1", await sha256Hex(a))).toEqual([]);
  });

  it("destroyPublic ends only the user's own session of that id", async () => {
    const { db, now, sessions } = setup();
    const mine = await seedMember(db, "u1", "m@example.test", {}, { now });
    const theirs = await seedMember(db, "u2", "o@example.test", {}, { now });
    const theirId = (await row(db, theirs))?.public_id as string;
    expect(await sessions.destroyPublic("u1", theirId)).toBe(false);
    expect(await sessions.resolve(theirs)).toBe("u2");
    expect(await sessions.destroyPublic("u1", (await row(db, mine))?.public_id as string)).toBe(true);
    expect(await sessions.resolve(mine)).toBeNull();
  });

  it("destroyOthers keeps the named session; destroyAll ends every one; both return the ended public ids", async () => {
    const { db, now, sessions } = setup();
    const keep = await seedMember(db, "u1", "m@example.test", {}, { now });
    const other = await sessions.create("u1", null, { method: "code", label: null, reauthAt: null });
    const otherId = (await row(db, other))?.public_id;
    expect(await sessions.destroyOthers("u1", await sha256Hex(keep))).toEqual([otherId]);
    expect(await sessions.resolve(keep)).toBe("u1");
    const keepId = (await row(db, keep))?.public_id;
    expect(await sessions.destroyAll("u1")).toEqual([keepId]);
    expect(await sessions.resolve(keep)).toBeNull();
  });

  it("stampReauth records a proof on the session without rotating it", async () => {
    const { db, clock, now, sessions } = setup();
    const value = await seedMember(db, "u1", "m@example.test", { reauthAt: null }, { now });
    clock.t += 5000;
    await sessions.stampReauth(await sha256Hex(value));
    expect((await sessions.lookup(value))?.reauthAt).toBe(clock.t);
  });

  it("restore cancels a deletion inside its grace only, and never touches an active member", async () => {
    const { db, clock, sessions } = setup();
    for (const [id, status, after] of [
      ["in", "deleting", T0 + DAY],
      ["late", "deleting", T0 - 1],
      ["act", "active", T0 + DAY],
    ] as const) {
      db.raw
        .prepare(
          "INSERT INTO app_user (id, tid, oid, email_norm, created_at, last_seen_at, status, delete_after) VALUES (?, 'email', ?, ?, 0, 0, ?, ?)",
        )
        .run(id, id, `${id}@example.test`, status, after);
    }
    clock.t = T0;
    expect(await sessions.restore("in")).toBe(true);
    expect(await sessions.restore("in")).toBe(false);
    expect(await sessions.restore("late")).toBe(false);
    expect(await sessions.restore("act")).toBe(false);
    expect(db.raw.prepare("SELECT id, status, delete_after FROM app_user ORDER BY id").all()).toEqual([
      { id: "act", status: "active", delete_after: T0 + DAY },
      { id: "in", status: "active", delete_after: null },
      { id: "late", status: "deleting", delete_after: T0 - 1 },
    ]);
  });

  it("touchUser moves the member's activity clock at most daily", async () => {
    const { db, clock, now, sessions } = setup();
    const value = await seedMember(db, "u1", "m@example.test", {}, { now });
    const seen = () =>
      (db.raw.prepare("SELECT last_seen_at AS t FROM app_user WHERE id = 'u1'").get() as { t: number }).t;
    clock.t += DAY - 1;
    await sessions.touchUser((await sessions.lookup(value)) as NonNullable<Awaited<ReturnType<Sessions["lookup"]>>>);
    expect(seen()).toBe(T0);
    clock.t += 2;
    await sessions.touchUser((await sessions.lookup(value)) as NonNullable<Awaited<ReturnType<Sessions["lookup"]>>>);
    expect(seen()).toBe(clock.t);
  });
});

describe("deviceLabel: a coarse class, never the raw User-Agent", () => {
  const cases: [string | null, string][] = [
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      "Safari on iPhone",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Chrome on Mac",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
      "Edge on Windows",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
      "Chrome on Android",
    ],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0", "Firefox on Linux"],
    [
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/131.0 Mobile/15E148 Safari/604.1",
      "Chrome on iPad",
    ],
    ["curl/8.0", "Browser"],
    [null, "Browser"],
  ];
  for (const [ua, label] of cases) {
    it(`labels ${label}`, () => expect(deviceLabel(ua)).toBe(label));
  }
});

describe("AUTH-09 device: the cookies a sign-in sets and a sign-out clears", () => {
  const attrs = (cookie: string) => cookie.split("; ").slice(1).sort();

  it("AUTH-09 device: a sign-in sets the session, the hint and, when given, the device value", () => {
    const cookies = signedInCookies("s".repeat(43), "nonce.mac");
    expect(cookies.map((c) => c.split("=")[0])).toEqual([SESSION_COOKIE, HINT_COOKIE, DEVICE_COOKIE]);
    expect(cookies[0]).toContain(`=${"s".repeat(43)};`);
    expect(cookies[1]).toMatch(/^__Host-bloop_in=1;/);
    expect(cookies[2]).toMatch(/^__Host-bloop_dev=nonce\.mac;/);
    expect(signedInCookies("v", null)).toHaveLength(2);
  });

  it("AUTH-09 device: every one is HttpOnly, Secure, SameSite=Lax, Path=/ and has no Domain, the hint included", () => {
    for (const cookie of signedInCookies("v", "d")) {
      expect(attrs(cookie).filter((a) => !a.startsWith("Max-Age"))).toEqual([
        "HttpOnly",
        "Path=/",
        "SameSite=Lax",
        "Secure",
      ]);
      expect(cookie).not.toContain("Domain");
    }
    expect(signedInCookies("v", null)[1]).toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS};`);
  });

  it("AUTH-09 device: sign out everywhere clears the device cookie; a plain sign-out keeps it", () => {
    const names = (cookies: string[]) => cookies.map((c) => c.split("=")[0]);
    const plain = signedOutCookies({ everywhere: false });
    const everywhere = signedOutCookies({ everywhere: true });
    expect(names(plain)).toEqual([SESSION_COOKIE, HINT_COOKIE]);
    expect(names(everywhere)).toEqual([SESSION_COOKIE, HINT_COOKIE, DEVICE_COOKIE]);
    for (const cookie of everywhere) expect(cookie).toMatch(/^[^=]+=; Max-Age=0;/);
  });

  it("the binder is SameSite=Strict and lives 10 minutes", () => {
    const cookie = setStrict(BIND_COOKIE, "b", BIND_MAX_AGE_SECONDS);
    expect(cookie).toBe("__Host-bloop_bind=b; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=Strict");
  });
});
