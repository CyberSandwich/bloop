import { describe, expect, it } from "vitest";
import { planReads, READ_PLAN, ReadBudgetExceeded, readParts } from "../../src/worker/seams/guest-drop/read-plan.ts";
import type { ZipEntry } from "../../src/worker/seams/guest-drop/zip.ts";

const MIB = 1024 * 1024;
const LOCAL_SIG = 0x04034b50;

/** An object of `size` bytes that is zeros except for a local header (and a body of 0x41) at each entry's offset. */
function fakeObject(size: number, entries: ZipEntry[], extra = 0) {
  const seen = { reads: 0, bytes: 0 };
  return {
    seen,
    size,
    read: async (offset: number, length: number) => {
      seen.reads++;
      const out = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
      seen.bytes += out.length;
      for (const e of entries) {
        const header = new Uint8Array(30 + e.name.length + extra);
        const v = new DataView(header.buffer);
        v.setUint32(0, LOCAL_SIG, true);
        v.setUint16(8, e.method, true);
        v.setUint16(26, e.name.length, true);
        v.setUint16(28, extra, true);
        header.set(new TextEncoder().encode(e.name), 30);
        const body = new Uint8Array(e.compressed).fill(0x41);
        const whole = new Uint8Array(header.length + body.length);
        whole.set(header);
        whole.set(body, header.length);
        const from = Math.max(offset, e.localOffset);
        const to = Math.min(offset + out.length, e.localOffset + whole.length);
        if (from < to) out.set(whole.subarray(from - e.localOffset, to - e.localOffset), from - offset);
      }
      return out;
    },
  };
}

const entry = (name: string, localOffset: number, compressed = 100): ZipEntry => ({
  name,
  method: 8,
  compressed,
  uncompressed: 0,
  localOffset,
});
const LIMITS = { maxEach: 256 * 1024, maxTotal: 8 * MIB };

describe("DROP-14 external: the read plan", () => {
  it("reads a small object once, whole, and slices every later read from it", async () => {
    const obj = fakeObject(2 * MIB, []);
    const plan = planReads(obj);
    for (let i = 0; i < 200; i++) await plan.read(i * 1000, 500);
    expect(obj.seen.reads).toBe(1);
    expect(obj.seen.bytes).toBe(2 * MIB);
  });

  it("allows a large object only maxReads reads", async () => {
    const plan = planReads(fakeObject(READ_PLAN.smallObjectBytes + 1, []));
    for (let i = 0; i < READ_PLAN.maxReads; i++) await plan.read(0, 10);
    expect(() => plan.read(0, 10)).toThrow(ReadBudgetExceeded);
  });

  it("coalesces entries closer than the gap into one read, and splits at a wider gap", async () => {
    const near = [entry("a", 1000), entry("b", 5000), entry("c", 300_000)];
    const obj = fakeObject(100 * MIB, near);
    const parts = await readParts(planReads(obj), near, LIMITS);
    expect(obj.seen.reads).toBe(1);
    expect(parts?.map((p) => p?.length)).toEqual([100, 100, 100]);
    const far = [entry("a", 1000), entry("b", 1000 + READ_PLAN.coalesceGapBytes + 10_000)];
    const split = fakeObject(100 * MIB, far);
    await readParts(planReads(split), far, LIMITS);
    expect(split.seen.reads).toBe(2);
  });

  it("splits a cluster at the per-read byte cap", async () => {
    const chain = Array.from({ length: 40 }, (_, i) => entry(`p${i}`, i * 512 * 1024));
    const obj = fakeObject(100 * MIB, chain);
    await readParts(planReads(obj), chain, LIMITS);
    expect(obj.seen.reads).toBe(Math.ceil((39 * 512 * 1024 + 100) / READ_PLAN.maxReadBytes));
    expect(obj.seen.bytes).toBeLessThanOrEqual(21 * MIB + 2 * READ_PLAN.maxReadBytes);
  });

  it("returns each part's bytes in the order asked, and null for a header that is not there", async () => {
    const real = [entry("a", 4000, 10), entry("b", 1000, 20)];
    const obj = fakeObject(100 * MIB, real);
    const lying = entry("ghost", 50_000, 10);
    const parts = await readParts(planReads(obj), [real[0] as ZipEntry, lying, real[1] as ZipEntry], LIMITS);
    expect(parts?.map((p) => p?.length ?? null)).toEqual([10, null, 20]);
    expect([...(parts?.[0] ?? [])].every((b) => b === 0x41)).toBe(true);
  });

  it("returns null for a local header whose method or name differs from the directory's", async () => {
    const real = entry("a", 1000, 10);
    const obj = fakeObject(100 * MIB, [real]);
    const plan = planReads(obj);
    expect((await readParts(plan, [{ ...real, method: 0 }], LIMITS))?.[0]).toBeNull();
    expect((await readParts(plan, [{ ...real, name: "b" }], LIMITS))?.[0]).toBeNull();
    expect((await readParts(plan, [real], LIMITS))?.[0]?.length).toBe(10);
  });

  it("re-reads once when a local extra field is longer than the slack", async () => {
    const one = [entry("a", 1000, 50)];
    const obj = fakeObject(100 * MIB, one, READ_PLAN.headerSlackBytes + 500);
    const parts = await readParts(planReads(obj), one, LIMITS);
    expect(parts?.[0]?.length).toBe(50);
    expect(obj.seen.reads).toBe(2);
  });

  it("refuses an entry over maxEach or a total over maxTotal before reading anything", async () => {
    const obj = fakeObject(100 * MIB, []);
    expect(await readParts(planReads(obj), [entry("a", 0, LIMITS.maxEach + 1)], LIMITS)).toBeNull();
    const many = Array.from({ length: 40 }, (_, i) => entry(`p${i}`, i * 1000, 250 * 1024));
    expect(await readParts(planReads(obj), many, LIMITS)).toBeNull();
    expect(obj.seen.reads).toBe(0);
  });

  it("spends more reads than the budget on parts spread across a very large object", async () => {
    const spread = Array.from({ length: 100 }, (_, i) => entry(`p${i}`, i * 3 * MIB));
    const plan = planReads(fakeObject(400 * MIB, spread));
    await expect(readParts(plan, spread, LIMITS)).rejects.toBeInstanceOf(ReadBudgetExceeded);
  });
});
