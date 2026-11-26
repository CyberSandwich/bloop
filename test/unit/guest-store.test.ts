// The ledger and deletion logic of the R2 guest drop, against an in-memory bucket and the real migration.
// `accept` streams through Workers-only classes and is covered by the integration tests.
import { describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "../../src/worker/audit.ts";
import { parseConfig } from "../../src/worker/config.ts";
import { sweepAgeMs } from "../../src/worker/seams/guest-drop/index.ts";
import { purgeGuest } from "../../src/worker/seams/guest-drop/purge.ts";
import { type Bucket, R2GuestDrop } from "../../src/worker/seams/guest-drop/r2.ts";
import { PROD_VARS } from "../env-vars.ts";
import { testDb } from "./d1-shim.ts";

class MemoryBucket implements Bucket {
  readonly objects = new Map<string, { size: number; uploaded: Date }>();
  failDelete = false;
  async put(key: string): Promise<{ size: number }> {
    this.objects.set(key, { size: 1, uploaded: new Date() });
    return { size: 1 };
  }
  async get(): Promise<null> {
    return null;
  }
  async head(key: string) {
    return this.objects.get(key) ?? null;
  }
  async delete(keys: string | string[]) {
    if (this.failDelete) throw new Error("r2 down");
    for (const k of [keys].flat()) this.objects.delete(k);
  }
  async list(options?: { prefix?: string }) {
    const objects = [...this.objects]
      .filter(([k]) => k.startsWith(options?.prefix ?? ""))
      .map(([key, o]) => ({ key, uploaded: o.uploaded }));
    return { objects, truncated: false };
  }
}

const HOUR = 60 * 60 * 1000;

function setup(budget = 1000, start = 1_000_000) {
  const bucket = new MemoryBucket();
  const db = testDb();
  let now = start;
  const drop = new R2GuestDrop(bucket, db, budget, () => now);
  return { bucket, db, drop, advance: (ms: number) => (now += ms), now: () => now };
}

const live = (db: ReturnType<typeof testDb>, session: string) =>
  db.raw.prepare("SELECT deleted_at FROM guest_file WHERE session_id = ?").get(session) as
    | { deleted_at: number | null }
    | undefined;

describe("DROP-05 budget", () => {
  it("reserves live bytes up to the budget and answers storage_full beyond it", async () => {
    const { drop } = setup(1000);
    expect((await drop.reserve("s1", 600, "a.pptx", "pptx")).ok).toBe(true);
    expect(await drop.reserve("s2", 600, "b.pptx", "pptx")).toEqual({ ok: false, error: "storage_full" });
    expect((await drop.reserve("s3", 400, "c.pdf", "pdf")).ok).toBe(true);
  });

  it("frees the budget when a session's file is purged", async () => {
    const { drop } = setup(1000);
    const first = await drop.reserve("s1", 900, "a.pptx", "pptx");
    expect(await drop.reserve("s2", 900, "b.pptx", "pptx")).toMatchObject({ ok: false });
    await drop.purge("s1", first.ok ? first.r2Key : null);
    expect((await drop.reserve("s2", 900, "b.pptx", "pptx")).ok).toBe(true);
  });

  it("lets a session reserve again once its earlier row is purged, without counting it twice", async () => {
    const { drop } = setup(1000);
    expect((await drop.reserve("s1", 800, "a.pptx", "pptx")).ok).toBe(true);
    await drop.purge("s1", null);
    expect((await drop.reserve("s1", 800, "a.pptx", "pptx")).ok).toBe(true);
  });

  it("hands out distinct, unguessable keys under g/", async () => {
    const { drop } = setup(10_000);
    const keys = await Promise.all(["s1", "s2", "s3"].map((s) => drop.reserve(s, 10, "a.pdf", "pdf")));
    const names = keys.map((k) => (k.ok ? k.r2Key : ""));
    expect(new Set(names).size).toBe(3);
    for (const n of names) expect(n).toMatch(/^g\/[A-Za-z0-9_-]{22}$/);
  });
});

describe("DROP-07 sweep", () => {
  it("deletes objects older than the age, keeps newer ones, and closes their rows", async () => {
    const { drop, bucket, db, advance } = setup();
    const old = await drop.reserve("old", 10, "a.pdf", "pdf");
    if (!old.ok) throw new Error("reserve");
    await bucket.put(old.r2Key);
    advance(3 * HOUR);
    const fresh = await drop.reserve("fresh", 10, "b.pdf", "pdf");
    if (!fresh.ok) throw new Error("reserve");
    await bucket.put(fresh.r2Key);
    // the in-memory bucket stamps real time: age the first object by hand
    const entry = bucket.objects.get(old.r2Key);
    if (entry) entry.uploaded = new Date(0);
    expect(await drop.sweep(2 * HOUR)).toBe(1);
    expect(bucket.objects.has(old.r2Key)).toBe(false);
    expect(bucket.objects.has(fresh.r2Key)).toBe(true);
    expect(live(db, "old")?.deleted_at).not.toBeNull();
    expect(live(db, "fresh")?.deleted_at).toBeNull();
  });

  it("waits out the longest session, so a session the phone made 10 h long keeps its file", async () => {
    const parsed = parseConfig({ ...PROD_VARS, SESSION_MAX_MINUTES: "720" });
    if (!parsed.ok) throw new Error(parsed.problems.join());
    const age = sweepAgeMs(parsed.config);
    // Two 5 min claim windows, a 15 min upload, the 12 h cap, then 10 min of slack.
    expect(age).toBe((10 + 15 + 720 + 10) * 60_000);
    const { drop, bucket, now } = setup(1000, 100 * HOUR);
    const keep = await drop.reserve("long", 10, "a.pdf", "pdf");
    const lost = await drop.reserve("lost", 10, "b.pdf", "pdf");
    if (!keep.ok || !lost.ok) throw new Error("reserve");
    await bucket.put(keep.r2Key);
    await bucket.put(lost.r2Key);
    const aged = (key: string, ms: number) => {
      const entry = bucket.objects.get(key);
      if (entry) entry.uploaded = new Date(now() - ms);
    };
    aged(keep.r2Key, 10 * HOUR);
    aged(lost.r2Key, age + HOUR);
    expect(await drop.sweep(age)).toBe(1);
    expect(bucket.objects.has(keep.r2Key)).toBe(true);
    expect(bucket.objects.has(lost.r2Key)).toBe(false);
  });

  it("closes a reservation whose upload never landed", async () => {
    const { drop, db, advance } = setup();
    await drop.reserve("ghost", 10, "a.pdf", "pdf");
    advance(3 * HOUR);
    await drop.sweep(2 * HOUR);
    expect(live(db, "ghost")?.deleted_at).not.toBeNull();
  });
});

describe("DROP-07 purge", () => {
  it("deletes by the file's key and by session id, and reports whether anything existed", async () => {
    const { drop, bucket } = setup();
    const r = await drop.reserve("s1", 10, "a.pdf", "pdf");
    if (!r.ok) throw new Error("reserve");
    await bucket.put(r.r2Key);
    expect(await drop.purge("s1", null)).toBe(true); // by session: no ref yet
    expect(bucket.objects.size).toBe(0);
    expect(await drop.purge("s1", r.r2Key)).toBe(false); // idempotent
  });

  it("CONV-09 deletes the converted outputs under the file's key too, and nothing of another file", async () => {
    const { drop, bucket } = setup();
    const r = await drop.reserve("s1", 10, "a.pptx", "pptx");
    if (!r.ok) throw new Error("reserve");
    for (const k of [r.r2Key, `${r.r2Key}/d/s/1920.pack`, `${r.r2Key}/n/notes.json`, `${r.r2Key}x`, "g/other/d/t.webp"])
      await bucket.put(k);
    await drop.purge("s1", r.r2Key);
    expect([...bucket.objects.keys()].sort()).toEqual([`${r.r2Key}x`, "g/other/d/t.webp"]);
  });

  it("leaves the row open when the delete fails, so the sweep finds it", async () => {
    const { drop, bucket, db } = setup();
    const r = await drop.reserve("s1", 10, "a.pdf", "pdf");
    if (!r.ok) throw new Error("reserve");
    await bucket.put(r.r2Key);
    bucket.failDelete = true;
    await expect(drop.purge("s1", r.r2Key)).rejects.toThrow();
    expect(live(db, "s1")?.deleted_at).toBeNull();
  });
});

describe("DROP-07 audit of the delete", () => {
  const file = { source: "guest", ref: "g/x", name: "a.pdf", type: "pdf" } as const;

  it("records guest.deleted once when an object existed, with no name or key in it", async () => {
    const recorded: AuditEvent[] = [];
    const deps = {
      drop: { purge: async () => true },
      audit: { record: async (e: AuditEvent) => void recorded.push(e) },
      now: () => 5,
    };
    await purgeGuest(deps, { sessionId: "sess", file });
    expect(recorded).toEqual([
      { sessionId: "sess", at: 5, actor: "system", type: "guest.deleted", detail: { source: "guest" } },
    ]);
  });

  it("records nothing when there was nothing to delete, and nothing for another source", async () => {
    const record = vi.fn();
    const purge = vi.fn(async () => false);
    await purgeGuest({ drop: { purge }, audit: { record }, now: () => 5 }, { sessionId: "s", file });
    await purgeGuest(
      { drop: { purge }, audit: { record }, now: () => 5 },
      { sessionId: "s", file: { ...file, source: "graph" } },
    );
    expect(record).not.toHaveBeenCalled();
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it("swallows a failed delete and a failed audit write", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      purgeGuest(
        {
          drop: {
            purge: async () => {
              throw new Error("down");
            },
          },
          audit: { record: vi.fn() },
          now: () => 1,
        },
        { sessionId: "s", file: null },
      ),
    ).resolves.toBeUndefined();
    await expect(
      purgeGuest(
        {
          drop: { purge: async () => true },
          audit: {
            record: async () => {
              throw new Error("db");
            },
          },
          now: () => 1,
        },
        { sessionId: "s", file },
      ),
    ).resolves.toBeUndefined();
    error.mockRestore();
  });
});
