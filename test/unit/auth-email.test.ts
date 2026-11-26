import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as EmailModule from "../../src/worker/auth/email.ts";
import { signinCode } from "../../src/worker/auth/templates.ts";
import { resolveCaps } from "../../src/worker/spend/caps.ts";
import { IsolateCounts, type Spend, SpendClient, type SpendRpc } from "../../src/worker/spend/client.ts";
import { fakeSpend } from "./spend-helpers.ts";

type Mod = typeof EmailModule;

const ADMIN = "admin@example.test";
const MEMBER = "member@example.test";
const CONFIG = { origin: "https://bloop.here", codeTtlSeconds: 600 };
const T0 = 1_800_000_000_000;

/** A fresh module per test: the dev mailbox is per isolate, at module scope. */
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

function deps(over: Partial<EmailModule.MailDeps> = {}): EmailModule.MailDeps {
  return {
    account: { emailFrom: "hi@bloop.here", adminEmails: new Set([ADMIN]), devMailbox: true },
    sender: undefined,
    spend: fakeSpend(),
    emailSwitch: "on",
    ...over,
  };
}

const message = (to = MEMBER, codeScope?: string): EmailModule.Message => ({
  to,
  ...signinCode({ code: "123456" }, CONFIG),
  ...(codeScope === undefined ? {} : { codeScope }),
});

const refusing = (answer: Awaited<ReturnType<Spend["take"]>>) =>
  fakeSpend({ take: (async () => answer) as Spend["take"] });

describe("email guard-down", () => {
  it("email guard-down: with the guard unreachable the spend client fails the email meters open, up to its isolate cap", async () => {
    const c = ctx();
    const down = () =>
      ({
        take: async () => {
          throw new Error("unreachable");
        },
      }) as unknown as SpendRpc;
    const caps = () => resolveCaps({ CAP_ISOLATE_OPEN_EMAIL_DAY: "3" });
    const spend = new SpendClient(
      { global: down, public: down },
      caps,
      () => {},
      new IsolateCounts(() => T0),
      () => T0,
    );
    const admitted = [];
    for (let i = 0; i < 5; i++) admitted.push(await mod.mail(deps({ spend }), c, message(), T0 + i));
    await c.flush();
    expect(admitted).toEqual([true, true, true, false, false]);
    expect(mod.readDevMailbox()).toHaveLength(3);
  });

  it("email guard-down: the email=off switch still stops mail, and takes nothing", async () => {
    const c = ctx();
    const spend = fakeSpend();
    expect(await mod.mail(deps({ spend, emailSwitch: "off" }), c, message(), T0)).toBe(false);
    await c.flush();
    expect(spend.calls).toEqual([]);
    expect(mod.readDevMailbox()).toEqual([]);
  });

  it("email guard-down: a refusal of either take, a cap or an unreachable guard, sends nothing", async () => {
    const c = ctx();
    const answers = [
      { ok: false, reason: "cap_hit", meter: "email", period: "day", scope: "all", retryAfterSeconds: 60 },
      { ok: false, reason: "unavailable", retryAfterSeconds: 30 },
    ] as Awaited<ReturnType<Spend["take"]>>[];
    for (const answer of answers) {
      expect(await mod.mail(deps({ spend: refusing(answer) }), c, message(MEMBER, "ip"), T0)).toBe(false);
    }
    await c.flush();
    expect(mod.readDevMailbox()).toEqual([]);
  });
});

describe("email", () => {
  it("email: a code request takes email_code with its scope, then email; other mail takes email only", async () => {
    const c = ctx();
    const spend = fakeSpend();
    await mod.mail(deps({ spend }), c, message(MEMBER, "iphash"), T0);
    expect(spend.calls).toEqual([
      { method: "take", args: ["email_code", 1, "iphash"] },
      { method: "take", args: ["email", 1, undefined] },
    ]);
    spend.calls.length = 0;
    await mod.mail(deps({ spend }), c, message(), T0);
    expect(spend.calls).toEqual([{ method: "take", args: ["email", 1, undefined] }]);
  });

  it("email: admin_only mails ADMIN_EMAILS recipients only", async () => {
    const c = ctx();
    const d = deps({ emailSwitch: "admin_only" });
    expect(await mod.mail(d, c, message(MEMBER), T0)).toBe(false);
    expect(await mod.mail(d, c, message(" Admin@Example.test "), T0)).toBe(true);
  });

  it("AUTH-10 uniform: the binding gets the sender, and the response never waits for the mail", async () => {
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

  it("email: an address normalizeEmail refuses is never admitted or sent, under any switch", async () => {
    const c = ctx();
    for (const to of ["not an address", "a@b", "x@example.test\r\nBcc: y@example.test", ""]) {
      expect(await mod.mail(deps(), c, message(to), T0), to).toBe(false);
    }
    await c.flush();
    expect(mod.readDevMailbox()).toEqual([]);
  });

  it("email: wrangler.jsonc has the one EMAIL binding, which sends only as EMAIL_FROM", () => {
    const live = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
    const from = live.match(/"EMAIL_FROM": "([^"]+)"/)?.[1];
    expect(from).toBe("hi@bloop.here");
    expect(live).toContain(`"send_email": [{ "name": "EMAIL", "allowed_sender_addresses": ["${from}"] }]`);
  });
});
