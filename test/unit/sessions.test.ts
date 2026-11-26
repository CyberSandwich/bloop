import { describe, expect, it } from "vitest";
import {
  clearCookie,
  OAUTH_COOKIE,
  openCookie,
  readCookie,
  sealCookie,
  setCookie,
} from "../../src/worker/auth/cookies.ts";
import { authMaintenance } from "../../src/worker/auth/services.ts";
import { Sessions } from "../../src/worker/auth/sessions.ts";
import { Vault } from "../../src/worker/auth/vault.ts";
import { parseConfig } from "../../src/worker/config.ts";
import { sha256Hex } from "../../src/worker/ids.ts";
import { RATE_LIMIT_STUBS } from "../env-vars.ts";
import { testDb } from "./d1-shim.ts";

const DAY = 86_400_000;
const T0 = 1_800_000_000_000;
const identity = { tid: "tenant-a", oid: "oid-1", email: "someone@example.test" };
const ENTRA = { method: "entra", label: null, reauthAt: null } as const;

function setup() {
  const db = testDb();
  const clock = { t: T0 };
  return { db, clock, sessions: new Sessions(db, () => clock.t) };
}

describe("AUTH-05 cookie: phone sessions", () => {
  it("AUTH-05 cookie: stores only the SHA-256 of the cookie value", async () => {
    const { db, sessions } = setup();
    const user = await sessions.upsertUser(identity);
    const value = await sessions.create(user, null, ENTRA);
    const rows = db.raw.prepare("SELECT id_hash FROM phone_session").all() as { id_hash: string }[];
    expect(rows).toEqual([{ id_hash: await sha256Hex(value) }]);
    expect(JSON.stringify(rows)).not.toContain(value);
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("resolves a session to its user and refuses an unknown value", async () => {
    const { sessions } = setup();
    const user = await sessions.upsertUser(identity);
    const value = await sessions.create(user, null, ENTRA);
    expect(await sessions.resolve(value)).toBe(user);
    expect(await sessions.resolve("A".repeat(43))).toBeNull();
    expect(await sessions.resolve("")).toBeNull();
  });

  it("AUTH-05 cookie: creating a session deletes the one it replaces (rotation), and never reuses a value", async () => {
    const { db, sessions } = setup();
    const user = await sessions.upsertUser(identity);
    const first = await sessions.create(user, null, ENTRA);
    const second = await sessions.create(user, first, ENTRA);
    expect(second).not.toBe(first);
    expect(await sessions.resolve(first)).toBeNull();
    expect(await sessions.resolve(second)).toBe(user);
    expect(db.raw.prepare("SELECT count(*) AS n FROM phone_session").get()).toEqual({ n: 1 });
  });

  it("AUTH-05 cookie: expires after 30 days idle, and a use keeps it alive", async () => {
    const { clock, sessions } = setup();
    const user = await sessions.upsertUser(identity);
    const idle = await sessions.create(user, null, ENTRA);
    const used = await sessions.create(user, null, ENTRA);
    clock.t += 20 * DAY;
    expect(await sessions.resolve(used)).toBe(user);
    clock.t += 20 * DAY;
    expect(await sessions.resolve(idle)).toBeNull();
    expect(await sessions.resolve(used)).toBe(user);
  });

  it("AUTH-05 cookie: expires 90 days after creation however often it is used", async () => {
    const { clock, sessions } = setup();
    const user = await sessions.upsertUser(identity);
    const value = await sessions.create(user, null, ENTRA);
    for (let day = 25; day < 90; day += 25) {
      clock.t = T0 + day * DAY;
      expect(await sessions.resolve(value), `day ${day}`).toBe(user);
    }
    clock.t = T0 + 91 * DAY;
    expect(await sessions.resolve(value)).toBeNull();
  });

  it("destroy removes one session; destroyAll removes every session of a user and no one else's", async () => {
    const { sessions } = setup();
    const mine = await sessions.upsertUser(identity);
    const other = await sessions.upsertUser({ ...identity, oid: "oid-2" });
    const a = await sessions.create(mine, null, ENTRA);
    const b = await sessions.create(mine, null, ENTRA);
    const c = await sessions.create(other, null, ENTRA);
    await sessions.destroy(a);
    expect(await sessions.resolve(a)).toBeNull();
    expect(await sessions.resolve(b)).toBe(mine);
    await sessions.destroyAll(mine);
    expect(await sessions.resolve(b)).toBeNull();
    expect(await sessions.resolve(c)).toBe(other);
  });

  it("AUTH-04 iss: users are keyed by (tid, oid): the same pair is one user, a changed email updates, another tenant is another user", async () => {
    const { db, sessions } = setup();
    const a = await sessions.upsertUser(identity);
    expect(await sessions.upsertUser({ ...identity, email: "renamed@example.test" })).toBe(a);
    expect(db.raw.prepare("SELECT email FROM app_user WHERE id = ?").get(a)).toEqual({ email: "renamed@example.test" });
    expect(await sessions.upsertUser({ ...identity, tid: "tenant-b" })).not.toBe(a);
    expect(await sessions.upsertUser({ ...identity, email: "someone@example.test", oid: "oid-9" })).not.toBe(a);
    expect(db.raw.prepare("SELECT count(*) AS n FROM app_user").get()).toEqual({ n: 3 });
  });

  it("deleteExpired removes idle and absolute-expired rows only", async () => {
    const { clock, sessions } = setup();
    const user = await sessions.upsertUser(identity);
    const old = await sessions.create(user, null, ENTRA);
    clock.t += 40 * DAY;
    const fresh = await sessions.create(user, null, ENTRA);
    expect(await sessions.deleteExpired()).toBe(1);
    expect(await sessions.resolve(old)).toBeNull();
    expect(await sessions.resolve(fresh)).toBe(user);
  });
});

describe("AUTH-05 cookie: cookie format and sealing", () => {
  const key = Buffer.alloc(32, 9).toString("base64");

  it("AUTH-05 cookie: every cookie is Secure, HttpOnly, SameSite=Lax, Path=/ and has no Domain", () => {
    const cookie = setCookie("__Host-bloop_sid", "value", 60);
    expect(cookie).toBe("__Host-bloop_sid=value; Max-Age=60; Path=/; Secure; HttpOnly; SameSite=Lax");
    expect(cookie).not.toContain("Domain");
    expect(clearCookie("__Host-bloop_sid")).toBe(
      "__Host-bloop_sid=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax",
    );
  });

  it("reads one cookie by exact name from a header with several", () => {
    const req = new Request("https://x.example/", {
      headers: { Cookie: "a=1; __Host-bloop_sid=abc; b=2; __Host-bloop_sid2=zzz" },
    });
    expect(readCookie(req, "__Host-bloop_sid")).toBe("abc");
    expect(readCookie(req, "missing")).toBeNull();
    expect(readCookie(new Request("https://x.example/"), "a")).toBeNull();
  });

  it("AUTH-03 state: a sealed payload round-trips, hides its content, and opens only under its key and name", async () => {
    const sealed = await sealCookie(key, OAUTH_COOKIE, { state: "s-secret", verifier: "v-secret" });
    expect(Buffer.from(sealed, "base64url").toString("latin1")).not.toContain("s-secret");
    expect(await openCookie(key, OAUTH_COOKIE, sealed)).toEqual({ state: "s-secret", verifier: "v-secret" });
    expect(await openCookie(Buffer.alloc(32, 1).toString("base64"), OAUTH_COOKIE, sealed)).toBeNull();
    expect(await openCookie(key, "__Host-bloop_other", sealed)).toBeNull();
  });

  it("AUTH-03 state: a tampered, truncated or junk cookie opens to null", async () => {
    const sealed = await sealCookie(key, OAUTH_COOKIE, { a: 1 });
    const flipped = `${sealed.slice(0, 20)}${sealed[20] === "A" ? "B" : "A"}${sealed.slice(21)}`;
    for (const bad of [flipped, sealed.slice(0, 10), "", "!!!", "A".repeat(80)]) {
      expect(await openCookie(key, OAUTH_COOKIE, bad), bad).toBeNull();
    }
  });

  it("each seal uses a fresh IV", async () => {
    expect(await sealCookie(key, OAUTH_COOKIE, { a: 1 })).not.toBe(await sealCookie(key, OAUTH_COOKIE, { a: 1 }));
  });
});

describe("AUTH-01 vault: the daily maintenance job", () => {
  const keyValue = Buffer.alloc(32, 3).toString("base64");
  const base = {
    PUBLIC_ORIGIN: "https://bloop.example",
    HASH_PEPPER: "p".repeat(40),
    CODE_LENGTH: "6",
    CODE_TTL_SECONDS: "60",
    CODE_GRACE_SECONDS: "10",
    CLAIM_TIMEOUT_SECONDS: "300",
    UPLOAD_TIMEOUT_SECONDS: "900",
    SESSION_MAX_MINUTES: "90",
    DEMO_MAX_MINUTES: "10",
    DEMO_ENABLED: "true",
    GUEST_DROP: "open",
    ...RATE_LIMIT_STUBS,
  };

  it("deletes idle grants and expired sessions, and reports stale keys; it works without Graph configured", async () => {
    const db = testDb();
    const clock = { t: T0 };
    const sessions = new Sessions(db, () => clock.t);
    const vault = new Vault(db, { keys: { k1: keyValue }, current: "k1" }, () => clock.t);
    const user = await sessions.upsertUser(identity);
    const session = await sessions.create(user, null, ENTRA);
    await vault.store(user, { refreshToken: "r", accessToken: "a", accessExpiresAt: T0 + 3_600_000, scope: "s" });

    clock.t += 31 * DAY;
    const parsed = parseConfig(base);
    if (!parsed.ok) throw new Error(parsed.problems.join());
    const report = await authMaintenance({ DB: db }, parsed.config, () => clock.t);
    expect(report).toEqual({ idleGrants: 1, expiredSessions: 1, staleKeys: 0 });
    expect(await vault.has(user)).toBe(false);
    expect(await sessions.resolve(session)).toBeNull();
  });

  it("with Graph configured it also re-wraps keys under an old KEK", async () => {
    const db = testDb();
    const clock = { t: T0 };
    const sessions = new Sessions(db, () => clock.t);
    const oldKey = Buffer.alloc(32, 4).toString("base64");
    const user = await sessions.upsertUser(identity);
    await new Vault(db, { keys: { k1: oldKey }, current: "k1" }, () => clock.t).store(user, {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: T0 + 3_600_000,
      scope: "s",
    });
    const parsed = parseConfig({
      ...base,
      FILE_SOURCE: "graph",
      ENTRA_CLIENT_ID: "id",
      ENTRA_CLIENT_SECRET: "x".repeat(10),
      COOKIE_KEY: keyValue,
      TOKEN_KEKS: JSON.stringify({ k1: oldKey, k2: keyValue }),
      TOKEN_KEK_CURRENT: "k2",
    });
    if (!parsed.ok) throw new Error(parsed.problems.join());
    const report = await authMaintenance({ DB: db }, parsed.config, () => clock.t);
    expect(report.staleKeys).toBe(0);
    expect(db.raw.prepare("SELECT kid FROM token_grant").get()).toEqual({ kid: "k2" });
  });
});
