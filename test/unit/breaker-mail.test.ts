// The spend breaker's mail, end to end: the five-minute job with a tripped guard, G's once-a-day claim, and the
// release that a failed send triggers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALERT_MAIL_TRIES, breakerNotify, cronNotify } from "../../src/worker/auth/email.ts";
import type { CronJob } from "../../src/worker/cron.ts";
import type { Alert } from "../../src/worker/spend/breaker.ts";
import { testDb } from "./d1-shim.ts";
import { fakeGuard, T0 } from "./spend-helpers.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const ADMIN = "admin@example.test";
const OTHER = "admin2@example.test";
const ORIGIN = "http://localhost:8787";

type Sent = { to: string; subject: string; text: string };

function world(vars: Record<string, string> = {}) {
  const global = fakeGuard();
  const pub = fakeGuard();
  const sent: Sent[] = [];
  const send = vi.fn(async (m: Sent) => {
    sent.push(m);
    return { messageId: "m" };
  });
  const guards: Record<string, unknown> = { global: global.guard, public: pub.guard };
  const ns = { idFromName: (name: string) => name, get: (id: string) => guards[id], jurisdiction: () => ns };
  const db = testDb();
  const env = {
    PUBLIC_ORIGIN: ORIGIN,
    ADMIN_EMAILS: `${ADMIN}, ${OTHER}`,
    DB: db,
    EMAIL: { send },
    SPEND_GUARD: ns,
    ...vars,
  };
  return { env, db, pub, send, sent };
}

async function breakerJob(): Promise<CronJob<object, unknown>> {
  // A non-literal specifier: cron-jobs.ts reaches the guard module, whose types need the Workers types.
  const path = "../../src/worker/cron-jobs.ts";
  const { spendBreakerJob } = (await import(path)) as { spendBreakerJob: () => CronJob<object, unknown> };
  return spendBreakerJob();
}

const trips = (sent: Sent[]) => sent.filter((m) => m.subject === "bloop Spend: trip");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("COST-14 the five-minute job mails a trip to the admins", () => {
  it("COST-14 a tripped guard mails each ADMIN_EMAILS address once, and the next run that day mails nothing", async () => {
    const w = world();
    w.pub.ledger.record("email", 95, undefined, T0);
    const job = await breakerJob();
    await job.run(w.env, undefined, 0);
    expect(
      trips(w.sent)
        .map((m) => m.to)
        .sort(),
    ).toEqual([ADMIN, OTHER].sort());
    expect(trips(w.sent)[0]?.text).toContain("Spend alert: trip.");
    await job.run(w.env, undefined, 0);
    expect(trips(w.sent)).toHaveLength(2);
  });

  it("COST-14 a send no admin received releases the day's claim, so the next run mails the trip", async () => {
    const w = world();
    w.pub.ledger.record("email", 95, undefined, T0);
    w.send.mockRejectedValue(Object.assign(new Error("down"), { code: "E_INTERNAL" }));
    const job = await breakerJob();
    await job.run(w.env, undefined, 0);
    expect(w.sent).toEqual([]);
    w.send.mockReset();
    w.send.mockImplementation(async (m: Sent) => {
      w.sent.push(m);
      return { messageId: "m" };
    });
    await job.run(w.env, undefined, 0);
    expect(
      trips(w.sent)
        .map((m) => m.to)
        .sort(),
    ).toEqual([ADMIN, OTHER].sort());
  });

  it("COST-14 the email switch decides, read fresh: off sends nothing and is not a failure", async () => {
    const w = world();
    w.db.raw.prepare("INSERT INTO setting (key, value, updated_at) VALUES ('email', 'off', 0)").run();
    w.pub.ledger.record("email", 95, undefined, T0);
    await (await breakerJob()).run(w.env, undefined, 0);
    expect(w.send).not.toHaveBeenCalled();
  });

  it("COST-16 with an invalid alert var the alert is the log line alone", async () => {
    const w = world({ PUBLIC_ORIGIN: "not a url" });
    const log = vi.mocked(console.log);
    const alert: Alert = { kind: "config_invalid", rule: "config_invalid", readings: { problems: 1 }, sources: "x" };
    await cronNotify(w.env, async () => true)(alert);
    expect(w.send).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(JSON.stringify({ evt: "breaker", ...alert }));
  });

  it("COST-16 DEV_MAILBOX never applies on a deployed origin, though this parse skips the config's refusal", async () => {
    const w = world({ PUBLIC_ORIGIN: "https://bloop.example", DEV_MAILBOX: "1" });
    const alert: Alert = { kind: "trip", rule: "email_day", readings: { sends: 95 }, sources: "x" };
    await cronNotify(w.env, async () => true)(alert);
    expect(w.sent.map((m) => m.to).sort()).toEqual([ADMIN, OTHER].sort());
  });

  it("COST-14 a send failing all day writes the alert's log line once and tries the mail at most 6 times", async () => {
    const w = world();
    w.pub.ledger.record("email", 95, undefined, T0);
    w.send.mockRejectedValue(Object.assign(new Error("down"), { code: "E_INTERNAL" }));
    const log = vi.mocked(console.log);
    const job = await breakerJob();
    for (let run = 0; run < 12; run++) await job.run(w.env, undefined, 0);
    const tripLines = log.mock.calls.filter(([line]) => {
      const parsed = JSON.parse(String(line)) as { evt?: string; kind?: string };
      return parsed.evt === "breaker" && parsed.kind === "trip";
    });
    expect(tripLines).toHaveLength(1);
    const toAdmin = w.send.mock.calls.filter(([m]) => m.to === ADMIN && m.subject === "bloop Spend: trip");
    expect(toAdmin).toHaveLength(ALERT_MAIL_TRIES);
  });

  it("COST-14 an unreachable claim store still logs and mails: the alert errs toward going out", async () => {
    const w = world();
    const alert: Alert = { kind: "trip", rule: "email_day", readings: { sends: 95 }, sources: "x" };
    await cronNotify(w.env, async () => {
      throw new Error("guard down");
    })(alert);
    expect(vi.mocked(console.log)).toHaveBeenCalledWith(JSON.stringify({ evt: "breaker", ...alert }));
    expect(w.sent.map((m) => m.to).sort()).toEqual([ADMIN, OTHER].sort());
  });
});

describe("breakerNotify", () => {
  const account = { emailFrom: "hi@bloop.here", adminEmails: new Set([ADMIN]), devMailbox: false };
  const alert: Alert = { kind: "trip", rule: "month_budget", readings: { spentUsd: 9 }, sources: "x" };

  it("mails the admins only, with no spend take, and throws when no address took it", async () => {
    const send = vi.fn(async () => ({ messageId: "m" }));
    await breakerNotify({ account, sender: { send }, emailSwitch: "admin_only" }, { origin: ORIGIN })(alert);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: ADMIN, subject: "bloop Spend: trip" }));
    const failing = vi.fn(async () => {
      throw new Error("down");
    });
    await expect(
      breakerNotify({ account, sender: { send: failing }, emailSwitch: "on" }, { origin: ORIGIN })(alert),
    ).rejects.toThrow("alert_undelivered");
    await expect(
      breakerNotify({ account, sender: undefined, emailSwitch: "on" }, { origin: ORIGIN })(alert),
    ).rejects.toThrow("alert_undelivered");
  });

  it("one address taking it is enough", async () => {
    const send = vi.fn(async (m: { to: string }) => {
      if (m.to === OTHER) throw new Error("bounced");
      return { messageId: "m" };
    });
    const both = { ...account, adminEmails: new Set([ADMIN, OTHER]) };
    await breakerNotify({ account: both, sender: { send }, emailSwitch: "on" }, { origin: ORIGIN })(alert);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("nothing to send (the switch off, no admin address) resolves without a send", async () => {
    const send = vi.fn(async () => ({ messageId: "m" }));
    await breakerNotify({ account, sender: { send }, emailSwitch: "off" }, { origin: ORIGIN })(alert);
    const none = { ...account, adminEmails: new Set<string>() };
    await breakerNotify({ account: none, sender: { send }, emailSwitch: "on" }, { origin: ORIGIN })(alert);
    expect(send).not.toHaveBeenCalled();
  });

  it("the Monday digest goes out with its own subject and text", async () => {
    const send = vi.fn(async (_m: Sent) => ({ messageId: "m" }));
    const digest = { kind: "digest" as const, subject: "bloop spend digest 2026-W48", text: "Line one\n\nLine two" };
    await breakerNotify(
      { account, sender: { send }, emailSwitch: "on" },
      { origin: ORIGIN },
    )({ ...digest, report: {} as never });
    const [m] = send.mock.calls[0] ?? [];
    expect(m?.subject).toBe(digest.subject);
    expect(m?.text).toContain("Line one\n\nLine two");
  });
});
