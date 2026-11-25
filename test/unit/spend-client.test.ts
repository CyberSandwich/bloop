import { describe, expect, it } from "vitest";
import { refusal, SpendClient, type SpendRpc } from "../../src/worker/spend/client.ts";
import { fakeGuard } from "./spend-helpers.ts";

const broken = (): SpendRpc => {
  throw new Error("namespace unreachable");
};

describe("COST-01 the client fails closed", () => {
  it("an unreachable guard refuses a take and an acquire, and says to retry", async () => {
    const lines: string[] = [];
    const client = new SpendClient(broken, (l) => lines.push(l));
    expect(await client.take("email", 1)).toEqual({ ok: false, reason: "unavailable", retryAfterSeconds: 30 });
    expect(await client.acquire("convert", 60, "u")).toEqual({
      ok: false,
      reason: "unavailable",
      retryAfterSeconds: 30,
    });
    expect(lines.map((l) => JSON.parse(l).op)).toEqual(["take", "acquire"]);
  });

  it("an RPC that rejects is refused too", async () => {
    const g = fakeGuard();
    g.guard.take = async () => {
      throw new Error("overloaded");
    };
    const client = new SpendClient(
      () => g.guard,
      () => {},
    );
    expect(await client.take("email", 1)).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("record, refund and release lose a call quietly: they report what happened, they gate nothing", async () => {
    const client = new SpendClient(broken, () => {});
    await expect(client.record("conversion_failed", 1)).resolves.toBeUndefined();
    await expect(client.refund("container_seconds", 5, undefined, 0)).resolves.toBeUndefined();
    await expect(client.release("x")).resolves.toBeUndefined();
    expect(await client.snapshot()).toBeNull();
  });

  it("passes a working guard straight through", async () => {
    const g = fakeGuard();
    const client = new SpendClient(() => g.guard);
    expect(await client.take("export_user", 1, "u")).toEqual({ ok: true });
    const lease = await client.acquire("convert_public", 60);
    expect(lease).toMatchObject({ ok: true });
    if (lease.ok) await client.release(lease.leaseId);
    expect((await client.snapshot())?.pools.convert_public.live).toBe(0);
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
