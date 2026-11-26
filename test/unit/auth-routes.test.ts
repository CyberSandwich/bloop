// The email sign-in routes over the d1 shim: POST /api/auth/code/request and /api/auth/code/verify (ADR 0014).
import { beforeEach, describe, expect, it } from "vitest";
import { clearDevMailbox, readDevMailbox } from "../../src/worker/auth/email.ts";
import { hmacHex, sha256Hex } from "../../src/worker/ids.ts";
import { authWorld, callRoute, cookieNames, PEPPER, seedMember, setMode, sid, waitingCtx } from "./member-fixture.ts";
import { fakeSpend } from "./spend-helpers.ts";

type World = Awaited<ReturnType<typeof authWorld>>;

beforeEach(() => clearDevMailbox());

async function request(w: World, email: string, cookie?: string) {
  const ctx = waitingCtx();
  const res = await callRoute(w.routes, w.env, "POST", "/api/auth/code/request", {
    body: { email, turnstile: "tok" },
    ctx,
    ...(cookie ? { cookie } : {}),
  });
  await ctx.flush();
  return res;
}

const verify = (
  w: World,
  challengeId: string,
  code: string,
  { cookie, next }: { cookie?: string; next?: string } = {},
) =>
  callRoute(w.routes, w.env, "POST", `/api/auth/code/verify${next ? `?next=${encodeURIComponent(next)}` : ""}`, {
    body: { challengeId, code },
    ...(cookie ? { cookie } : {}),
  });

/** The code mailed to `to` last, or null. */
const mailedCode = (to: string) => /(\d{6}) is your code/.exec(readDevMailbox(to).at(-1)?.text ?? "")?.[1] ?? null;

const setCookie = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0]
    ?.slice(name.length + 1) ?? null;

const block = async (w: World, email: string) =>
  w.db.raw
    .prepare("INSERT INTO email_block (email_hash, reason, created_at) VALUES (?, 'close', 0)")
    .run(`v1:${await hmacHex(PEPPER, email)}`);

/** A member asks for a code and reads it from the mailbox. Earlier codes are aged out of the bucket first. */
async function codeFor(w: World, email: string, cookie?: string) {
  w.db.raw.prepare("UPDATE email_code SET created_at = 0").run();
  const res = await request(w, email, cookie);
  if (res.status !== 202) throw new Error(`code request answered ${res.status}`);
  const { challengeId } = (await res.json()) as { challengeId: string };
  return { challengeId, code: mailedCode(email) as string };
}

describe("AUTH-10 uniform: the code request answers every address alike", () => {
  it("AUTH-10 uniform: a member, a deleting member, a stranger, a suspended, purging, blocked or lockout-refused member get the same 202; only the eligible are mailed", async () => {
    const w = await authWorld();
    await seedMember(w.db, "m1", "member@example.test");
    await seedMember(w.db, "m2", "deleting@example.test");
    await seedMember(w.db, "m3", "suspended@example.test");
    await seedMember(w.db, "m4", "purging@example.test");
    await seedMember(w.db, "m5", "blocked@example.test");
    await seedMember(w.db, "m6", "locked@example.test");
    await seedMember(w.db, "m7", "test@example.test");
    w.db.raw.prepare("UPDATE app_user SET status = 'deleting', delete_after = ? WHERE id = 'm2'").run(Date.now() + 1e6);
    w.db.raw.prepare("UPDATE app_user SET suspended_at = 1 WHERE id = 'm3'").run();
    w.db.raw.prepare("UPDATE app_user SET status = 'purging' WHERE id = 'm4'").run();
    await block(w, "blocked@example.test");

    const shape = async (email: string) => {
      const res = await request(w, email);
      const body = (await res.json()) as Record<string, unknown>;
      return { status: res.status, keys: Object.keys(body).sort(), cookies: cookieNames(res) };
    };
    const want = { status: 202, keys: ["challengeId", "expiresAt"], cookies: [] };
    for (const email of [
      "member@example.test",
      "deleting@example.test",
      "stranger@example.test",
      "suspended@example.test",
      "purging@example.test",
      "blocked@example.test",
    ])
      expect(await shape(email), email).toEqual(want);
    setMode(w.db, "preview", true);
    expect(await shape("locked@example.test")).toEqual(want);
    expect(await shape("test@example.test")).toEqual(want);

    const mailed = [...new Set(readDevMailbox().map((m) => m.to))].sort();
    expect(mailed).toEqual(["deleting@example.test", "member@example.test", "test@example.test"]);
    // Every address wrote its row, so a stranger costs what a member does.
    expect(w.db.raw.prepare("SELECT count(*) AS n FROM email_code WHERE purpose = 'signin'").get()).toEqual({ n: 8 });
  });

  it("AUTH-10 uniform: with a mailer that never resolves, the request still answers", async () => {
    const never = new Promise<never>(() => {});
    for (const deps of [{ spend: () => fakeSpend({ take: (() => never) as never }) }, { spend: () => fakeSpend() }]) {
      const w = await authWorld({ DEV_MAILBOX: "0" }, deps);
      const env = { ...w.env, EMAIL: { send: () => never } };
      await seedMember(w.db, "m1", "member@example.test");
      const ctx = waitingCtx();
      const res = await callRoute(w.routes, env, "POST", "/api/auth/code/request", {
        body: { email: "member@example.test", turnstile: "tok" },
        ctx,
      });
      expect(res.status).toBe(202);
    }
  });

  it("AUTH-10 uniform: a full bucket is the same 429 for a stranger and a member, with Retry-After", async () => {
    const w = await authWorld();
    await seedMember(w.db, "m1", "member@example.test");
    for (const email of ["member@example.test", "stranger@example.test"]) {
      for (let i = 0; i < 3; i++) expect((await request(w, email)).status).toBe(202);
      const full = await request(w, email);
      expect(full.status, email).toBe(429);
      expect(Number(full.headers.get("Retry-After"))).toBeGreaterThan(0);
    }
  });

  it("MODE-01 gate: a member the lockout refuses gets no mail, and the same 202", async () => {
    const w = await authWorld();
    await seedMember(w.db, "m1", "member@example.test");
    setMode(w.db, "preview", true);
    const res = await request(w, "member@example.test");
    expect(res.status).toBe(202);
    expect(readDevMailbox("member@example.test")).toEqual([]);
    setMode(w.db, "open");
    expect(mailedCode("member@example.test")).toBeNull();
    await request(w, "member@example.test");
    expect(mailedCode("member@example.test")).toMatch(/^\d{6}$/);
  });
});

describe("AUTH-09 routes: the code request", () => {
  it("AUTH-09 routes: a malformed address is email_invalid and a failed Turnstile turnstile_failed, both writing nothing", async () => {
    const w = await authWorld({}, { turnstile: async () => ({ ok: false, reason: "rejected" }) });
    expect(await (await request(w, "not-an-address")).json()).toMatchObject({ code: "email_invalid" });
    expect(await (await request(w, "member@example.test")).json()).toMatchObject({ code: "turnstile_failed" });
    expect(w.db.raw.prepare("SELECT count(*) AS n FROM email_code").get()).toEqual({ n: 0 });
  });

  it("AUTH-09 routes: Turnstile is checked for the signin action, and the mail takes email_code by IP hash and email", async () => {
    const w = await authWorld();
    await seedMember(w.db, "m1", "member@example.test");
    await request(w, "member@example.test");
    expect(w.actions).toEqual(["signin"]);
    const takes = w.spend.calls.filter((c) => c.method === "take").map((c) => c.args);
    expect(takes).toEqual([
      ["email_code", 1, await hmacHex(w.config.hashPepper, "local")],
      ["email", 1, undefined],
    ]);
  });

  it("AUTH-09 routes: CODE_PEPPER unset fails closed before any row", async () => {
    const w = await authWorld({ CODE_PEPPER: "" });
    const res = await request(w, "member@example.test");
    expect(res.status).toBe(500);
    expect(w.db.raw.prepare("SELECT count(*) AS n FROM email_code").get()).toEqual({ n: 0 });
  });

  it("AUTH-09 bucket: a request carrying the member's device cookie writes a known=1 row", async () => {
    const w = await authWorld();
    await seedMember(w.db, "m1", "member@example.test");
    const first = await codeFor(w, "member@example.test");
    const device = setCookie(await verify(w, first.challengeId, first.code), "__Host-bloop_dev") as string;
    await request(w, "member@example.test", `__Host-bloop_dev=${device}`);
    expect(w.db.raw.prepare("SELECT known FROM email_code ORDER BY created_at DESC, rowid DESC LIMIT 1").get()).toEqual(
      { known: 1 },
    );
  });
});

describe("AUTH-09 routes: code verify", () => {
  it("AUTH-09 routes: the mailed code signs in once, with the session, hint and device cookies", async () => {
    const w = await authWorld();
    await seedMember(w.db, "m1", "member@example.test");
    const { challengeId, code } = await codeFor(w, "member@example.test");
    const res = await verify(w, challengeId, code);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ next: "/library", offerPasskey: true });
    expect(cookieNames(res)).toEqual(["__Host-bloop_sid", "__Host-bloop_in", "__Host-bloop_dev"]);
    const value = setCookie(res, "__Host-bloop_sid") as string;
    expect(
      w.db.raw.prepare("SELECT user_id, method FROM phone_session WHERE id_hash = ?").get(await sha256Hex(value)),
    ).toEqual({ user_id: "m1", method: "code" });
    expect(await (await verify(w, challengeId, code)).json()).toMatchObject({ code: "code_invalid" });
  });

  it("AUTH-08 rotate: a code sign-in deletes the session the browser presented and issues a new value", async () => {
    const w = await authWorld();
    const old = await seedMember(w.db, "m1", "member@example.test");
    const { challengeId, code } = await codeFor(w, "member@example.test");
    const res = await verify(w, challengeId, code, { cookie: sid(old) });
    const fresh = setCookie(res, "__Host-bloop_sid");
    expect(fresh).not.toBe(old);
    expect(
      w.db.raw.prepare("SELECT count(*) AS n FROM phone_session WHERE id_hash = ?").get(await sha256Hex(old)),
    ).toEqual({ n: 0 });
  });

  it("AUTH-09 device: a device that already holds a live value keeps it; a stale one gets a new value", async () => {
    const w = await authWorld();
    await seedMember(w.db, "m1", "member@example.test");
    const a = await codeFor(w, "member@example.test");
    const device = setCookie(await verify(w, a.challengeId, a.code), "__Host-bloop_dev") as string;
    const b = await codeFor(w, "member@example.test", `__Host-bloop_dev=${device}`);
    const again = await verify(w, b.challengeId, b.code, { cookie: `__Host-bloop_dev=${device}` });
    expect(cookieNames(again)).toEqual(["__Host-bloop_sid", "__Host-bloop_in"]);
    w.db.raw.prepare("UPDATE app_user SET device_epoch = device_epoch + 1 WHERE id = 'm1'").run();
    const c = await codeFor(w, "member@example.test", `__Host-bloop_dev=${device}`);
    const stale = await verify(w, c.challengeId, c.code, { cookie: `__Host-bloop_dev=${device}` });
    expect(cookieNames(stale)).toContain("__Host-bloop_dev");
  });

  it("AUTH-09 routes: next is kept only when allowlisted, and /admin only for an admin", async () => {
    const w = await authWorld();
    await seedMember(w.db, "m1", "member@example.test");
    await seedMember(w.db, "a1", "admin@example.test");
    const land = async (email: string, next: string) => {
      const { challengeId, code } = await codeFor(w, email);
      return ((await (await verify(w, challengeId, code, { next })).json()) as { next: string }).next;
    };
    expect(await land("member@example.test", "/account")).toBe("/account");
    expect(await land("member@example.test", "/admin")).toBe("/library");
    expect(await land("member@example.test", "//evil.example/a")).toBe("/library");
    expect(await land("member@example.test", "/account/../admin")).toBe("/library");
    expect(await land("admin@example.test", "/admin")).toBe("/admin");
  });

  it("AUTH-09 routes: a wrong code, a stranger's challenge and a suspended, blocked or locked-out member are all code_invalid", async () => {
    const w = await authWorld();
    await seedMember(w.db, "m1", "member@example.test");
    const wrong = await codeFor(w, "member@example.test");
    const bad = wrong.code === "000000" ? "111111" : "000000";
    expect(await (await verify(w, wrong.challengeId, bad)).json()).toMatchObject({ code: "code_invalid" });

    const stranger = (await (await request(w, "stranger@example.test")).json()) as { challengeId: string };
    expect((await verify(w, stranger.challengeId, "123456")).status).toBe(400);

    const refusals: [string, () => Promise<void> | void, () => void][] = [
      [
        "suspended",
        () => void w.db.raw.prepare("UPDATE app_user SET suspended_at = 1 WHERE id = 'm1'").run(),
        () => void w.db.raw.prepare("UPDATE app_user SET suspended_at = NULL WHERE id = 'm1'").run(),
      ],
      ["blocked", () => block(w, "member@example.test"), () => void w.db.raw.prepare("DELETE FROM email_block").run()],
      ["locked out", () => setMode(w.db, "preview", true), () => setMode(w.db, "preview")],
    ];
    for (const [name, refuse, undo] of refusals) {
      const { challengeId, code } = await codeFor(w, "member@example.test");
      await refuse();
      const res = await verify(w, challengeId, code);
      expect(await res.json(), name).toMatchObject({ code: "code_invalid" });
      expect(cookieNames(res), name).toEqual([]);
      undo();
    }
  });

  it("AUTH-09 purpose: an invite challenge is refused by sign-in verify", async () => {
    const w = await authWorld();
    w.db.raw
      .prepare(
        "INSERT INTO invite (id, token_hash, email_norm, email, created_at, expires_at) VALUES ('i1', 'h', 'member@example.test', 'member@example.test', 0, ?)",
      )
      .run(Date.now() + 1e6);
    await seedMember(w.db, "m1", "member@example.test");
    const { issueCode } = await import("../../src/worker/auth/codes.ts");
    const issued = await issueCode(
      w.db,
      PEPPER,
      { purpose: "invite", emailNorm: "member@example.test", inviteId: "i1" },
      600,
    );
    if (issued.limited) throw new Error("limited");
    expect(await (await verify(w, issued.challengeId, issued.code)).json()).toMatchObject({ code: "code_invalid" });
  });
});
