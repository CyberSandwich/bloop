import { describe, expect, it } from "vitest";
import {
  type Member,
  requireAdmin,
  requireFresh,
  requireStepUp,
  resolveMember,
  STEP_UP_PASSKEY_AGE_MS,
} from "../../src/worker/auth/member.ts";
import { sha256Hex } from "../../src/worker/ids.ts";
import { declaredRateLimits } from "../env-vars.ts";
import type { TestDb } from "./d1-shim.ts";
import { callRoute, memberWorld, ORIGIN, routesOf, seedMember, setMode, sid } from "./member-fixture.ts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const ADMIN = "admin@example.test";

const request = (cookie?: string) =>
  new Request(`${ORIGIN}/api/me`, { headers: cookie ? { Cookie: sid(cookie) } : {} });

async function member(world: ReturnType<typeof memberWorld>, cookie: string): Promise<Member> {
  const who = await resolveMember(request(cookie), world.env, world.config);
  if (!who.ok) throw new Error(`refused: ${who.response.status}`);
  return who.member;
}

const addPasskey = (db: TestDb, id: string, userId: string, createdAt: number) =>
  db.raw
    .prepare(
      "INSERT INTO passkey (id, user_id, public_key, sign_count, backed_up, name, created_at) VALUES (?, ?, x'00', 0, 1, 'Passkey', ?)",
    )
    .run(id, userId, createdAt);

describe("AUTH-16 admin: the role comes only from ADMIN_EMAILS", () => {
  it("AUTH-16 admin: an address in ADMIN_EMAILS, listed with other case and spaces, is admin; any other member is not", async () => {
    const world = memberWorld();
    const admin = await seedMember(world.db, "a1", ADMIN);
    const plain = await seedMember(world.db, "m1", "member@example.test");
    expect((await member(world, admin)).admin).toBe(true);
    expect((await member(world, plain)).admin).toBe(false);
    expect(requireAdmin(await member(world, admin))).toBeNull();
    expect((requireAdmin(await member(world, plain)) as Response).status).toBe(404);
  });

  it("AUTH-16 admin: a D1 UPDATE of any user or session column, or any setting row, grants nothing", async () => {
    const columns = (world: ReturnType<typeof memberWorld>, table: string) =>
      (world.db.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[]).filter(
        // The keys that name the row, an FK that needs its parent, and the address the role is defined by (below).
        (c) => !["id", "tid", "oid", "org_id", "email_norm", "id_hash", "user_id"].includes(c.name),
      );
    const probe = memberWorld();
    const targets = ["app_user", "phone_session"].flatMap((table) =>
      columns(probe, table).map((c) => [table, c] as const),
    );
    expect(targets.length).toBeGreaterThan(15);
    for (const [table, column] of targets) {
      const world = memberWorld();
      const cookie = await seedMember(world.db, "m1", "member@example.test");
      const value = column.type === "INTEGER" ? 1 : column.type === "BLOB" ? null : ADMIN;
      world.db.raw.prepare(`UPDATE ${table} SET ${column.name} = ?`).run(value);
      for (const key of ["admin", "role", "is_admin", "admin_emails"]) {
        world.db.raw.prepare("INSERT INTO setting (key, value, updated_at) VALUES (?, ?, 0)").run(key, ADMIN);
      }
      const who = await resolveMember(request(cookie), world.env, world.config);
      expect(who.ok && who.member.admin, `${table}.${column.name}`).toBe(false);
    }
  });

  it("AUTH-16 admin: the admin address cannot be copied onto another row while the admin's row holds it", async () => {
    const world = memberWorld();
    await seedMember(world.db, "a1", ADMIN);
    await seedMember(world.db, "m1", "member@example.test");
    expect(() => world.db.raw.prepare("UPDATE app_user SET email_norm = ? WHERE id = 'm1'").run(ADMIN)).toThrow(
      /UNIQUE/,
    );
  });

  it("AUTH-16 admin: an Entra user with the admin address is not a member, so never admin", async () => {
    const world = memberWorld();
    const entra = await seedMember(world.db, "e1", ADMIN, { method: "entra" }, { tid: "tenant-a" });
    const who = await resolveMember(request(entra), world.env, world.config);
    expect(who.ok).toBe(false);
  });

  it("AUTH-16 admin: FF every /api/admin route answers not_found to a member and to a signed-out request", async () => {
    const world = memberWorld();
    const cookie = await seedMember(world.db, "m1", "member@example.test");
    const routes = await routesOf("admin", "adminRoutes");
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) {
      const path = r.pattern.pathname.replace(/:(\w+)/g, "x");
      expect(path.startsWith("/api/admin/"), path).toBe(true);
      for (const method of r.methods) {
        for (const who of [cookie, undefined]) {
          const res = await callRoute(routes, world.env, method, path, who ? { cookie: sid(who) } : {});
          expect(res.status, `${method} ${path} ${who ? "member" : "signed out"}`).toBe(404);
          expect(await res.json()).toMatchObject({ code: "not_found" });
        }
      }
    }
  });

  it("AUTH-16 admin: FF with real limits and every limiter refusing, any admin call by a non-admin is still not_found", async () => {
    const world = memberWorld({ TEST_TIMING: "0" });
    const refusing = Object.fromEntries(
      Object.keys(declaredRateLimits()).map((name) => [name, { limit: async () => ({ success: false }) }]),
    );
    const env = { ...world.env, ...refusing };
    const member = await seedMember(world.db, "m1", "member@example.test");
    const routes = await routesOf("admin", "adminRoutes");
    const calls = routes.flatMap((r) => r.methods.map((m) => [r, m] as const));
    expect(calls.length).toBeGreaterThan(0);
    for (const [r, method] of calls) {
      const path = r.pattern.pathname.replace(/:(\w+)/g, "x");
      for (const options of [{ cookie: sid(member) }, {}]) {
        const res = await callRoute(routes, env, method, path, options);
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(await res.json()).toMatchObject({ code: "not_found" });
      }
    }
    // The same limiters do refuse a member's own write, so the stub is live.
    const account = await routesOf("account", "accountRoutes");
    expect((await callRoute(account, env, "POST", "/api/me/signout", { cookie: sid(member) })).status).toBe(429);
  });

  it("AUTH-16 admin: FF a foreign Origin, a cross-site fetch or a non-JSON body still gets not_found from a non-admin", async () => {
    const world = memberWorld();
    const member = await seedMember(world.db, "m1", "member@example.test");
    const admin = await seedMember(world.db, "a1", ADMIN);
    const routes = await routesOf("admin", "adminRoutes");
    const writes = routes.flatMap((r) => r.methods.filter((m) => m !== "GET").map((m) => [r, m] as const));
    expect(writes.length).toBeGreaterThan(0);
    const odd: Record<string, string>[] = [
      { Origin: "https://evil.example", "Content-Type": "application/json" },
      { Origin: ORIGIN, "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" },
      { Origin: ORIGIN, "Content-Type": "text/plain" },
      { "Content-Type": "application/json" },
    ];
    const send = (r: (typeof routes)[number], method: string, headers: Record<string, string>, cookie?: string) => {
      const url = `${ORIGIN}${r.pattern.pathname.replace(/:(\w+)/g, "x")}`;
      const request = new Request(url, {
        method,
        headers: { ...headers, ...(cookie ? { Cookie: sid(cookie) } : {}) },
        body: "{not json",
      });
      return r.handler(request, world.env, r.pattern.exec(url) as URLPatternResult, {});
    };
    for (const [r, method] of writes) {
      for (const headers of odd) {
        for (const who of [member, undefined]) {
          const res = await send(r, method, headers, who);
          expect(res.status, `${method} ${r.pattern.pathname} ${JSON.stringify(headers)} ${who ?? "signed out"}`).toBe(
            404,
          );
          expect(await res.json()).toMatchObject({ code: "not_found" });
        }
        // An admin still gets the write checks' own answers.
        expect((await send(r, method, headers, admin)).status).not.toBe(404);
      }
    }
  });
});

describe("AUTH-16 passkey: A+R accepts only a UV passkey proof from a passkey at least a day old", () => {
  async function admin(method: string, passkeyAge: number | null, reauthAgo = 0) {
    const world = memberWorld();
    const now = () => NOW;
    const cookie = await seedMember(
      world.db,
      "a1",
      ADMIN,
      { method: method as "code", reauthAt: NOW - reauthAgo },
      { now },
    );
    if (passkeyAge !== null) addPasskey(world.db, "cred-1", "a1", NOW - passkeyAge);
    const who = await resolveMember(request(cookie), world.env, world.config);
    if (!who.ok) throw new Error("refused");
    return { world, m: who.member };
  }
  const code = async (r: Response | null) => (r ? ((await r.json()) as { code: string }).code : null);

  it("AUTH-16 passkey: FF a fresh email-code proof is refused, though it passes C+R", async () => {
    const { world, m } = await admin("code", 30 * 24 * HOUR);
    expect(requireFresh(m, world.config, NOW)).toBeNull();
    expect(await code(await requireStepUp(m, world.db, world.config, NOW))).toBe("reauth_required");
  });

  it("AUTH-16 passkey: FF a fresh proof by a passkey under 24 h old is refused", async () => {
    const { world, m } = await admin("passkey:cred-1", STEP_UP_PASSKEY_AGE_MS - 1);
    expect(await code(await requireStepUp(m, world.db, world.config, NOW))).toBe("reauth_required");
  });

  it("AUTH-16 passkey: a fresh proof by a passkey 24 h old or older is accepted", async () => {
    for (const age of [STEP_UP_PASSKEY_AGE_MS, 90 * 24 * HOUR]) {
      const { world, m } = await admin("passkey:cred-1", age);
      expect(await requireStepUp(m, world.db, world.config, NOW), String(age)).toBeNull();
    }
  });

  it("AUTH-16 passkey: an old passkey's proof older than REAUTH_SECONDS is refused", async () => {
    const { world, m } = await admin("passkey:cred-1", 30 * 24 * HOUR, world0Reauth() + 1);
    expect(await code(await requireStepUp(m, world.db, world.config, NOW))).toBe("reauth_required");
  });

  it("AUTH-16 passkey: a proof naming a removed passkey, another member's passkey or no id is refused", async () => {
    const removed = await admin("passkey:cred-1", 30 * 24 * HOUR);
    removed.world.db.raw.prepare("DELETE FROM passkey").run();
    expect(await code(await requireStepUp(removed.m, removed.world.db, removed.world.config, NOW))).toBe(
      "reauth_required",
    );
    const foreign = await admin("passkey:cred-2", null);
    await seedMember(foreign.world.db, "m2", "member@example.test");
    addPasskey(foreign.world.db, "cred-2", "m2", NOW - 30 * 24 * HOUR);
    expect(await code(await requireStepUp(foreign.m, foreign.world.db, foreign.world.config, NOW))).toBe(
      "reauth_required",
    );
    const bare = await admin("passkey:", null);
    expect(await code(await requireStepUp(bare.m, bare.world.db, bare.world.config, NOW))).toBe("reauth_required");
  });

  it("AUTH-16 passkey: a member with an old passkey and a fresh passkey proof is still not_found", async () => {
    const world = memberWorld();
    const now = () => NOW;
    const cookie = await seedMember(world.db, "m1", "member@example.test", { method: "passkey:cred-1" }, { now });
    addPasskey(world.db, "cred-1", "m1", NOW - 30 * 24 * HOUR);
    const m = await member(world, cookie);
    expect(await code(await requireStepUp(m, world.db, world.config, NOW))).toBe("not_found");
  });
});

/** REAUTH_SECONDS as the test world parses it, in ms. */
const world0Reauth = () => memberWorld().config.account.reauthSeconds * 1000;

describe("MODE-01 gate: the member resolver applies the mode, status and suspension gates", () => {
  it("MODE-01 gate: under the preview lockout only ADMIN_EMAILS and TEST_EMAILS members resolve", async () => {
    const world = memberWorld();
    const admin = await seedMember(world.db, "a1", ADMIN);
    const tester = await seedMember(world.db, "t1", "test@example.test");
    const other = await seedMember(world.db, "m1", "member@example.test");
    setMode(world.db, "preview", true);
    expect((await resolveMember(request(admin), world.env, world.config)).ok).toBe(true);
    expect((await resolveMember(request(tester), world.env, world.config)).ok).toBe(true);
    const refused = await resolveMember(request(other), world.env, world.config);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(await refused.response.json()).toMatchObject({ code: "auth_required" });
    setMode(world.db, "preview", false);
    expect((await resolveMember(request(other), world.env, world.config)).ok).toBe(true);
  });

  it("MODE-01 gate: a switch to the lockout reaches a fresh read at once, through a warm cache", async () => {
    // Without TEST_TIMING the settings cache is on, as in production.
    const world = memberWorld({ TEST_TIMING: "0" });
    const other = await seedMember(world.db, "m1", "member@example.test");
    setMode(world.db, "preview", false);
    expect((await resolveMember(request(other), world.env, world.config)).ok).toBe(true);
    setMode(world.db, "preview", true);
    expect((await resolveMember(request(other), world.env, world.config, { fresh: true })).ok).toBe(false);
  });

  it("C(d): a deleting member resolves only where deletion is allowed; suspended, purging and Entra never do", async () => {
    const world = memberWorld();
    const deleting = await seedMember(world.db, "d1", "d@example.test");
    const suspended = await seedMember(world.db, "s1", "s@example.test");
    const purging = await seedMember(world.db, "p1", "p@example.test");
    world.db.raw.prepare("UPDATE app_user SET status = 'deleting', delete_after = ? WHERE id = 'd1'").run(NOW * 2);
    world.db.raw.prepare("UPDATE app_user SET suspended_at = 1 WHERE id = 's1'").run();
    world.db.raw.prepare("UPDATE app_user SET status = 'purging' WHERE id = 'p1'").run();
    const resolve = (c: string, allowDeleting: boolean) =>
      resolveMember(request(c), world.env, world.config, { allowDeleting }).then((r) => r.ok);
    expect(await resolve(deleting, false)).toBe(false);
    expect(await resolve(deleting, true)).toBe(true);
    for (const c of [suspended, purging]) {
      expect(await resolve(c, true)).toBe(false);
      expect(await resolve(c, false)).toBe(false);
    }
    expect((await resolveMember(request(), world.env, world.config)).ok).toBe(false);
  });

  it("the resolved member carries the session's proof, never the cookie value", async () => {
    const world = memberWorld();
    const cookie = await seedMember(world.db, "m1", "member@example.test", { method: "passkey:c", reauthAt: 5 });
    const m = await member(world, cookie);
    expect(m.session).toEqual({
      hash: await sha256Hex(cookie),
      publicId: expect.any(String),
      reauthAt: 5,
      method: "passkey:c",
    });
    expect(JSON.stringify(m)).not.toContain(cookie);
  });
});
