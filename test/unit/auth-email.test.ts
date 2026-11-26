import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as EmailModule from "../../src/worker/auth/email.ts";
import { signinCode } from "../../src/worker/auth/templates.ts";

type Mod = typeof EmailModule;
type Take = EmailModule.EmailSpend["take"];

const ADMIN = "admin@example.test";
const MEMBER = "member@example.test";
const CONFIG = { origin: "https://bloop.here", codeTtlSeconds: 600 };
const T0 = 1_800_000_000_000;

/** A fresh module per test: the guard-down counter and the dev mailbox are per isolate, at module scope. */
let mod: Mod;
let logs: string[];
beforeEach(async () => {
  vi.resetModules();
  mod = await import("../../src/worker/auth/email.ts");
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    logs.push(line);
  });
});
afterEach(() => vi.restoreAllMocks());

function ctx() {
  const pending: Promise<unknown>[] = [];
  return { waitUntil: (p: Promise<unknown>) => void pending.push(p), flush: () => Promise.all(pending) };
}

function deps(over: Partial<EmailModule.MailDeps> & { take?: Take } = {}): EmailModule.MailDeps {
  const take: Take = over.take ?? (async () => ({ ok: true }));
  return {
    account: { emailFrom: "hi@bloop.here", adminEmails: new Set([ADMIN]), devMailbox: true },
    sender: undefined,
    spend: { take },
    emailSwitch: "on",
    ...over,
  };
}

const message = (to = MEMBER, codeScope?: string): EmailModule.Message => ({
  to,
  ...signinCode({ code: "123456" }, CONFIG),
  ...(codeScope === undefined ? {} : { codeScope }),
});

const unavailable: Take = async () => ({ ok: false, reason: "unavailable", retryAfterSeconds: 30 });

describe("email guard-down", () => {
  it("email guard-down: with the guard unavailable a code still mails, up to the per-isolate cap and no further", async () => {
    const c = ctx();
    const d = deps({ take: unavailable });
    const admitted = [];
    for (let i = 0; i < mod.GUARD_DOWN_CAP + 5; i++) admitted.push(await mod.mail(d, c, message(MEMBER, "ip"), T0 + i));
    await c.flush();
    expect(admitted.filter(Boolean)).toHaveLength(mod.GUARD_DOWN_CAP);
    expect(mod.readDevMailbox()).toHaveLength(mod.GUARD_DOWN_CAP);
    expect(logs.filter((l) => l === JSON.stringify({ evt: "spend", kind: "guard_down" }))).toHaveLength(1);
    // A new window opens the cap again.
    expect(await mod.mail(d, c, message(), T0 + mod.GUARD_DOWN_WINDOW_MS)).toBe(true);
  });

  it("email guard-down: the email=off switch still stops mail, with the guard down or up", async () => {
    const c = ctx();
    const take = vi.fn(unavailable);
    expect(await mod.mail(deps({ take, emailSwitch: "off" }), c, message(), T0)).toBe(false);
    expect(await mod.mail(deps({ emailSwitch: "off" }), c, message(), T0)).toBe(false);
    await c.flush();
    expect(take).not.toHaveBeenCalled();
    expect(mod.readDevMailbox()).toEqual([]);
  });

  it("email guard-down: a real refusal (not an outage) sends nothing and does not use the cap", async () => {
    const c = ctx();
    const refused: Take = async () => ({ ok: false, reason: "cap", retryAfterSeconds: 60 });
    for (let i = 0; i < mod.GUARD_DOWN_CAP + 1; i++)
      expect(await mod.mail(deps({ take: refused }), c, message(), T0)).toBe(false);
    await c.flush();
    expect(mod.readDevMailbox()).toEqual([]);
    expect(logs).toEqual([]);
  });
});

describe("email", () => {
  it("email: a code request takes email_code with its scope, then email; other mail takes email only", async () => {
    const c = ctx();
    const take = vi.fn<Take>(async () => ({ ok: true }));
    await mod.mail(deps({ take }), c, message(MEMBER, "iphash"), T0);
    expect(take.mock.calls).toEqual([
      ["email_code", 1, "iphash"],
      ["email", 1],
    ]);
    take.mockClear();
    await mod.mail(deps({ take }), c, message(), T0);
    expect(take.mock.calls).toEqual([["email", 1]]);
  });

  it("email: admin_only mails ADMIN_EMAILS recipients only", async () => {
    const c = ctx();
    const d = deps({ emailSwitch: "admin_only" });
    expect(await mod.mail(d, c, message(MEMBER), T0)).toBe(false);
    expect(await mod.mail(d, c, message(" Admin@Example.test "), T0)).toBe(true);
  });

  it("email: the binding gets the sender, and the response never waits for it", async () => {
    const c = ctx();
    const send = vi.fn(() => new Promise<never>(() => {}));
    const d = deps({ account: { ...deps().account, devMailbox: false }, sender: { send } });
    expect(await mod.mail(d, c, message(), T0)).toBe(true);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: MEMBER, from: "hi@bloop.here", subject: "Your bloop Sign-In Code" }),
    );
  });

  it("email: E_RECIPIENT_SUPPRESSED reads like any sent mail to the caller and logs email_suppressed with no address", async () => {
    const c = ctx();
    const send = vi.fn(async () => {
      throw Object.assign(new Error("suppressed"), { code: "E_RECIPIENT_SUPPRESSED" });
    });
    const d = deps({ account: { ...deps().account, devMailbox: false }, sender: { send } });
    expect(await mod.mail(d, c, message(), T0)).toBe(true);
    await c.flush();
    expect(logs).toEqual([JSON.stringify({ evt: "email_suppressed" })]);
    expect(logs.join()).not.toContain(MEMBER);
  });

  it("email: another send error is logged by code only", async () => {
    const c = ctx();
    const send = vi.fn(async () => {
      throw Object.assign(new Error(`bad ${MEMBER}`), { code: "E_DAILY_LIMIT_EXCEEDED" });
    });
    await mod.mail(deps({ account: { ...deps().account, devMailbox: false }, sender: { send } }), c, message(), T0);
    await c.flush();
    expect(logs).toEqual([JSON.stringify({ evt: "email", kind: "send_failed", code: "E_DAILY_LIMIT_EXCEEDED" })]);
  });

  it("email: the dev mailbox keeps the newest 50, filters by recipient and clears", async () => {
    const c = ctx();
    for (let i = 0; i < 55; i++) await mod.mail(deps(), c, message(`m${i}@example.test`), T0 + i);
    await c.flush();
    const all = mod.readDevMailbox();
    expect(all).toHaveLength(50);
    expect(all[0]?.to).toBe("m5@example.test");
    expect(mod.readDevMailbox("m54@example.test")).toEqual([
      {
        to: "m54@example.test",
        subject: "Your bloop Sign-In Code",
        text: expect.stringContaining("123456"),
        at: T0 + 54,
      },
    ]);
    mod.clearDevMailbox();
    expect(mod.readDevMailbox()).toEqual([]);
  });

  it("email: the breaker's notify mails each ADMIN_EMAILS address and nobody else, without a spend take", async () => {
    const send = vi.fn(async (_m: { to: string }) => ({ messageId: "m" }));
    const take = vi.fn<Take>(async () => ({ ok: true }));
    const other = "admin2@example.test";
    const account = { ...deps({ take }).account, adminEmails: new Set([ADMIN, other]), devMailbox: false };
    for (const emailSwitch of ["on", "admin_only"] as const) {
      send.mockClear();
      await mod.breakerNotify({ account, sender: { send }, emailSwitch }, CONFIG)({ kind: "trip", spentUsd: 9 });
      expect(send.mock.calls.map(([m]) => m.to).sort()).toEqual([ADMIN, other].sort());
      for (const [m] of send.mock.calls)
        expect(m).toMatchObject({ from: "hi@bloop.here", subject: "bloop Spend: trip" });
    }
    expect(take).not.toHaveBeenCalled();
  });

  it("email: the breaker's notify sends nothing under email off, or with no admin address", async () => {
    const send = vi.fn(async () => ({ messageId: "m" }));
    const account = { ...deps().account, devMailbox: false };
    await mod.breakerNotify({ account, sender: { send }, emailSwitch: "off" }, CONFIG)({ kind: "trip" });
    const noAdmins = { ...account, adminEmails: new Set<string>() };
    await mod.breakerNotify({ account: noAdmins, sender: { send }, emailSwitch: "on" }, CONFIG)({ kind: "trip" });
    expect(send).not.toHaveBeenCalled();
  });

  it("email: wrangler.jsonc has the one EMAIL binding, which sends only as EMAIL_FROM", () => {
    const live = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
    const from = live.match(/"EMAIL_FROM": "([^"]+)"/)?.[1];
    expect(from).toBe("hi@bloop.here");
    expect(live).toContain(`"send_email": [{ "name": "EMAIL", "allowed_sender_addresses": ["${from}"] }]`);
  });
});
