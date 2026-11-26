import { describe, expect, it } from "vitest";
import { addSample, SAMPLE_NAME } from "../../src/worker/library/sample.ts";
import { fileRow } from "../../src/worker/library/store.ts";
import { kindOf, limitsWire, wireRow } from "../../src/worker/library/wire.ts";
import { addFile, libWith } from "./library-db.ts";
import { fakeBucket } from "./library-r2.ts";

const NOW = 5_000;
const deck = new Uint8Array(Array.from({ length: 300 }, (_, i) => i % 251));
const limits = { quotaBytes: 1_000, maxFiles: 3 };
const used = (db: ReturnType<typeof libWith>) =>
  (db.raw.prepare("SELECT used_bytes AS n FROM app_user WHERE id = 'u1'").get() as { n: number }).n;

describe("the Sample Deck", () => {
  it("adds a ready deck with its bytes, quota, CRC and a queued preparation", async () => {
    const db = libWith();
    const r2 = fakeBucket();
    const out = await addSample({ DB: db, LIBRARY: r2.bucket }, "u1", deck, limits, "s1", NOW);
    expect(out).toEqual({ ok: true, id: "s1" });
    expect(r2.objects.get("u/u1/s1/v1/orig")?.length).toBe(300);
    expect(await fileRow(db, "u1", "s1")).toMatchObject({
      name: SAMPLE_NAME,
      ext: "pptx",
      bytes: 300,
      status: "ready",
    });
    expect(used(db)).toBe(300);
    expect(db.raw.prepare("SELECT crc32, sha256 FROM library_file WHERE id = 's1'").get()).toMatchObject({
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(db.raw.prepare("SELECT status, owner_kind FROM derived WHERE file_id = 's1'").get()).toEqual({
      status: "queued",
      owner_kind: "library",
    });
  });

  it("refuses over the quota, counting reserved bytes, and leaves no row, bytes or object", async () => {
    const db = libWith();
    db.raw.prepare("UPDATE app_user SET used_bytes = 600, reserved_bytes = 150 WHERE id = 'u1'").run();
    const r2 = fakeBucket();
    expect(await addSample({ DB: db, LIBRARY: r2.bucket }, "u1", deck, limits, "s1", NOW)).toEqual({
      ok: false,
      error: "quota_exceeded",
    });
    expect(r2.objects.size).toBe(0);
    expect(used(db)).toBe(600);
    expect(db.raw.prepare("SELECT count(*) AS n FROM library_file").get()).toEqual({ n: 0 });
    expect(db.raw.prepare("SELECT count(*) AS n FROM derived").get()).toEqual({ n: 0 });
  });

  it("an account quota override beats the default", async () => {
    const db = libWith();
    db.raw.prepare("UPDATE app_user SET quota_bytes = 200 WHERE id = 'u1'").run();
    const r2 = fakeBucket();
    expect((await addSample({ DB: db, LIBRARY: r2.bucket }, "u1", deck, limits, "s1", NOW)).ok).toBe(false);
  });

  it("refuses at the file cap, counting trash but not purged rows", async () => {
    const db = libWith();
    addFile(db, { id: "a" });
    addFile(db, { id: "b", trashedAt: 1, purgeAfter: 99 });
    addFile(db, { id: "gone", status: "purged" });
    const r2 = fakeBucket();
    expect((await addSample({ DB: db, LIBRARY: r2.bucket }, "u1", deck, limits, "s1", NOW)).ok).toBe(true);
    const full = await addSample(
      { DB: db, LIBRARY: r2.bucket },
      "u1",
      deck,
      { ...limits, quotaBytes: 9_999 },
      "s2",
      NOW,
    );
    expect(full).toEqual({ ok: false, error: "library_full" });
    expect(r2.objects.has("u/u1/s2/v1/orig")).toBe(false);
  });

  it("two at once never pass the cap", async () => {
    const db = libWith();
    const r2 = fakeBucket();
    const env = { DB: db, LIBRARY: r2.bucket };
    const tight = { quotaBytes: 9_999, maxFiles: 1 };
    const both = await Promise.all([
      addSample(env, "u1", deck, tight, "x1", NOW),
      addSample(env, "u1", deck, tight, "x2", NOW),
    ]);
    expect(both.filter((o) => o.ok)).toHaveLength(1);
    expect(db.raw.prepare("SELECT count(*) AS n FROM library_file").get()).toEqual({ n: 1 });
    expect(used(db)).toBe(300);
  });

  it("a suspended or closing account adds nothing", async () => {
    const db = libWith();
    db.raw.prepare("UPDATE app_user SET status = 'deleting' WHERE id = 'u1'").run();
    const r2 = fakeBucket();
    expect((await addSample({ DB: db, LIBRARY: r2.bucket }, "u1", deck, limits, "s1", NOW)).ok).toBe(false);
    expect(r2.objects.size).toBe(0);
  });
});

describe("the row's kind and the list's limits", () => {
  it("names one glyph class per extension, and an unknown one a document", () => {
    expect(["pptx", "pdf", "xlsx", "jpg", "mov", "txt", "zzz"].map(kindOf)).toEqual([
      "deck",
      "document",
      "sheet",
      "image",
      "video",
      "document",
      "document",
    ]);
  });

  it("carries the kind on the wire row and the large-file choice size in the limits", async () => {
    const db = libWith();
    addFile(db, { id: "a", ext: "mov", name: "a.mov" });
    const row = await fileRow(db, "u1", "a");
    if (!row) throw new Error("row");
    expect(wireRow(row, null, undefined)).toMatchObject({ ext: "mov", kind: "video" });
    expect(limitsWire({ trashDays: 30, maxFileBytes: 9, largeFileChoiceBytes: 77 })).toMatchObject({
      largeFileChoiceBytes: 77,
    });
  });
});
