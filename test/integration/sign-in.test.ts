// The invite flow against a real wrangler dev: the first admin seeded by tools/invite.mjs --local, peek, accept, the
// code read from the dev mailbox, verify, the cookies, /api/me signed in, and the Terms version written (ADR 0014).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SITEVERIFY_URL } from "../../src/worker/auth/turnstile.ts";
import { Api, startPairing } from "./pairing-client.ts";
import type { Wrangler } from "./wrangler.ts";

const ADMIN = "admin@example.test";
const TOOL = fileURLToPath(new URL("../../tools/invite.mjs", import.meta.url));
/** Cloudflare's always-pass Turnstile test secret (ADR 0022). */
const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";

let wrangler: Wrangler;
let api: Api;

beforeAll(async () => {
  wrangler = await startPairing(
    {
      ADMIN_EMAILS: ADMIN,
      TEST_EMAILS: "test@example.test",
      CODE_PEPPER: "C".repeat(43),
      TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRET,
    },
    { migrate: true },
  );
  api = new Api(wrangler.url);
});
afterAll(async () => {
  await wrangler?.stop();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const mailbox = async (to: string) =>
  (await (await fetch(`${wrangler.url}/api/dev/mailbox?to=${encodeURIComponent(to)}`)).json()) as { text: string }[];

/** The code mailed to `to`, once the Worker's waitUntil has delivered it. */
async function mailedCode(to: string): Promise<string> {
  for (const end = Date.now() + 10_000; Date.now() < end; await sleep(100)) {
    const code = /(\d{6}) is your code/.exec((await mailbox(to)).at(-1)?.text ?? "")?.[1];
    if (code) return code;
  }
  throw new Error(`no code mailed to ${to}`);
}

/** Runs the SQL tools/invite.mjs --local prints for `email` and returns the link's token. */
function seedInvite(email: string): string {
  const printed = spawnSync(process.execPath, [TOOL, email, "--local"], { encoding: "utf8" });
  expect(printed.status).toBe(0);
  const [command, link] = printed.stdout.trim().split("\n");
  wrangler.d1(/--command "(.*)"$/.exec(command ?? "")?.[1] ?? "");
  return /#t=([A-Za-z0-9_-]{43})$/.exec(link ?? "")?.[1] ?? "";
}

describe("the invite flow", () => {
  it("INV-02 bound: the admin seeded by tools/invite.mjs accepts, verifies the mailed code and is signed in", async () => {
    const token = seedInvite(ADMIN);

    const peek = await api.post("/api/invite/peek", { token });
    expect(peek.body).toEqual({ state: "open", emailMasked: "a**@example.test", expiresAt: expect.any(Number) });

    const accepted = await api.post<{ challengeId: string }>("/api/invite/accept", { token });
    expect(accepted.status).toBe(202);
    const verified = await api.post("/api/invite/verify", {
      challengeId: accepted.body.challengeId,
      code: await mailedCode(ADMIN),
    });
    expect(verified.status).toBe(200);
    expect(verified.body).toEqual({ next: "/library", offerPasskey: true });
    const cookies = verified.headers.getSetCookie();
    expect(cookies.map((c) => c.split("=")[0])).toEqual(["__Host-bloop_sid", "__Host-bloop_in", "__Host-bloop_dev"]);
    const session = cookies[0]?.split(";")[0] ?? "";

    const me = await api.call("GET", "/api/me", undefined, { headers: { Cookie: session } });
    expect(me.body).toMatchObject({ signedIn: true, email: ADMIN, admin: true, status: "active" });
    expect(
      wrangler.d1(`SELECT terms_version, terms_accepted_at > 0 AS at FROM app_user WHERE email_norm = '${ADMIN}'`),
    ).toEqual([{ terms_version: "1", at: 1 }]);
    expect((await api.post("/api/invite/peek", { token })).body).toEqual({ state: "used" });
  });

  it("INV-04 dead: an invite to an address that already has an account rolls the batch back on real D1", async () => {
    const email = "test@example.test";
    wrangler.d1(
      `INSERT INTO app_user (id, tid, oid, email, email_norm, created_at, last_seen_at) VALUES ('m-existing', 'email', 'm-existing', '${email}', '${email}', 1, 1)`,
    );
    const sessions = () => wrangler.d1("SELECT count(*) AS n FROM phone_session")[0]?.n;
    const before = sessions();
    const token = seedInvite(email);
    const accepted = await api.post<{ challengeId: string }>("/api/invite/accept", { token });
    expect(accepted.status).toBe(202);
    const verified = await api.post("/api/invite/verify", {
      challengeId: accepted.body.challengeId,
      code: await mailedCode(email),
    });
    expect(verified.body).toMatchObject({ code: "invite_dead" });
    expect(verified.headers.getSetCookie()).toEqual([]);
    expect(wrangler.d1(`SELECT id FROM app_user WHERE email_norm = '${email}'`)).toEqual([{ id: "m-existing" }]);
    expect(sessions()).toBe(before);
    expect(wrangler.d1(`SELECT accepted_at FROM invite WHERE email_norm = '${email}'`)).toEqual([
      { accepted_at: null },
    ]);
  });
});

// The test secret passes any token, but only siteverify says so: this runs in CI and skips with no network.
const online =
  process.env.CI === "true" &&
  (await fetch(SITEVERIFY_URL, { method: "POST", signal: AbortSignal.timeout(5000) }).then(
    () => true,
    () => false,
  ));

describe.skipIf(!online)("AUTH-10 uniform against siteverify", () => {
  it("AUTH-10 uniform: a member and a stranger get the same 202 and keys, and only the member is mailed", async () => {
    wrangler.d1(
      "INSERT INTO app_user (id, tid, oid, email, email_norm, created_at, last_seen_at) VALUES ('m-u', 'email', 'm-u', 'member@example.test', 'member@example.test', 1, 1)",
    );
    const ask = async (email: string) => {
      const res = await api.post<Record<string, unknown>>("/api/auth/code/request", {
        email,
        turnstile: "XXXX.DUMMY.TOKEN.XXXX",
      });
      return { status: res.status, keys: Object.keys(res.body).sort(), cookies: res.headers.getSetCookie() };
    };
    const want = { status: 202, keys: ["challengeId", "expiresAt"], cookies: [] };
    expect(await ask("member@example.test")).toEqual(want);
    expect(await ask("stranger@example.test")).toEqual(want);
    expect(await mailedCode("member@example.test")).toMatch(/^\d{6}$/);
    expect(await mailbox("stranger@example.test")).toEqual([]);
  });
});
