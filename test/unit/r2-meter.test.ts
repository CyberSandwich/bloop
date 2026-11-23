// The R2 free-tier hard stop: operations are counted in D1 before they run, per UTC month and class.
import { describe, expect, it } from "vitest";
import { QuotaExhausted } from "../../src/worker/seams/guest-drop/index.ts";
import { R2Meter } from "../../src/worker/seams/guest-drop/meter.ts";
import { type Bucket, R2GuestDrop } from "../../src/worker/seams/guest-drop/r2.ts";
import { testDb } from "./d1-shim.ts";

class CountingBucket implements Bucket {
  readonly objects = new Set<string>();
  calls = { put: 0, get: 0, head: 0, list: 0, delete: 0 };
  async put(key: string) {
    this.calls.put++;
    this.objects.add(key);
    return { size: 1 };
  }
  async get() {
    this.calls.get++;
    return { body: new ReadableStream<Uint8Array>(), size: 1, arrayBuffer: async () => new ArrayBuffer(1) };
  }
  async head(key: string) {
    this.calls.head++;
    return this.objects.has(key) ? { size: 1 } : null;
  }
  deleted: (string | string[])[] = [];
  async delete(keys: string | string[]) {
    this.calls.delete++;
    this.deleted.push(keys);
    for (const k of [keys].flat()) this.objects.delete(k);
  }
  /** Keys `list` reports (all uploaded at the epoch), `perPage` at a time. */
  listing: string[] = [];
  perPage = 1000;
  async list(options?: { cursor?: string }) {
    this.calls.list++;
    const from = Number(options?.cursor ?? 0);
    const page = this.listing.slice(from, from + this.perPage);
    const next = from + this.perPage;
    return {
      objects: page.map((key) => ({ key, uploaded: new Date(0) })),
      truncated: next < this.listing.length,
      cursor: String(next),
    };
  }
}

const JAN = Date.UTC(2026, 0, 15);
const FEB = Date.UTC(2026, 1, 1);
const counts = (db: ReturnType<typeof testDb>) =>
  Object.fromEntries(
    (db.raw.prepare("SELECT month, class, n FROM r2_ops").all() as { month: string; class: string; n: number }[]).map(
      (r) => [`${r.month}/${r.class}`, r.n],
    ),
  );

function setup(caps = { classA: 2, classB: 2 }, start = JAN) {
  const bucket = new CountingBucket();
  const db = testDb();
  let now = start;
  const drop = new R2GuestDrop(bucket, db, 1_000_000, () => now, caps);
  return { bucket, db, drop, setNow: (t: number) => (now = t) };
}

describe("R2 cap: the meter", () => {
  it("counts up to the cap, then refuses without counting further", async () => {
    const db = testDb();
    const meter = new R2Meter(db, { classA: 2, classB: 5 }, () => JAN);
    expect(await meter.charge("A")).toBe(true);
    expect(await meter.charge("A")).toBe(true);
    expect(await meter.charge("A")).toBe(false);
    expect(await meter.charge("A")).toBe(false);
    expect(counts(db)).toEqual({ "2026-01/A": 2 });
  });

  it("keeps the classes apart, and a month rollover starts from zero", async () => {
    const db = testDb();
    let now = JAN;
    const meter = new R2Meter(db, { classA: 1, classB: 1 }, () => now);
    expect(await meter.charge("A")).toBe(true);
    expect(await meter.charge("B")).toBe(true);
    expect(await meter.charge("A")).toBe(false);
    now = FEB;
    expect(await meter.charge("A")).toBe(true);
    expect(counts(db)).toEqual({ "2026-01/A": 1, "2026-01/B": 1, "2026-02/A": 1 });
  });

  it("hasRoom is false once either class is at its cap, and counts nothing", async () => {
    const db = testDb();
    const meter = new R2Meter(db, { classA: 5, classB: 1 }, () => JAN);
    expect(await meter.hasRoom()).toBe(true);
    await meter.charge("B");
    expect(await meter.hasRoom()).toBe(false);
    expect(counts(db)).toEqual({ "2026-01/B": 1 });
  });

  it("fails closed: a counter that cannot be written throws instead of allowing the call", async () => {
    const db = testDb();
    db.raw.exec("DROP TABLE r2_ops");
    await expect(new R2Meter(db, { classA: 5, classB: 5 }, () => JAN).charge("A")).rejects.toThrow();
  });
});

describe("R2 cap: the guest drop", () => {
  it("reads while under the class B cap, then throws QuotaExhausted before touching the bucket", async () => {
    const { drop, bucket } = setup({ classA: 5, classB: 2 });
    await drop.read("g/x");
    await drop.read("g/x");
    await expect(drop.read("g/x")).rejects.toBeInstanceOf(QuotaExhausted);
    expect(bucket.calls.get).toBe(2);
  });

  it("refuses a new reservation with storage_full once either class is at its cap", async () => {
    const a = setup({ classA: 1, classB: 5 });
    expect((await a.drop.reserve("s1", 10, "a.pdf", "pdf")).ok).toBe(true);
    await new R2Meter(a.db, { classA: 1, classB: 5 }, () => JAN).charge("A");
    expect(await a.drop.reserve("s2", 10, "b.pdf", "pdf")).toEqual({ ok: false, error: "storage_full" });
    const b = setup({ classA: 5, classB: 1 });
    await b.drop.read("g/x");
    expect(await b.drop.reserve("s1", 10, "a.pdf", "pdf")).toEqual({ ok: false, error: "storage_full" });
  });

  it("takes reservations again in the next month", async () => {
    const { drop, setNow } = setup({ classA: 5, classB: 1 });
    await drop.read("g/x");
    expect((await drop.reserve("s1", 10, "a.pdf", "pdf")).ok).toBe(false);
    setNow(FEB);
    expect((await drop.reserve("s1", 10, "a.pdf", "pdf")).ok).toBe(true);
    await drop.read("g/x");
  });

  it("still deletes at the cap: a purge skips only its existence check", async () => {
    const { drop, bucket } = setup({ classA: 5, classB: 1 });
    const r = await drop.reserve("s1", 10, "a.pdf", "pdf");
    if (!r.ok) throw new Error("reserve");
    await bucket.put(r.r2Key);
    await drop.read("g/x"); // class B now at the cap
    await drop.purge("s1", r.r2Key);
    expect(bucket.objects.size).toBe(0);
    expect(bucket.calls.head).toBe(0);
  });

  it("the sweep lists only while class A has room, and leaves its rows open when it cannot", async () => {
    const { drop, bucket, db } = setup({ classA: 1, classB: 5 });
    await drop.reserve("old", 10, "a.pdf", "pdf");
    await drop.sweep(0);
    expect(bucket.calls.list).toBe(1);
    db.raw.exec("UPDATE guest_file SET deleted_at = NULL");
    expect(await drop.sweep(0)).toBe(0);
    expect(bucket.calls.list).toBe(1);
    expect(db.raw.prepare("SELECT deleted_at FROM guest_file").get()).toEqual({ deleted_at: null });
  });

  it("purge deletes its keys one at a time, never in a bulk call", async () => {
    const { drop, bucket } = setup({ classA: 5, classB: 9 });
    const r = await drop.reserve("s1", 10, "a.pdf", "pdf");
    if (!r.ok) throw new Error("reserve");
    await drop.purge("s1", "g/other");
    expect(bucket.calls.delete).toBe(2);
    expect(bucket.deleted.every((k) => typeof k === "string")).toBe(true);
  });

  it("the sweep counts its bulk delete as a class A operation and stops when it is refused", async () => {
    const { drop, bucket, db } = setup({ classA: 1, classB: 5 });
    const r = await drop.reserve("old", 10, "a.pdf", "pdf");
    if (!r.ok) throw new Error("reserve");
    bucket.listing = [r.r2Key];
    expect(await drop.sweep(0)).toBe(0);
    expect(bucket.calls.list).toBe(1);
    expect(bucket.calls.delete).toBe(0);
    expect(db.raw.prepare("SELECT deleted_at FROM guest_file").get()).toEqual({ deleted_at: null });
  });

  it("the sweep closes only the rows whose objects it deleted when the page limit cuts it off", async () => {
    const { drop, bucket, db } = setup({ classA: 1000, classB: 5 });
    const keys: string[] = [];
    for (let i = 0; i < 21; i++) {
      const r = await drop.reserve(`s${i}`, 1, "a.pdf", "pdf");
      if (r.ok) keys.push(r.r2Key);
    }
    bucket.listing = keys;
    bucket.perPage = 1;
    expect(await drop.sweep(0)).toBe(20);
    const open = db.raw.prepare("SELECT r2_key FROM guest_file WHERE deleted_at IS NULL").all();
    expect(open).toEqual([{ r2_key: keys[20] }]);
  });

  it("a reservation never overwrites a live row, and a closed row can be replaced", async () => {
    const { drop } = setup({ classA: 5, classB: 5 });
    expect((await drop.reserve("s1", 10, "a.pdf", "pdf")).ok).toBe(true);
    expect(await drop.reserve("s1", 10, "a.pdf", "pdf")).toEqual({ ok: false, error: "already_uploaded" });
    await drop.purge("s1", null);
    expect((await drop.reserve("s1", 10, "a.pdf", "pdf")).ok).toBe(true);
  });

  it("fails closed: with no counter table a read is refused and the bucket is never called", async () => {
    const { drop, bucket, db } = setup();
    db.raw.exec("DROP TABLE r2_ops");
    await expect(drop.read("g/x")).rejects.toThrow();
    expect(bucket.calls.get).toBe(0);
    await expect(drop.reserve("s1", 10, "a.pdf", "pdf")).rejects.toThrow();
  });
});
