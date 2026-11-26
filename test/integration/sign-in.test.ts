// The invite flow against a real wrangler dev: the first admin seeded by tools/invite.mjs --local, peek, accept, the
// code read from the dev mailbox, verify, the cookies, /api/me signed in, and the Terms version written (ADR 0014).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, startPairing } from "./pairing-client.ts";
import type { Wrangler } from "./wrangler.ts";

const ADMIN = "admin@example.test";
const TOOL = fileURLToPath(new URL("../../tools/invite.mjs", import.meta.url));

let wrangler: Wrangler;
let api: Api;

beforeAll(async () => {
  wrangler = await startPairing(
    { ADMIN_EMAILS: ADMIN, TEST_EMAILS: "test@example.test", CODE_PEPPER: "C".repeat(43) },
    { migrate: true },
  );
  api = new Api(wrangler.url);
});
afterAll(async () => {
  await wrangler?.stop();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The code mailed to `to`, once the Worker's waitUntil has delivered it. */
async function mailedCode(to: string): Promise<string> {
  for (const end = Date.now() + 10_000; Date.now() < end; await sleep(100)) {
    const mail = (await (await fetch(`${wrangler.url}/api/dev/mailbox?to=${encodeURIComponent(to)}`)).json()) as {
      text: string;
    }[];
    const code = /(\d{6}) is your code/.exec(mail.at(-1)?.text ?? "")?.[1];
    if (code) return code;
  }
  throw new Error(`no code mailed to ${to}`);
}

describe("the invite flow", () => {
  it("INV-02 bound: the admin seeded by tools/invite.mjs accepts, verifies the mailed code and is signed in", async () => {
    const printed = spawnSync(process.execPath, [TOOL, ADMIN, "--local"], { encoding: "utf8" });
    expect(printed.status).toBe(0);
    const [command, link] = printed.stdout.trim().split("\n");
    wrangler.d1(/--command "(.*)"$/.exec(command ?? "")?.[1] ?? "");
    const token = /#t=([A-Za-z0-9_-]{43})$/.exec(link ?? "")?.[1] ?? "";

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
});
