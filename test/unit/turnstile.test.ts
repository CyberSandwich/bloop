import { describe, expect, it } from "vitest";
import {
  SITEVERIFY_URL,
  type TurnstileCheck,
  type TurnstileConfig,
  verifyTurnstile,
} from "../../src/worker/auth/turnstile.ts";
import { parseConfig } from "../../src/worker/config.ts";
import { PROD_VARS } from "../env-vars.ts";

const CONFIG: TurnstileConfig = {
  origin: "https://bloop.here",
  testTiming: false,
  secrets: { turnstileSecret: "s3cret" },
};
const IP = "203.0.113.7";
const KEY = "0b8f3c1e-6f4e-4c55-9a77-2f4c8e1d9a01";
const edge = (url = "https://bloop.here/api/auth/code/request") =>
  new Request(url, { headers: { "CF-Connecting-IP": IP } });
/** What `wrangler dev` hands the Worker: a local host and no CF-Connecting-IP. */
const local = () => new Request("http://127.0.0.1:8787/api/auth/code/request");
const CHECK: TurnstileCheck = { request: edge(), action: "signin", idempotencyKey: KEY };
const LOCAL_CHECK: TurnstileCheck = { request: local(), action: "signin" };
const PASS = { success: true, action: "signin", hostname: "bloop.here" };
const TEST_KEYS = { success: true, hostname: "example.com" };

function fake(answer: () => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer();
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}
const answering = (body: unknown, status = 200) => fake(async () => Response.json(body, { status }));
const sentKey = (f: ReturnType<typeof fake>, i: number) =>
  (f.calls[i]?.init.body as FormData | undefined)?.get("idempotency_key");

describe("turnstile", () => {
  it("turnstile: a passing answer for this action and host passes, and the secret, token, IP and idempotency key are sent", async () => {
    const f = answering(PASS);
    expect(await verifyTurnstile(CONFIG, "tok", CHECK, f.fetcher)).toEqual({ ok: true });
    expect(f.calls[0]?.url).toBe(SITEVERIFY_URL);
    const form = f.calls[0]?.init.body as FormData;
    expect(Object.fromEntries(form)).toEqual({ secret: "s3cret", response: "tok", remoteip: IP, idempotency_key: KEY });
    expect(f.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("turnstile: success false, an action mismatch and a hostname mismatch all fail closed", async () => {
    const cases = [
      [{ ...PASS, success: false }, "rejected"],
      [{ ...PASS, success: "true" }, "rejected"],
      [null, "rejected"],
      [{ ...PASS, action: "report" }, "action"],
      [{ ...PASS, action: undefined }, "action"],
      [{ ...PASS, action: "" }, "action"],
      [{ ...PASS, hostname: "evil.example" }, "hostname"],
    ] as const;
    for (const [body, reason] of cases) {
      expect(await verifyTurnstile(CONFIG, "tok", CHECK, answering(body).fetcher)).toEqual({ ok: false, reason });
    }
  });

  it("turnstile: a network error, a timeout, a 5xx and a non-JSON answer fail closed", async () => {
    const failures = [
      fake(async () => {
        throw new TypeError("network");
      }),
      fake(async () => {
        throw new DOMException("timed out", "TimeoutError");
      }),
      answering({}, 503),
      fake(async () => new Response("<html>", { status: 200 })),
    ];
    for (const f of failures) {
      expect(await verifyTurnstile(CONFIG, "tok", CHECK, f.fetcher)).toEqual({ ok: false, reason: "unreachable" });
    }
  });

  it("turnstile: with no secret it fails closed without a request", async () => {
    const f = answering(PASS);
    const none = { ...CONFIG, secrets: { turnstileSecret: null } };
    expect(await verifyTurnstile(none, "tok", CHECK, f.fetcher)).toEqual({ ok: false, reason: "no_secret" });
    expect(f.calls).toHaveLength(0);
  });

  it("turnstile: each check draws its own UUID idempotency key, and a key that is not a UUID is refused unsent", async () => {
    const f = answering(PASS);
    const fresh = { request: edge(), action: "signin" };
    expect(await verifyTurnstile(CONFIG, "tok", fresh, f.fetcher)).toEqual({ ok: true });
    expect(await verifyTurnstile(CONFIG, "tok", fresh, f.fetcher)).toEqual({ ok: true });
    expect(sentKey(f, 0)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(sentKey(f, 0)).not.toBe(sentKey(f, 1));
    for (const idempotencyKey of ["client-said-so", "", `${KEY}x`, "../../etc"]) {
      expect(await verifyTurnstile(CONFIG, "tok", { ...fresh, idempotencyKey }, f.fetcher)).toEqual({
        ok: false,
        reason: "bad_key",
      });
    }
    expect(f.calls).toHaveLength(2);
  });

  it("turnstile: TEST_TIMING on a local request takes the test keys' answer (example.com, no or empty action), never a different action", async () => {
    const test = { ...CONFIG, testTiming: true };
    for (const answer of [TEST_KEYS, { ...TEST_KEYS, action: "" }, { ...PASS, hostname: "example.com" }]) {
      expect(await verifyTurnstile(test, "tok", LOCAL_CHECK, answering(answer).fetcher)).toEqual({ ok: true });
    }
    expect(await verifyTurnstile(CONFIG, "tok", LOCAL_CHECK, answering(TEST_KEYS).fetcher)).toEqual({
      ok: false,
      reason: "action",
    });
    expect(await verifyTurnstile(test, "tok", LOCAL_CHECK, answering({ ...PASS, action: "x" }).fetcher)).toMatchObject({
      ok: false,
      reason: "action",
    });
  });

  it("turnstile: TEST_TIMING relaxes nothing for a request from the edge or for a deployed host", async () => {
    const test = { ...CONFIG, testTiming: true };
    const notLocal = [
      edge(),
      edge("http://127.0.0.1:8787/api/auth/code/request"),
      new Request("https://bloop.here/api/auth/code/request"),
    ];
    for (const request of notLocal) {
      expect(
        await verifyTurnstile(test, "tok", { request, action: "signin" }, answering(TEST_KEYS).fetcher),
        request.url,
      ).toEqual({ ok: false, reason: "action" });
    }
  });

  it("turnstile: the missing-action relaxation never reaches a deployed origin, since config refuses TEST_TIMING and DEV_MAILBOX there", async () => {
    const vars = { ...PROD_VARS, TURNSTILE_SECRET_KEY: "s3cret" };
    for (const origin of [
      PROD_VARS.PUBLIC_ORIGIN,
      "https://127.0.0.1.evil.example",
      "https://localhost.evil.example",
    ]) {
      for (const flag of ["TEST_TIMING", "DEV_MAILBOX"]) {
        const r = parseConfig({ ...vars, PUBLIC_ORIGIN: origin, [flag]: "1" });
        expect(r.ok, `${flag} on ${origin}`).toBe(false);
        expect(r.ok ? "" : r.problems.join(), origin).toContain(flag);
      }
      const deployed = parseConfig({ ...vars, PUBLIC_ORIGIN: origin });
      if (!deployed.ok) throw new Error(deployed.problems.join());
      expect(deployed.config.testTiming).toBe(false);
      expect(await verifyTurnstile(deployed.config, "tok", LOCAL_CHECK, answering(TEST_KEYS).fetcher)).toEqual({
        ok: false,
        reason: "action",
      });
    }
    const localConfig = parseConfig({ ...vars, PUBLIC_ORIGIN: "http://127.0.0.1:8787", TEST_TIMING: "1" });
    expect(localConfig.ok && localConfig.config.testTiming).toBe(true);
  });
});
