import { describe, expect, it } from "vitest";
import { holdKey, settleHolds } from "../../src/worker/library/hold.ts";
import { addFile, libWith } from "./library-db.ts";
import { fakeBucket } from "./library-r2.ts";

const NOW = 1_000_000_000;
const OLD = NOW - 3_600_000;
const YEAR = 365 * 86_400_000;

function pending(db: ReturnType<typeof libWith>, id: string, fileId: string, createdAt: number) {
  db.raw
    .prepare(
      `INSERT INTO hold (id, file_id, owner_user_id, bucket, r2_key, report_id, created_at, release_after, copied_at)
       VALUES (?, ?, 'u1', 'library', ?, 'r', ?, ?, NULL)`,
    )
    .run(id, fileId, holdKey(id), createdAt, NOW + YEAR);
}
const copiedAt = (db: ReturnType<typeof libWith>, id: string) =>
  (db.raw.prepare("SELECT copied_at AS c FROM hold WHERE id = ?").get(id) as { c: number | null } | undefined)?.c;

describe("the hourly sweep of pending holds", () => {
  it("R6: one sweep marks a pending row whose copy exists, at any age", async () => {
    const db = libWith();
    addFile(db, { id: "a" });
    pending(db, "h1", "a", NOW - 1000);
    const lib = fakeBucket({ [holdKey("h1")]: "copy" });
    const out = await settleHolds({ DB: db, LIBRARY: lib.bucket, GUEST_FILES: fakeBucket().bucket }, NOW);
    expect(out).toEqual({ settled: 1, more: false });
    expect(copiedAt(db, "h1")).toBe(NOW);
  });

  it("copies again from the source when the copy is missing and the row is older than an in-flight put", async () => {
    const db = libWith();
    addFile(db, { id: "a" });
    pending(db, "h1", "a", OLD);
    const lib = fakeBucket({ "u/u1/a/v1/orig": "bytes" });
    await settleHolds({ DB: db, LIBRARY: lib.bucket, GUEST_FILES: fakeBucket().bucket }, NOW);
    expect(new TextDecoder().decode(lib.objects.get(holdKey("h1")))).toBe("bytes");
    expect(copiedAt(db, "h1")).toBe(NOW);
  });

  it("leaves a young row with no copy alone, since its put may still be running", async () => {
    const db = libWith();
    addFile(db, { id: "a" });
    pending(db, "h1", "a", NOW - 1000);
    const lib = fakeBucket({ "u/u1/a/v1/orig": "bytes" });
    const out = await settleHolds({ DB: db, LIBRARY: lib.bucket, GUEST_FILES: fakeBucket().bucket }, NOW);
    expect(out.settled).toBe(0);
    expect(copiedAt(db, "h1")).toBeNull();
    expect(lib.objects.has(holdKey("h1"))).toBe(false);
  });

  it("deletes an old pending row whose source is gone, and keeps a row it could not copy for the next tick", async () => {
    const db = libWith();
    addFile(db, { id: "gone", status: "purged" });
    addFile(db, { id: "b" });
    pending(db, "h1", "gone", OLD);
    pending(db, "h2", "b", OLD + 1);
    const lib = fakeBucket({ "u/u1/b/v1/orig": "bytes" });
    const flaky = { ...lib.bucket, put: async () => Promise.reject(new Error("r2 busy")) };
    const out = await settleHolds({ DB: db, LIBRARY: flaky, GUEST_FILES: fakeBucket().bucket }, NOW);
    expect(out.settled).toBe(1);
    expect(copiedAt(db, "h1")).toBeUndefined();
    expect(copiedAt(db, "h2")).toBeNull();
  });

  it("settles at most a batch per sweep and says there is more", async () => {
    const db = libWith();
    const objects: Record<string, string> = {};
    for (let i = 0; i < 25; i++) {
      addFile(db, { id: `f${i}` });
      pending(db, `h${i}`, `f${i}`, OLD + i);
      objects[holdKey(`h${i}`)] = "copy";
    }
    const lib = fakeBucket(objects);
    const env = { DB: db, LIBRARY: lib.bucket, GUEST_FILES: fakeBucket().bucket };
    expect(await settleHolds(env, NOW)).toEqual({ settled: 20, more: true });
    expect(await settleHolds(env, NOW)).toEqual({ settled: 5, more: false });
  });
});
