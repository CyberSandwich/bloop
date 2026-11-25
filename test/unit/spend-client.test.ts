import { describe, expect, it } from "vitest";
import { type CapName, type MeterName, resolveCaps } from "../../src/worker/spend/caps.ts";
import { IsolateCounts, Reserves, refusal, SpendClient, type SpendRpc } from "../../src/worker/spend/client.ts";
import { DAY, fakeGuard, fakeSpend, T0 } from "./spend-helpers.ts";

const broken = (): SpendRpc => {
  throw new Error("namespace unreachable");
};

const caps = resolveCaps({});
const quiet = () => {};
const client = (
  stub: () => SpendRpc = broken,
  isolate = new IsolateCounts(() => T0),
  now = () => T0,
  reserves = new Reserves(),
  clientCaps = caps,
) => new SpendClient(stub, clientCaps, quiet, isolate, now, reserves);

describe("COST-01 the client fails closed for anything that costs money", () => {
  it("an unreachable guard refuses a take and an acquire, and says to retry", async () => {
    const lines: string[] = [];
    const c = new SpendClient(broken, caps, (l) => lines.push(l), new IsolateCounts(() => T0));
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
    await expect(c.refund("container_seconds", 5, undefined, 0)).resolves.toBeUndefined();
    await expect(c.release("x")).resolves.toBeUndefined();
    expect(await c.snapshot()).toBeNull();
  });

  it("passes a working guard straight through", async () => {
    const g = fakeGuard();
    const c = client(() => g.guard);
    expect(await c.take("export_user", 1, "u")).toEqual({ ok: true });
    const lease = await c.acquire("convert_public", 60);
    expect(lease).toMatchObject({ ok: true });
    if (lease.ok) await c.release(lease.leaseId);
    expect((await c.snapshot())?.pools.convert_public.live).toBe(0);
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
        expect(await c.take(meter as never, 1, scope), `${meter} ${i}`).toEqual({ ok: true });
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
    expect(await c.take("demo_session", 1)).toEqual({ ok: true });
    expect(await c.take("demo_session", 1)).toMatchObject({ ok: false, reason: "cap_hit", scope: "all" });
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
    const snap = await c.snapshot();
    // Class B took one whole block (100), and the second charge was short by 28 of a 100 cap.
    expect([snap?.counters.r2_class_a.month, snap?.counters.r2_class_b.month]).toEqual([10, 100]);
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
    expect((await c.snapshot())?.counters.r2_class_a.month).toBe(300);
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
    expect((await d.snapshot())?.counters.r2_class_a.month).toBe(250);
  });

  it("a charge larger than the block reserves whole blocks, and leftovers carry to the next charge", async () => {
    const { g, takes } = counting({});
    const c = client(() => g.guard);
    expect(await c.charge("B", 64)).toEqual({ ok: true });
    expect(await c.charge("B", 64)).toEqual({ ok: true });
    expect(takes()).toBe(2);
    expect((await c.snapshot())?.counters.r2_class_b.month).toBe(200);
  });

  it("classes have separate reserves, and two isolates' reserves add up in the guard", async () => {
    const { g, takes } = counting({});
    const a = client(() => g.guard);
    const b = client(() => g.guard);
    await a.charge("A", 1);
    await a.charge("B", 1);
    await b.charge("A", 1);
    expect(takes()).toBe(3);
    expect((await a.snapshot())?.counters.r2_class_a.month).toBe(200);
  });

  it("CAP_R2_BLOCK_OPS sets the block", async () => {
    const small = resolveCaps({ CAP_R2_BLOCK_OPS: "10" });
    const { g, takes } = counting({});
    const c = client(() => g.guard, undefined, undefined, undefined, small);
    for (let i = 0; i < 25; i++) await c.charge("A", 1);
    expect(takes()).toBe(3);
  });
});

describe("a route takes the Spend interface, not the guard", () => {
  it("fakeSpend admits and records every call, and a method can be scripted to refuse", async () => {
    const spend = fakeSpend();
    expect(await spend.take("upload_user", 1, "u")).toEqual({ ok: true });
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
