// The account routes for email members against a real wrangler dev with FILE_SOURCE=mock, as production runs:
// /api/me, sign-out, the devices and passkeys lists, restore, the audit read and the admin view cookie.
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, startPairing } from "./pairing-client.ts";
import type { Wrangler } from "./wrangler.ts";

let wrangler: Wrangler;
let api: Api;

beforeAll(async () => {
  wrangler = await startPairing(
    { ADMIN_EMAILS: "admin@example.test", TEST_EMAILS: "test@example.test" },
    { migrate: true },
  );
  api = new Api(wrangler.url);
});
afterAll(async () => {
  await wrangler?.stop();
});

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const token = (n: number) => randomBytes(n).toString("base64url");
const cookie = (value: string) => ({ headers: { Cookie: `__Host-bloop_sid=${value}` } });
const names = (res: { headers: Headers }) => res.headers.getSetCookie().map((c) => c.split("=")[0]);

let seq = 0;
/** An email member, with any extra app_user columns, and one live session; more sessions come from `session`. */
function member(email = `m${++seq}@example.test`, columns: Record<string, string | number> = {}) {
  const id = token(16);
  const now = Date.now();
  const row: Record<string, string | number> = {
    id,
    tid: "email",
    oid: id,
    email,
    email_norm: email,
    created_at: now,
    last_seen_at: now,
    ...columns,
  };
  const values = Object.values(row).map((v) => (typeof v === "number" ? v : `'${v}'`));
  wrangler.d1(`INSERT INTO app_user (${Object.keys(row).join(", ")}) VALUES (${values.join(", ")})`);
  return { id, email, sid: session(id) };
}

/** The one ADMIN_EMAILS member (email_norm is unique), with a fresh session each call. */
let adminId: string | null = null;
function admin() {
  adminId ??= member("admin@example.test").id;
  return { id: adminId, sid: session(adminId) };
}

function session(userId: string, reauthAt: number | null = Date.now(), method = "code") {
  const value = token(32);
  const now = Date.now();
  wrangler.d1(
    `INSERT INTO phone_session (id_hash, user_id, created_at, last_seen_at, expires_at, public_id, method, label, reauth_at) VALUES ('${sha(value)}', '${userId}', ${now}, ${now}, ${now + 86_400_000}, '${token(16)}', '${method}', 'Safari on iPhone', ${reauthAt ?? "NULL"})`,
  );
  return value;
}

const me = async (value?: string) => (await api.call("GET", "/api/me", undefined, value ? cookie(value) : {})).body;

describe("GET /api/me for email members", () => {
  it("with no cookie it keeps the demo answer; a dead cookie reads as signed out", async () => {
    expect(await me()).toEqual({ source: "mock", signedIn: true, email: null, launchMode: "preview" });
    expect(await me("A".repeat(43))).toEqual({ source: "mock", signedIn: false, launchMode: "preview" });
  });

  it("a member gets the full answer; an admin is marked admin", async () => {
    const m = member();
    wrangler.d1(`UPDATE app_user SET used_bytes = 5 WHERE id = '${m.id}'`);
    const body = await me(m.sid);
    expect(body).toEqual({
      source: "mock",
      signedIn: true,
      email: m.email,
      admin: false,
      launchMode: "preview",
      status: "active",
      deleteAfter: null,
      passkeys: 0,
      quota: { used: 5, total: expect.any(Number) },
      userHandle: Buffer.from(m.id).toString("base64url"),
    });
    expect((await me(admin().sid)).admin).toBe(true);
  });

  it("a deleting member sees the deletion and can restore it; every other member route treats them as signed out", async () => {
    const after = Date.now() + 86_400_000;
    const m = member(undefined, { status: "deleting", delete_after: after });
    expect(await me(m.sid)).toMatchObject({ signedIn: true, status: "deleting", deleteAfter: after });
    for (const [method, path] of [
      ["GET", "/api/me/sessions"],
      ["GET", "/api/me/passkeys"],
      ["GET", "/api/me/audit"],
      ["DELETE", "/api/me"],
      ["DELETE", "/api/me/sessions/AAAAAAAAAAAAAAAAAAAAAA"],
      ["POST", "/api/admin/view"],
    ] as const) {
      const res = await api.call(method, path, method === "GET" ? undefined : {}, cookie(m.sid));
      expect(res.status, `${method} ${path}`).toBe(path.startsWith("/api/admin") ? 404 : 401);
    }
    const restored = await api.post("/api/me/restore", {}, cookie(m.sid));
    expect(restored.body).toEqual({ signedIn: true, deleting: false });
    expect(await me(m.sid)).toMatchObject({ status: "active", deleteAfter: null });
    expect((await api.call("GET", "/api/me/sessions", undefined, cookie(m.sid))).status).toBe(200);
  });

  it("restore after the grace is restore_too_late, and a suspended member is signed out", async () => {
    const late = member(undefined, { status: "deleting", delete_after: Date.now() - 1 });
    const res = await api.post("/api/me/restore", {}, cookie(late.sid));
    expect(res.body).toMatchObject({ code: "restore_too_late" });
    const suspended = member(undefined, { suspended_at: 1 });
    expect(await me(suspended.sid)).toEqual({ source: "mock", signedIn: false, launchMode: "preview" });
  });
});

describe("AUTH-13 signout-all and AUTH-09 device: sign-out", () => {
  it("AUTH-09 device: a plain sign-out ends this session, clears the session and hint cookies and keeps the device", async () => {
    const m = member();
    const other = session(m.id);
    const res = await api.post("/api/me/signout", {}, cookie(m.sid));
    expect(res.body).toEqual({ signedIn: false });
    expect(names(res)).toEqual(["__Host-bloop_sid", "__Host-bloop_in"]);
    expect((await me(m.sid)).signedIn).toBe(false);
    expect((await me(other)).signedIn).toBe(true);
  });

  it("AUTH-13 signout-all: every session of the member ends, and the device cookie is cleared too", async () => {
    const m = member();
    const other = session(m.id);
    const res = await api.post("/api/me/signout-all", {}, cookie(m.sid));
    expect(res.status).toBe(200);
    expect(names(res)).toEqual(["__Host-bloop_sid", "__Host-bloop_in", "__Host-bloop_dev"]);
    expect((await me(m.sid)).signedIn).toBe(false);
    expect((await me(other)).signedIn).toBe(false);
    expect(wrangler.d1(`SELECT count(*) AS n FROM phone_session WHERE user_id = '${m.id}'`)[0]?.n).toBe(0);
  });

  it("PAIR-06 write checks: sign-out everywhere needs the Origin and a JSON body", async () => {
    const m = member();
    for (const path of ["/api/me/signout", "/api/me/signout-all"]) {
      expect((await api.post(path, {}, { ...cookie(m.sid), origin: "https://evil.example" })).status).toBe(403);
      const form = await api.post(path, undefined, { ...cookie(m.sid), contentType: "text/plain", raw: "{}" });
      expect(form.status).toBe(415);
    }
    expect((await me(m.sid)).signedIn).toBe(true);
  });
});

describe("the devices and passkeys lists", () => {
  it("lists the member's sessions with the current one marked, and ends another by its id", async () => {
    const m = member();
    const other = session(m.id);
    const list = await api.call<{ id: string; label: string; current: boolean }[]>(
      "GET",
      "/api/me/sessions",
      undefined,
      cookie(m.sid),
    );
    expect(list.body.map((s) => [s.label, s.current]).sort()).toEqual([
      ["Safari on iPhone", false],
      ["Safari on iPhone", true],
    ]);
    const target = list.body.find((s) => !s.current)?.id as string;
    expect((await api.call("DELETE", `/api/me/sessions/${target}`, {}, cookie(m.sid))).status).toBe(204);
    expect((await me(other)).signedIn).toBe(false);
    expect((await me(m.sid)).signedIn).toBe(true);
  });

  it("lists, renames and, with a fresh proof only, removes the member's own passkeys", async () => {
    const m = member();
    const stale = session(m.id, Date.now() - 3_600_000);
    const stranger = member();
    for (const [id, owner] of [
      ["cred-mine", m.id],
      ["cred-theirs", stranger.id],
    ]) {
      wrangler.d1(
        `INSERT INTO passkey (id, user_id, public_key, sign_count, backed_up, name, created_at) VALUES ('${id}', '${owner}', x'00', 0, 1, 'Passkey', 1)`,
      );
    }
    const list = await api.call("GET", "/api/me/passkeys", undefined, cookie(m.sid));
    expect(list.body).toEqual([{ id: "cred-mine", name: "Passkey", createdAt: 1, lastUsedAt: null, backedUp: true }]);
    expect((await me(m.sid)).passkeys).toBe(1);

    const rename = (id: string, name: unknown) => api.call("PATCH", `/api/me/passkeys/${id}`, { name }, cookie(m.sid));
    expect((await rename("cred-mine", "  Work Phone ")).body).toEqual({ id: "cred-mine", name: "Work Phone" });
    expect((await rename("cred-theirs", "Mine now")).status).toBe(404);
    expect((await rename("cred-mine", "x".repeat(41))).status).toBe(400);
    expect((await rename("cred-mine", "a\u0007b")).status).toBe(400);

    const remove = (id: string, value: string) => api.call("DELETE", `/api/me/passkeys/${id}`, {}, cookie(value));
    expect((await remove("cred-mine", stale)).body).toMatchObject({ code: "reauth_required" });
    expect((await remove("cred-theirs", m.sid)).status).toBe(404);
    expect((await remove("cred-mine", m.sid)).status).toBe(204);
    expect(wrangler.d1("SELECT id FROM passkey ORDER BY id")).toEqual([{ id: "cred-theirs" }]);
  });

  it("DATA-05 dsar: an email member reads their own audit rows without the Graph source", async () => {
    const m = member();
    const res = await api.call<{ rows: unknown[]; nextId: number | null }>(
      "GET",
      "/api/me/audit",
      undefined,
      cookie(m.sid),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rows: [], nextId: null });
    expect((await api.call("GET", "/api/me/audit")).status).toBe(401);
  });
});

describe("MODE-01 gate: the admin view cookie", () => {
  it("MODE-01 gate: only an admin sets or clears the view cookie; a member and a stranger get not_found", async () => {
    const owner = admin();
    const plain = member();
    for (const who of [plain.sid, undefined]) {
      const res = await api.post("/api/admin/view", { open: true }, who ? cookie(who) : {});
      expect(res.status).toBe(404);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    const on = await api.post("/api/admin/view", { open: true }, cookie(owner.sid));
    expect(on.body).toEqual({ viewing: true });
    expect(on.headers.getSetCookie()[0]).toMatch(/^__Host-bloop_view=open; Max-Age=86400; Path=\/; Secure; HttpOnly;/);
    const off = await api.post("/api/admin/view", { open: false }, cookie(owner.sid));
    expect(off.headers.getSetCookie()[0]).toMatch(/^__Host-bloop_view=; Max-Age=0;/);
  });
});
