import { describe, expect, it } from "vitest";
import { type CapName, type MeterName, resolveCaps } from "../../src/worker/spend/caps.ts";
import { IsolateCounts, Reserves, refusal, SpendClient, type SpendRpc } from "../../src/worker/spend/client.ts";
import { DAY, fakeGuard, fakeSpend, T0 } from "./spend-helpers.ts";

const broken = (): SpendRpc => {
  throw new Error("namespace unreachable");
};

const caps = resolveCaps({});
const quiet = () => {};
/** `stub` serves the costly meters; the public meters go to `open`, the same guard unless given. */
const client = (
  stub: () => SpendRpc = broken,
  isolate = new IsolateCounts(() => T0),
  now = () => T0,
  reserves = new Reserves(now),
  clientCaps = () => caps,
  open: () => SpendRpc = stub,
) => new SpendClient({ global: stub, public: open }, clientCaps, quiet, isolate, now, reserves);

describe("COST-01 the client fails closed for anything that costs money", () => {
  it("an unreachable guard refuses a take and an acquire, and says to retry", async () => {
    const lines: string[] = [];
    const c = new SpendClient(
      { global: broken, public: broken },
      () => caps,
      (l) => lines.push(l),
      new IsolateCounts(() => T0),
    );
    expect(await c.take("container_seconds", 60)).toEqual({ ok: false, reason: "unavailable", retryAfterSeconds: 30 });
    expect(await c.acquire("convert", 60, "u")).toEqual({ ok: false, reason: "unavailable", retryAfterSeconds: 30 });
    expect(lines.map((l) => JSON.parse(l).op)).toEqual(["take", "acquire"]);
  });

  it("COST-01 each costly path is refused while the guard is down: container, part mint, upload, export", async () => {
    const down = { ok: false, reason: "unavailable", retryAfterSeconds: 30 };
    const c = client();
    const taken: [MeterName, string | undefined][] = [
      ["container_seconds", undefined],
      ["convert_user", "u"],
      ["convert_guest", "ip"],
      ["convert_demo", "ip"],
      ["upload_user", "u"],
      ["upload_user_bytes", "u"],
      ["guest_drop", "ip"],
      ["export_user", "u"],
    ];
    for (const [meter, scope] of taken) {
      expect(await c.take(meter as never, 1, scope), meter).toEqual(down);
    }
    for (const pool of ["convert", "convert_public", "export"] as const)
      expect(await c.acquire(pool, 60, "u"), pool).toEqual(down);
    // A part mint is a class A charge; a validation read is class B.
    expect(await c.charge("A", 1)).toEqual(down);
    expect(await c.charge("B", 64)).toEqual(down);
  });

  it("an RPC that rejects is refused too", async () => {
    const g = fakeGuard();
    g.guard.take = async () => {
      throw new Error("overloaded");
    };
    expect(await client(() => g.guard).take("upload_user", 1, "u")).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("record, refund and release lose a call quietly: they report what happened, they gate nothing", async () => {
    const c = client();
    await expect(c.record("conversion_failed", 1)).resolves.toBeUndefined();
    const ticket = { meter: "container_seconds", n: 5, takenAt: T0 } as const;
    await expect(c.refund(ticket)).resolves.toBeUndefined();
    await expect(c.release("x")).resolves.toBeUndefined();
  });

  it("passes a working guard straight through", async () => {
    const g = fakeGuard();
    const c = client(() => g.guard);
    expect(await c.take("export_user", 1, "u")).toMatchObject({ ok: true });
    const lease = await c.acquire("convert_public", 60);
    expect(lease).toMatchObject({ ok: true });
    if (lease.ok) await c.release(lease.leaseId);
    expect((await g.guard.snapshot()).pools.convert_public.live).toBe(0);
  });

  it("COST-02 a lost release response is retried once, so the lease does not latch convert off", async () => {
    const g = fakeGuard();
    const c = client(() => g.guard);
    const lease = await c.acquire("convert_public", 60);
    if (!lease.ok) throw new Error("expected a lease");
    const inner = g.guard.release;
    let calls = 0;
    g.guard.release = async (id) => {
      calls++;
      const held = await inner(id);
      if (calls === 1) throw new Error("response lost");
      return held;
    };
    await c.release(lease.leaseId);
    expect(calls).toBe(2);
    expect((await g.guard.snapshot()).pools.convert_public.live).toBe(0);
    g.guard.release = async () => {
      calls++;
      throw new Error("down");
    };
    await expect(c.release("x")).resolves.toBeUndefined();
    expect(calls).toBe(4);
  });
});

describe("a caller bug throws before any RPC; only a transport error is an outage", () => {
  /** A guard that must never be reached, and counts if it is. */
  const spy = () => {
    const g = fakeGuard();
    let reached = 0;
    for (const k of ["take", "acquire", "record", "refund"] as const) {
      const inner = g.guard[k] as (...a: unknown[]) => Promise<unknown>;
      (g.guard as Record<string, unknown>)[k] = async (...a: unknown[]) => {
        reached++;
        return inner(...a);
      };
    }
    return { g, reached: () => reached };
  };

  it("charge rejects n that is not a positive integer and leaves the reserve alone", async () => {
    const { g, reached } = spy();
    const c = client(() => g.guard);
    for (const n of [-1000, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      await expect(c.charge("A", n), String(n)).rejects.toThrow(RangeError);
    expect(reached()).toBe(0);
    // A negative n once added to the reserve; a NaN poisoned it for the isolate. Neither happened.
    for (let i = 0; i < 100; i++) expect((await c.charge("A", 1)).ok).toBe(true);
    expect(reached()).toBe(1);
  });

  it("take rejects a missing scope and a bad n, also for the meters that fail open", async () => {
    const { g, reached } = spy();
    for (const stub of [() => g.guard, broken]) {
      const c = client(stub);
      await expect(c.take("email_code", 1, undefined)).rejects.toThrow(RangeError);
      await expect(c.take("upload_user", 1, "")).rejects.toThrow(RangeError);
      await expect(c.take("upload_user_bytes", 0, "u")).rejects.toThrow(RangeError);
      await expect(c.take("email", Number.NaN)).rejects.toThrow(RangeError);
      await expect(c.take("export_user", 1.5, "u")).rejects.toThrow(RangeError);
    }
    expect(reached()).toBe(0);
  });

  it("acquire rejects a bad ttl, and a pool with a per-scope cap needs the scope", async () => {
    const { g, reached } = spy();
    const c = client(() => g.guard);
    await expect(c.acquire("export", 60)).rejects.toThrow(RangeError);
    await expect(c.acquire("convert", 0, "u")).rejects.toThrow(RangeError);
    expect(await c.acquire("convert_public", 60)).toMatchObject({ ok: true });
    expect(reached()).toBe(1);
  });

  it("record rejects a bad n", async () => {
    const { g, reached } = spy();
    await expect(client(() => g.guard).record("conversion_done", -1)).rejects.toThrow(RangeError);
    expect(reached()).toBe(0);
  });
});

describe("refund takes the ticket a take returned", () => {
  it("gives back what was taken, with the scope it was taken under, and never more", async () => {
    const g = fakeGuard();
    const c = client(() => g.guard);
    const taken = await c.take("upload_user_bytes", 100, "u1");
    if (!taken.ok) throw new Error("expected a ticket");
    expect(taken.ticket).toEqual({ meter: "upload_user_bytes", n: 100, scope: "u1", takenAt: T0 });
    await expect(c.refund(taken.ticket, 101)).rejects.toThrow(RangeError);
    await expect(c.refund(taken.ticket, 0)).rejects.toThrow(RangeError);
    await c.refund(taken.ticket, 40);
    expect((await g.guard.snapshot()).counters.upload_user_bytes.day).toBe(60);
    await c.refund(taken.ticket, 60);
    expect((await g.guard.snapshot()).counters.upload_user_bytes.day).toBe(0);
  });

  it("an unscoped meter's ticket has no scope, and a take admitted while the guard was down refunds nothing", async () => {
    const g = fakeGuard();
    const c = client(() => g.guard);
    const unscoped = await c.take("container_seconds", 600);
    if (!unscoped.ok) throw new Error("expected a ticket");
    expect(unscoped.ticket).toEqual({ meter: "container_seconds", n: 600, takenAt: T0 });
    await c.refund(unscoped.ticket, 200);
    expect((await g.guard.snapshot()).counters.container_seconds.day).toBe(400);

    // The public guard was down for the take (admitted by the isolate), so the guard never counted it.
    await g.guard.record("demo_session", 5);
    const open = await client(() => g.guard, undefined, undefined, undefined, undefined, broken).take(
      "demo_session",
      1,
    );
    if (!open.ok) throw new Error("expected an admission");
    expect(open.ticket.takenAt).toBe(0);
    await c.refund(open.ticket);
    expect((await g.guard.snapshot()).counters.demo_session.day).toBe(5);
  });
});

describe("the demo and email fail open, within a per-isolate cap", () => {
  const open: [MeterName, string | undefined, CapName][] = [
    ["email", undefined, "isolate_open_email_day"],
    ["demo_session", undefined, "isolate_open_demo_session_day"],
    ["email_code", "iphash", "isolate_open_email_code_ip_day"],
  ];

  for (const [meter, scope, capName] of open) {
    it(`${meter} is allowed while the guard is down, up to ${capName}, then refused with the wait until midnight`, async () => {
      const c = client();
      for (let i = 0; i < caps[capName]; i++)
        expect(await c.take(meter as never, 1, scope), `${meter} ${i}`).toMatchObject({ ok: true });
      const over = await c.take(meter as never, 1, scope);
      expect(over).toMatchObject({ ok: false, reason: "cap_hit", meter, period: "day" });
      if (!over.ok && over.reason === "cap_hit") expect(over.retryAfterSeconds).toBe(12 * 3600);
    });
  }

  it("the isolate count is per scope and per meter, and starts again the next UTC day", async () => {
    let now = T0;
    const isolate = new IsolateCounts(() => now);
    const c = client(broken, isolate, () => now);
    for (let i = 0; i < caps.isolate_open_email_code_ip_day; i++) await c.take("email_code", 1, "a");
    expect((await c.take("email_code", 1, "a")).ok).toBe(false);
    expect((await c.take("email_code", 1, "b")).ok).toBe(true);
    now = T0 + DAY;
    expect((await c.take("email_code", 1, "a")).ok).toBe(true);
  });

  it("clients in one isolate share the count, so a route cannot reset it by building a new client", async () => {
    const isolate = new IsolateCounts(() => T0);
    for (let i = 0; i < caps.isolate_open_demo_session_day; i++) await client(broken, isolate).take("demo_session", 1);
    expect((await client(broken, isolate).take("demo_session", 1)).ok).toBe(false);
  });

  it("a guard that answers is believed: its refusal stands and the isolate count is not used", async () => {
    const g = fakeGuard({ CAP_DEMO_SESSION_DAY: "1" });
    const c = client(() => g.guard);
    expect(await c.take("demo_session", 1)).toMatchObject({ ok: true });
    expect(await c.take("demo_session", 1)).toMatchObject({ ok: false, reason: "cap_hit", scope: "all" });
  });
});

describe("the public meters live on their own guard instance", () => {
  it("public meters reach only the public instance, and every other call only the global one", async () => {
    const global = fakeGuard();
    const open = fakeGuard();
    const c = client(
      () => global.guard,
      undefined,
      undefined,
      undefined,
      undefined,
      () => open.guard,
    );
    await c.take("demo_session", 1);
    await c.take("email", 1);
    await c.take("email_code", 1, "ip");
    await c.record("email", 1);
    await c.take("export_user", 1, "u");
    await c.charge("A", 1);
    await c.take("container_seconds", 60);
    const day = async (g: typeof global, m: MeterName) => (await g.guard.snapshot()).counters[m].day;
    expect([await day(open, "demo_session"), await day(open, "email"), await day(open, "email_code")]).toEqual([
      1, 2, 1,
    ]);
    expect([await day(global, "demo_session"), await day(global, "email"), await day(global, "email_code")]).toEqual([
      0, 0, 0,
    ]);
    expect([await day(global, "export_user"), await day(global, "container_seconds")]).toEqual([1, 60]);
    expect([
      await day(open, "export_user"),
      await day(open, "container_seconds"),
      await day(open, "r2_class_a"),
    ]).toEqual([0, 0, 0]);
  });

  it("COST-16 a public instance that is down or flooded refuses nothing costly, and the reverse", async () => {
    const global = fakeGuard();
    const publicDown = client(() => global.guard, undefined, undefined, undefined, undefined, broken);
    expect(await publicDown.take("upload_user", 1, "u")).toMatchObject({ ok: true });
    expect(await publicDown.acquire("convert", 60, "u")).toMatchObject({ ok: true });
    expect(await publicDown.charge("A", 1)).toMatchObject({ ok: true });
    // The public meter itself still fails open, within the isolate's allowance.
    expect(await publicDown.take("demo_session", 1)).toMatchObject({ ok: true });

    const open = fakeGuard();
    const globalDown = client(broken, undefined, undefined, undefined, undefined, () => open.guard);
    expect(await globalDown.take("demo_session", 1)).toMatchObject({ ok: true });
    expect(await globalDown.take("upload_user", 1, "u")).toMatchObject({ ok: false, reason: "unavailable" });
    // Only the public instance holds the count: the demo's cap binds there, whatever the other does.
    expect((await open.guard.snapshot()).counters.demo_session.day).toBe(1);
  });
});

describe("a cap row lowers the client's own caps like the guard's", () => {
  const lowered = (overrides: Partial<Record<CapName, number>>) => () => resolveCaps({}, overrides);

  it("cap.isolate_open_* rows lower what an isolate admits while the guard is down", async () => {
    const c = client(broken, undefined, undefined, undefined, lowered({ isolate_open_email_day: 1 }));
    expect((await c.take("email", 1)).ok).toBe(true);
    expect((await c.take("email", 1)).ok).toBe(false);
    const d = client(
      broken,
      new IsolateCounts(() => T0),
      undefined,
      undefined,
      lowered({ isolate_open_email_code_ip_day: 2 }),
    );
    expect([(await d.take("email_code", 1, "a")).ok, (await d.take("email_code", 1, "a")).ok]).toEqual([true, true]);
    expect((await d.take("email_code", 1, "a")).ok).toBe(false);
    const e = client(
      broken,
      new IsolateCounts(() => T0),
      undefined,
      undefined,
      lowered({ isolate_open_demo_session_day: 1 }),
    );
    expect([(await e.take("demo_session", 1)).ok, (await e.take("demo_session", 1)).ok]).toEqual([true, false]);
  });

  it("cap.r2_block_ops lowers the block an isolate reserves", async () => {
    const g = fakeGuard();
    const c = client(() => g.guard, undefined, undefined, undefined, lowered({ r2_block_ops: 10 }));
    await c.charge("A", 1);
    expect((await g.guard.snapshot()).counters.r2_class_a.month).toBe(10);
  });
});

describe("charge keeps the reserve honest", () => {
  it("a charge the guard refuses, or cannot answer, leaves the reserve for the next charge", async () => {
    const g = fakeGuard({ CAP_R2_CLASS_A_MONTH: "150" });
    let takes = 0;
    const inner = g.guard.take;
    g.guard.take = async (...a) => {
      takes++;
      return inner(...a);
    };
    let stub: () => SpendRpc = () => g.guard;
    const c = client(() => stub());
    expect((await c.charge("A", 1)).ok).toBe(true);
    // 99 are reserved. A charge of 150 is refused by the cap (two takes), then another while the guard is down.
    expect(await c.charge("A", 150)).toMatchObject({ ok: false, reason: "cap_hit" });
    stub = broken;
    expect(await c.charge("A", 150)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(takes).toBe(3);
    // The 99 are still spendable with the guard down, and no spend reaches it.
    for (let i = 0; i < 99; i++) expect((await c.charge("A", 1)).ok, `spend ${i}`).toBe(true);
    expect(takes).toBe(3);
  });

  it("COST-07 the reserve is dropped at the month's end, so a new month is charged from the guard", async () => {
    let now = Date.UTC(2026, 9, 31, 23, 59);
    const g = fakeGuard({}, now);
    const c = client(
      () => g.guard,
      undefined,
      () => now,
    );
    await c.charge("A", 1);
    expect((await g.guard.snapshot()).counters.r2_class_a.month).toBe(100);
    now = Date.UTC(2026, 10, 1, 0, 1);
    g.clock.now = now;
    // 99 are left from October; in November they are not spendable, so this reaches the guard for a block.
    await c.charge("A", 99);
    expect((await g.guard.snapshot()).counters.r2_class_a.month).toBe(100);
  });
});

describe("the compile-time refusal", () => {
  it("a caller cannot take or record the meters that are not theirs", async () => {
    const spend = fakeSpend();
    // @ts-expect-error r2_class_a goes through charge("A", n)
    await spend.take("r2_class_a", 1);
    // @ts-expect-error r2_class_b goes through charge("B", n)
    await spend.take("r2_class_b", 1);
    // @ts-expect-error d1_writes is read from analytics
    await spend.record("d1_writes", 1);
    // @ts-expect-error a refund takes a ticket, not the old four arguments
    await spend.refund("container_seconds", 5, undefined, 0);
  });
});

describe("charge: the exact monthly R2 cap, once per request", () => {
  it("charges class A and B against their own monthly caps and refuses past them", async () => {
    const g = fakeGuard({ CAP_R2_CLASS_A_MONTH: "10", CAP_R2_CLASS_B_MONTH: "100" });
    const c = client(() => g.guard);
    expect(await c.charge("A", 10)).toEqual({ ok: true });
    expect(await c.charge("A", 1)).toMatchObject({
      ok: false,
      reason: "cap_hit",
      meter: "r2_class_a",
      period: "month",
    });
    expect(await c.charge("B", 64)).toEqual({ ok: true });
    expect(await c.charge("B", 64)).toMatchObject({ ok: false, reason: "cap_hit", meter: "r2_class_b" });
    const snap = await g.guard.snapshot();
    // Class B took one whole block (100), and the second charge was short by 28 of a 100 cap.
    expect([snap.counters.r2_class_a.month, snap.counters.r2_class_b.month]).toEqual([10, 100]);
  });

  /** A guard that counts how many takes reach it. */
  const counting = (vars: Record<string, unknown>) => {
    const g = fakeGuard(vars);
    let takes = 0;
    const inner = g.guard.take;
    g.guard.take = async (...a) => {
      takes++;
      return inner(...a);
    };
    return { g, takes: () => takes };
  };

  it("250 charges of one op make 3 writes to the guard: each isolate reserves blocks of 100 and spends them locally", async () => {
    const { g, takes } = counting({});
    const c = client(() => g.guard);
    for (let i = 0; i < 250; i++) expect(await c.charge("A", 1)).toEqual({ ok: true });
    expect(takes()).toBe(3);
    // 300 reserved, 250 spent: the guard counts the reservation, so it errs high and never low.
    expect((await g.guard.snapshot()).counters.r2_class_a.month).toBe(300);
  });

  it("the cap refuses exactly at the block edge, and a cap that is not a multiple of the block is exact too", async () => {
    const edge = counting({ CAP_R2_CLASS_A_MONTH: "300" });
    const c = client(() => edge.g.guard);
    for (let i = 0; i < 300; i++) expect((await c.charge("A", 1)).ok, `charge ${i}`).toBe(true);
    expect(await c.charge("A", 1)).toMatchObject({ ok: false, reason: "cap_hit", meter: "r2_class_a" });

    const odd = counting({ CAP_R2_CLASS_A_MONTH: "250" });
    const d = client(() => odd.g.guard);
    for (let i = 0; i < 250; i++) expect((await d.charge("A", 1)).ok, `charge ${i}`).toBe(true);
    expect(await d.charge("A", 1)).toMatchObject({ ok: false, reason: "cap_hit" });
    expect((await odd.g.guard.snapshot()).counters.r2_class_a.month).toBe(250);
  });

  it("a charge larger than the block reserves whole blocks, and leftovers carry to the next charge", async () => {
    const { g, takes } = counting({});
    const c = client(() => g.guard);
    expect(await c.charge("B", 64)).toEqual({ ok: true });
    expect(await c.charge("B", 64)).toEqual({ ok: true });
    expect(takes()).toBe(2);
    expect((await g.guard.snapshot()).counters.r2_class_b.month).toBe(200);
  });

  it("classes have separate reserves, and two isolates' reserves add up in the guard", async () => {
    const { g, takes } = counting({});
    const a = client(() => g.guard);
    const b = client(() => g.guard);
    await a.charge("A", 1);
    await a.charge("B", 1);
    await b.charge("A", 1);
    expect(takes()).toBe(3);
    expect((await g.guard.snapshot()).counters.r2_class_a.month).toBe(200);
  });

  it("CAP_R2_BLOCK_OPS sets the block", async () => {
    const small = resolveCaps({ CAP_R2_BLOCK_OPS: "10" });
    const { g, takes } = counting({});
    const c = client(
      () => g.guard,
      undefined,
      undefined,
      undefined,
      () => small,
    );
    for (let i = 0; i < 25; i++) await c.charge("A", 1);
    expect(takes()).toBe(3);
  });
});

describe("a route takes the Spend interface, not the guard", () => {
  it("fakeSpend admits and records every call, and a method can be scripted to refuse", async () => {
    const spend = fakeSpend();
    expect(await spend.take("upload_user", 1, "u")).toMatchObject({ ok: true });
    expect(await spend.charge("B", 2)).toEqual({ ok: true });
    expect(spend.calls.map((c) => c.method)).toEqual(["take", "charge"]);
    const refusing = fakeSpend({
      take: async () => ({ ok: false, reason: "unavailable", retryAfterSeconds: 30 }),
    });
    expect(refusal((await refusing.take("export_user", 1, "u")) as never).status).toBe(503);
  });
});

describe("what a caller sends on refusal", () => {
  it("a cap is 429 rate_limited with the wait; busy and unreachable are 503 service_busy", () => {
    expect(
      refusal({ ok: false, reason: "cap_hit", meter: "email", period: "day", scope: "all", retryAfterSeconds: 120 }),
    ).toEqual({
      status: 429,
      code: "rate_limited",
      retryAfterSeconds: 120,
    });
    expect(refusal({ ok: false, reason: "busy", retryAfterSeconds: 7 })).toEqual({
      status: 503,
      code: "service_busy",
      retryAfterSeconds: 7,
    });
    expect(refusal({ ok: false, reason: "unavailable", retryAfterSeconds: 30 })).toEqual({
      status: 503,
      code: "service_busy",
      retryAfterSeconds: 30,
    });
  });

  it("refusing a success is a bug and throws", () => {
    expect(() => refusal({ ok: true })).toThrow(TypeError);
  });
});
