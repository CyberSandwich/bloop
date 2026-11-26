// Invites (ADR 0014): auth/invites.ts and POST /api/invite/peek, /accept and /verify over the d1 shim.
import { beforeEach, describe, expect, it } from "vitest";
import { clearDevMailbox, readDevMailbox } from "../../src/worker/auth/email.ts";
import {
  acceptBatch,
  inviteHash,
  maskEmail,
  newInviteToken,
  peekInvite,
  TERMS_VERSION,
  upsertInvite,
} from "../../src/worker/auth/invites.ts";
import { invite as inviteMail } from "../../src/worker/auth/templates.ts";
import { headersFor } from "../../src/worker/headers.ts";
import { hmacHex, SECRET_SHAPE, sha256Hex } from "../../src/worker/ids.ts";
import { testDb } from "./d1-shim.ts";
import { authWorld, callRoute, cookieNames, PEPPER, seedMember, setMode, sid, waitingCtx } from "./member-fixture.ts";

type World = Awaited<ReturnType<typeof authWorld>>;
const DAY = 86_400_000;

beforeEach(() => clearDevMailbox());

/** An invite for `email`, open unless `columns` say otherwise; returns its token. */
async function seedInvite(
  db: World["db"],
  email: string,
  columns: { expires_at?: number; accepted_at?: number; revoked_at?: number } = {},
) {
  const token = newInviteToken();
  const now = Date.now();
  const id = await upsertInvite(db, {
    id: `i-${email}`,
    tokenHash: await inviteHash(token),
    emailNorm: email,
    email,
    note: null,
    createdBy: null,
    waitlistId: null,
    now,
    expiresAt: now + 7 * DAY,
  });
  for (const [column, value] of Object.entries(columns))
    db.raw.prepare(`UPDATE invite SET ${column} = ? WHERE id = ?`).run(value, id);
  return token;
}

const post = async (w: World, path: string, body: unknown, cookie?: string) => {
  const ctx = waitingCtx();
  const res = await callRoute(w.routes, w.env, "POST", path, { body, ctx, ...(cookie ? { cookie } : {}) });
  await ctx.flush();
  return { res, body: (await res.json()) as Record<string, unknown> };
};
const peek = (w: World, token: string) => post(w, "/api/invite/peek", { token });
const accept = (w: World, token: string) => post(w, "/api/invite/accept", { token });
const verify = (w: World, challengeId: unknown, code: string, cookie?: string) =>
  post(w, "/api/invite/verify", { challengeId, code }, cookie);
const mailedCode = (to: string) => /(\d{6}) is your code/.exec(readDevMailbox(to).at(-1)?.text ?? "")?.[1] ?? "";

const snapshot = (w: World) => ({
  invite: w.db.raw.prepare("SELECT * FROM invite ORDER BY id").all(),
  codes: w.db.raw.prepare("SELECT count(*) AS n FROM email_code").get(),
  users: w.db.raw.prepare("SELECT count(*) AS n FROM app_user").get(),
});

describe("INV-01 hash: only the token's hash is stored, and the token travels in a fragment", () => {
  it("INV-01 hash: the token is 43 characters, the row holds its SHA-256 and nowhere the token", async () => {
    const db = testDb();
    const token = newInviteToken();
    expect(token).toMatch(SECRET_SHAPE);
    await upsertInvite(db, {
      id: "i1",
      tokenHash: await inviteHash(token),
      emailNorm: "a@example.test",
      email: "a@example.test",
      note: null,
      createdBy: null,
      waitlistId: null,
      now: 0,
      expiresAt: DAY,
    });
    const row = db.raw.prepare("SELECT * FROM invite").get() as Record<string, unknown>;
    expect(row.token_hash).toBe(await sha256Hex(token));
    expect(Object.values(row).filter((v) => String(v).includes(token))).toEqual([]);
  });

  it("INV-01 hash: the mailed link carries the token after #t=, and the invite page sends no Referer", () => {
    const mail = inviteMail(
      { email: "a@example.test", token: "T".repeat(43), expiresAt: DAY },
      { origin: "https://bloop.here", codeTtlSeconds: 600 },
    );
    expect(mail.text).toContain(`https://bloop.here/invite#t=${"T".repeat(43)}`);
    expect(mail.text).not.toMatch(/invite\?/);
    expect(headersFor("auth")["Referrer-Policy"]).toBe("no-referrer");
  });

  it("maskEmail shows the first character and the domain only", () => {
    expect(maskEmail("you@example.test")).toBe("y**@example.test");
    expect(maskEmail("a@b.io")).toBe("a**@b.io");
  });
});

describe("INV-03 peek: opening a link changes nothing", () => {
  it("INV-03 peek: open, used, expired, revoked and unknown tokens all leave every row as it was and write no code", async () => {
    const w = await authWorld();
    setMode(w.db, "open");
    const tokens = {
      open: await seedInvite(w.db, "open@example.test"),
      used: await seedInvite(w.db, "used@example.test", { accepted_at: 1 }),
      expired: await seedInvite(w.db, "expired@example.test", { expires_at: 1 }),
      invalid: await seedInvite(w.db, "revoked@example.test", { revoked_at: 1 }),
    };
    const before = snapshot(w);
    for (const [state, token] of Object.entries(tokens)) expect((await peek(w, token)).body.state, state).toBe(state);
    expect((await peek(w, newInviteToken())).body).toEqual({ state: "invalid" });
    expect(snapshot(w)).toEqual(before);
    const open = (await peek(w, tokens.open)).body;
    expect(open).toEqual({ state: "open", emailMasked: "o**@example.test", expiresAt: expect.any(Number) });
  });

  it("INV-03 peek: a live session learns only whether the invite is its own (forYou), never the address", async () => {
    const w = await authWorld();
    setMode(w.db, "open");
    const token = await seedInvite(w.db, "invitee@example.test");
    const invitee = await seedMember(w.db, "u-invitee", "invitee@example.test");
    const other = await seedMember(w.db, "u-other", "other@example.test");
    const before = snapshot(w);
    expect((await post(w, "/api/invite/peek", { token }, sid(invitee))).body).toMatchObject({ forYou: true });
    const theirs = (await post(w, "/api/invite/peek", { token }, sid(other))).body;
    expect(theirs).toEqual({
      state: "open",
      emailMasked: "i**@example.test",
      expiresAt: expect.any(Number),
      forYou: false,
    });
    expect(JSON.stringify(theirs)).not.toContain("invitee@");
    // No session, or one that names nothing live: no forYou at all.
    expect((await peek(w, token)).body).not.toHaveProperty("forYou");
    expect((await post(w, "/api/invite/peek", { token }, sid("A".repeat(43)))).body).not.toHaveProperty("forYou");
    expect(snapshot(w)).toEqual(before);
  });
});

describe("INV-02 bound: the code goes to the invite's own address", () => {
  it("INV-02 bound: the accept body refuses an email key, and the code is mailed to the invite's address only", async () => {
    const w = await authWorld();
    setMode(w.db, "open");
    const token = await seedInvite(w.db, "invitee@example.test");
    const forwarded = await post(w, "/api/invite/accept", { token, email: "attacker@example.test" });
    expect(forwarded.res.status).toBe(400);
    expect(forwarded.body).toMatchObject({ code: "bad_request" });
    const ok = await accept(w, token);
    expect(ok.res.status).toBe(202);
    expect(ok.body).toEqual({
      challengeId: expect.any(String),
      emailMasked: "i**@example.test",
      expiresAt: expect.any(Number),
      expiresIn: expect.any(Number),
    });
    // The time left, so the page's deadline needs no device clock: the code's TTL, less the request's own time.
    expect(ok.body.expiresIn).toBeGreaterThan(590_000);
    expect(ok.body.expiresIn).toBeLessThanOrEqual(600_000);
    expect(readDevMailbox().map((m) => m.to)).toEqual(["invitee@example.test"]);
  });

  it("INV-02 bound: at most 5 codes a day per invite, then rate_limited with Retry-After", async () => {
    const w = await authWorld();
    setMode(w.db, "open");
    const token = await seedInvite(w.db, "invitee@example.test");
    for (let i = 0; i < 5; i++) expect((await accept(w, token)).res.status).toBe(202);
    const full = await accept(w, token);
    expect(full.res.status).toBe(429);
    expect(Number(full.res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});

describe("the invite flow: accept, then the mailed code creates the member", () => {
  it("INV-04 dead: the verified code creates the user with the Terms version, accepts the invite and signs in", async () => {
    const w = await authWorld();
    setMode(w.db, "open");
    const token = await seedInvite(w.db, "invitee@example.test");
    const { challengeId } = (await accept(w, token)).body;
    const done = await verify(w, challengeId, mailedCode("invitee@example.test"));
    expect(done.res.status).toBe(200);
    expect(done.body).toEqual({ next: "/library", offerPasskey: true });
    expect(cookieNames(done.res)).toEqual(["__Host-bloop_sid", "__Host-bloop_in", "__Host-bloop_dev"]);
    const user = w.db.raw
      .prepare("SELECT id, tid, oid, email_norm, terms_version, terms_accepted_at FROM app_user")
      .get() as Record<string, unknown>;
    expect(user).toMatchObject({
      tid: "email",
      oid: user.id,
      email_norm: "invitee@example.test",
      terms_version: TERMS_VERSION,
    });
    expect(user.terms_accepted_at).toEqual(expect.any(Number));
    expect(w.db.raw.prepare("SELECT user_id, accepted_at IS NOT NULL AS done FROM invite").get()).toEqual({
      user_id: user.id,
      done: 1,
    });
    expect((await peek(w, token)).body).toEqual({ state: "used" });
    expect((await accept(w, token)).body).toMatchObject({ code: "invite_dead" });
  });

  it("AUTH-08 rotate: an invite sign-in deletes the session the browser presented", async () => {
    const w = await authWorld();
    setMode(w.db, "open");
    const old = await seedMember(w.db, "m1", "member@example.test");
    const token = await seedInvite(w.db, "invitee@example.test");
    const { challengeId } = (await accept(w, token)).body;
    await verify(w, challengeId, mailedCode("invitee@example.test"), sid(old));
    expect(
      w.db.raw.prepare("SELECT count(*) AS n FROM phone_session WHERE id_hash = ?").get(await sha256Hex(old)),
    ).toEqual({ n: 0 });
  });

  it("INV-04 dead: an invite revoked, expired or accepted after its code went is invite_dead at verify, creating nothing", async () => {
    const w = await authWorld();
    setMode(w.db, "open");
    const kills: Record<string, string> = {
      revoked: "UPDATE invite SET revoked_at = 1",
      expired: "UPDATE invite SET expires_at = 1",
      accepted: "UPDATE invite SET accepted_at = 1",
    };
    for (const [name, kill] of Object.entries(kills)) {
      const email = `${name}@example.test`;
      const token = await seedInvite(w.db, email);
      const { challengeId } = (await accept(w, token)).body;
      w.db.raw.prepare(`${kill} WHERE email_norm = ?`).run(email);
      const dead = await verify(w, challengeId, mailedCode(email));
      expect(dead.body, name).toMatchObject({ code: "invite_dead" });
      expect(cookieNames(dead.res), name).toEqual([]);
    }
    expect(w.db.raw.prepare("SELECT count(*) AS n FROM app_user").get()).toEqual({ n: 0 });
    expect(w.db.raw.prepare("SELECT count(*) AS n FROM phone_session").get()).toEqual({ n: 0 });
  });

  it("INV-04 dead: accepted, revoked and expired invites are refused at accept, and a wrong code at verify is code_invalid", async () => {
    const w = await authWorld();
    setMode(w.db, "open");
    for (const columns of [{ accepted_at: 1 }, { revoked_at: 1 }, { expires_at: 1 }]) {
      const token = await seedInvite(w.db, `${Object.keys(columns)[0]}@example.test`, columns);
      expect((await accept(w, token)).body).toMatchObject({ code: "invite_dead" });
    }
    const token = await seedInvite(w.db, "open@example.test");
    const { challengeId } = (await accept(w, token)).body;
    const code = mailedCode("open@example.test");
    expect((await verify(w, challengeId, code === "000000" ? "111111" : "000000")).body).toMatchObject({
      code: "code_invalid",
    });
  });

  it("INV-04 dead: an address that already has an account gets invite_dead, and nothing is half written", async () => {
    const w = await authWorld();
    setMode(w.db, "open");
    await seedMember(w.db, "m1", "member@example.test");
    const token = await seedInvite(w.db, "member@example.test");
    const { challengeId } = (await accept(w, token)).body;
    const before = snapshot(w);
    const dead = await verify(w, challengeId, mailedCode("member@example.test"));
    expect(dead.body).toMatchObject({ code: "invite_dead" });
    expect({ ...snapshot(w), codes: before.codes }).toEqual(before);
  });

  it("acceptBatch creates no user, acceptance or session for a dead invite", async () => {
    const db = testDb();
    db.raw
      .prepare(
        "INSERT INTO invite (id, token_hash, email_norm, email, created_at, expires_at, revoked_at) VALUES ('i1', 'h', 'a@example.test', 'a@example.test', 0, ?, 1)",
      )
      .run(Date.now() + DAY);
    const session = db
      .prepare(
        "INSERT INTO phone_session (id_hash, user_id, created_at, last_seen_at, expires_at) SELECT 'x', 'u1', 0, 0, 1 WHERE EXISTS (SELECT 1 FROM app_user WHERE id = ?)",
      )
      .bind("u1");
    expect(await acceptBatch(db, { inviteId: "i1", userId: "u1", session: [session], now: Date.now() })).toBe(false);
    expect(
      db.raw.prepare("SELECT (SELECT count(*) FROM app_user) + (SELECT count(*) FROM phone_session) AS n").get(),
    ).toEqual({
      n: 0,
    });
  });

  it("a blocked address's invite is invite_dead at accept, and no code is mailed", async () => {
    const w = await authWorld();
    setMode(w.db, "open");
    const token = await seedInvite(w.db, "closed@example.test");
    w.db.raw
      .prepare("INSERT INTO email_block (email_hash, reason, created_at) VALUES (?, 'close', 0)")
      .run(`v1:${await hmacHex(PEPPER, "closed@example.test")}`);
    expect((await accept(w, token)).body).toMatchObject({ code: "invite_dead" });
    expect(readDevMailbox()).toEqual([]);
  });
});

describe("INV-05 resend: a reissue kills the old link", () => {
  it("INV-05 resend: the same row id, the old hash refused, sends + 1; a replayed hash changes nothing", async () => {
    const db = testDb();
    const input = (token: string) => ({
      id: "fresh-id",
      emailNorm: "a@example.test",
      email: "a@example.test",
      note: null,
      createdBy: null,
      waitlistId: null,
      now: 0,
      expiresAt: Date.now() + DAY,
      tokenHash: token,
    });
    const first = await upsertInvite(db, { ...input(await inviteHash("old")), id: "i1" });
    const again = await upsertInvite(db, input(await inviteHash("new")));
    expect([first, again]).toEqual(["i1", "i1"]);
    expect((await peekInvite(db, await inviteHash("old"), Date.now())).state).toBe("invalid");
    expect((await peekInvite(db, await inviteHash("new"), Date.now())).state).toBe("open");
    expect(db.raw.prepare("SELECT sends FROM invite").get()).toEqual({ sends: 2 });
    expect(await upsertInvite(db, input(await inviteHash("new")))).toBeNull();
    expect(db.raw.prepare("SELECT sends FROM invite").get()).toEqual({ sends: 2 });
  });

  it("INV-05 resend: an expired open invite is reissued in place, an accepted one is not reopened", async () => {
    const db = testDb();
    const base = {
      emailNorm: "a@example.test",
      email: "a@example.test",
      note: null,
      createdBy: null,
      waitlistId: null,
      now: 0,
      expiresAt: 1,
    };
    await upsertInvite(db, { ...base, id: "i1", tokenHash: "h1" });
    expect(await upsertInvite(db, { ...base, id: "i2", tokenHash: "h2", expiresAt: Date.now() + DAY })).toBe("i1");
    db.raw.prepare("UPDATE invite SET accepted_at = 1").run();
    expect(await upsertInvite(db, { ...base, id: "i3", tokenHash: "h3" })).toBe("i3");
    expect(db.raw.prepare("SELECT count(*) AS n FROM invite").get()).toEqual({ n: 2 });
  });
});

describe("MODE-01 gate: in preview, invites work only for ADMIN_EMAILS and TEST_EMAILS", () => {
  it("MODE-01 gate: peek of a non-test invite in preview is invalid and accept is invite_dead; a test address passes", async () => {
    const w = await authWorld();
    setMode(w.db, "preview");
    const outside = await seedInvite(w.db, "someone@example.test");
    const test = await seedInvite(w.db, "test@example.test");
    expect((await peek(w, outside)).body).toEqual({ state: "invalid" });
    expect((await accept(w, outside)).body).toMatchObject({ code: "invite_dead" });
    expect((await peek(w, test)).body).toMatchObject({ state: "open" });
    expect((await accept(w, test)).res.status).toBe(202);
    expect(readDevMailbox().map((m) => m.to)).toEqual(["test@example.test"]);
  });

  it("MODE-01 gate: a switch back to preview refuses the next accept and verify even with a warm cache", async () => {
    // TEST_TIMING off: the 30 s settings cache is on, as in production.
    const w = await authWorld({ TEST_TIMING: "0" });
    setMode(w.db, "open");
    const token = await seedInvite(w.db, "someone@example.test");
    const { challengeId } = (await accept(w, token)).body;
    setMode(w.db, "preview");
    expect((await peek(w, token)).body).toMatchObject({ state: "open" });
    expect((await accept(w, token)).body).toMatchObject({ code: "invite_dead" });
    expect((await verify(w, challengeId, mailedCode("someone@example.test"))).body).toMatchObject({
      code: "invite_dead",
    });
  });
});

describe("AUTH-09 purpose: each verify takes its own purpose", () => {
  it("AUTH-09 purpose: a sign-in challenge is refused by invite verify", async () => {
    const w = await authWorld();
    await seedMember(w.db, "m1", "member@example.test");
    const ctx = waitingCtx();
    const res = await callRoute(w.routes, w.env, "POST", "/api/auth/code/request", {
      body: { email: "member@example.test", turnstile: "tok" },
      ctx,
    });
    await ctx.flush();
    const { challengeId } = (await res.json()) as { challengeId: string };
    const code = /(\d{6}) is your code/.exec(readDevMailbox("member@example.test")[0]?.text ?? "")?.[1] ?? "";
    expect((await verify(w, challengeId, code)).body).toMatchObject({ code: "code_invalid" });
  });
});
