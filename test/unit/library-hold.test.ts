import { describe, expect, it } from "vitest";
import { HOLD_BATCH, holdFiles, holdKey, releaseHolds } from "../../src/worker/library/hold.ts";
import { addFile, libWith } from "./library-db.ts";
import { fakeBucket } from "./library-r2.ts";

const NOW = 1_000_000_000;
const YEAR = 365 * 86_400_000;
let n = 0;
const ids = () => `hold${++n}`;
const text = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

describe("OSA-02 hold", () => {
  it("copies a library file to h/<id> outside the user prefix and records it for a year", async () => {
    const db = libWith();
    addFile(db, { id: "a" });
    const lib = fakeBucket({ "u/u1/a/v1/orig": "bytes" });
    const guest = fakeBucket();
    const out = await holdFiles(
      { DB: db, LIBRARY: lib.bucket, GUEST_FILES: guest.bucket },
      { reportId: "r1", target: { fileIds: ["a"] } },
      NOW,
      ids,
    );
    expect(out.held).toHaveLength(1);
    const { holdId } = out.held[0] as { holdId: string };
    expect(text(lib.objects.get(holdKey(holdId)))).toBe("bytes");
    expect(db.raw.prepare("SELECT file_id, owner_user_id, r2_key, release_after, report_id FROM hold").all()).toEqual([
      {
        file_id: "a",
        owner_user_id: "u1",
        r2_key: holdKey(holdId),
        release_after: NOW + YEAR,
        report_id: "r1",
      },
    ]);
  });

  it("copies a guest file into the library bucket, never leaving it in the guest bucket's expiry", async () => {
    const db = libWith();
    db.raw
      .prepare(
        "INSERT INTO guest_file (session_id, r2_key, bytes, type, sha256, name, created_at) VALUES ('g', 'guest/g', 3, 'pdf', 'abc', 'g.pdf', 1)",
      )
      .run();
    const lib = fakeBucket();
    const guest = fakeBucket({ "guest/g": "pdf" });
    const out = await holdFiles(
      { DB: db, LIBRARY: lib.bucket, GUEST_FILES: guest.bucket },
      { reportId: "r1", target: { fileIds: ["g"] } },
      NOW,
      ids,
    );
    const { holdId } = out.held[0] as { holdId: string };
    expect(text(lib.objects.get(holdKey(holdId)))).toBe("pdf");
    expect(db.raw.prepare("SELECT owner_user_id, sha256 FROM hold").get()).toEqual({
      owner_user_id: null,
      sha256: "abc",
    });
  });

  it("holds a window of a user's files and skips purged ones", async () => {
    const db = libWith();
    addFile(db, { id: "a" });
    addFile(db, { id: "b", status: "purged" });
    const lib = fakeBucket({ "u/u1/a/v1/orig": "a", "u/u1/b/v1/orig": "b" });
    const out = await holdFiles(
      { DB: db, LIBRARY: lib.bucket, GUEST_FILES: fakeBucket().bucket },
      { reportId: "r", target: { userId: "u1", from: 0, to: 10 } },
      NOW,
      ids,
    );
    expect(out.held.map((h) => h.fileId)).toEqual(["a"]);
  });

  it("is repeatable: a second call holds nothing twice, and finishes a copy a crash left missing", async () => {
    const db = libWith();
    addFile(db, { id: "a" });
    const lib = fakeBucket({ "u/u1/a/v1/orig": "bytes" });
    const env = {
      DB: db,
      LIBRARY: lib.bucket,
      GUEST_FILES: fakeBucket().bucket,
    };
    const options = { reportId: "r1", target: { fileIds: ["a"] } };
    const first = await holdFiles(env, options, NOW, ids);
    const again = await holdFiles(env, options, NOW, ids);
    expect(again.held).toEqual(first.held);
    expect(db.raw.prepare("SELECT count(*) AS n FROM hold").get()).toEqual({
      n: 1,
    });

    const { holdId } = first.held[0] as { holdId: string };
    lib.objects.delete(holdKey(holdId));
    const healed = await holdFiles(env, options, NOW, ids);
    expect(healed.held).toEqual(first.held);
    expect(lib.objects.has(holdKey(holdId))).toBe(true);
    expect(db.raw.prepare("SELECT count(*) AS n FROM hold").get()).toEqual({
      n: 1,
    });
  });

  it("reports a file whose source object is gone as missing, with its hold row kept for the retry", async () => {
    const db = libWith();
    addFile(db, { id: "a" });
    const out = await holdFiles(
      {
        DB: db,
        LIBRARY: fakeBucket().bucket,
        GUEST_FILES: fakeBucket().bucket,
      },
      { reportId: "r", target: { fileIds: ["a", "nope"] } },
      NOW,
      ids,
    );
    expect(out).toMatchObject({
      held: [],
      missing: ["nope", "a"],
      more: false,
    });
  });

  it("copies at most a batch per call and says more", async () => {
    const db = libWith();
    const initial: Record<string, string> = {};
    const fileIds = Array.from({ length: HOLD_BATCH + 3 }, (_, i) => `f${String(i).padStart(2, "0")}`);
    for (const id of fileIds) {
      addFile(db, { id });
      initial[`u/u1/${id}/v1/orig`] = id;
    }
    const env = {
      DB: db,
      LIBRARY: fakeBucket(initial).bucket,
      GUEST_FILES: fakeBucket().bucket,
    };
    const first = await holdFiles(env, { reportId: "r", target: { fileIds } }, NOW, ids);
    expect(first.held).toHaveLength(HOLD_BATCH);
    expect(first.more).toBe(true);
    const second = await holdFiles(env, { reportId: "r", target: { fileIds } }, NOW, ids);
    expect(second.held).toHaveLength(fileIds.length);
    expect(second.more).toBe(false);
  });

  it("releases a hold past its time: copy and row go, a live hold stays", async () => {
    const db = libWith();
    const lib = fakeBucket({ "h/old": "x", "h/live": "y" });
    const add = db.raw.prepare(
      "INSERT INTO hold (id, file_id, owner_user_id, bucket, r2_key, created_at, release_after) VALUES (?, 'f', NULL, 'library', ?, 1, ?)",
    );
    add.run("old", "h/old", NOW - 1);
    add.run("live", "h/live", NOW + 1);
    expect(await releaseHolds({ DB: db, LIBRARY: lib.bucket }, NOW)).toEqual({
      released: 1,
      more: false,
    });
    expect([...lib.objects.keys()]).toEqual(["h/live"]);
    expect(db.raw.prepare("SELECT id FROM hold").all()).toEqual([{ id: "live" }]);
  });
});

describe("OSA-02 hold report", () => {
  it("names every id it could not hold: unknown ids are missing, never dropped", async () => {
    const db = libWith();
    addFile(db, { id: "a" });
    const out = await holdFiles(
      {
        DB: db,
        LIBRARY: fakeBucket({ "u/u1/a/v1/orig": "x" }).bucket,
        GUEST_FILES: fakeBucket().bucket,
      },
      { reportId: "r", target: { fileIds: ["a", "ghost"] } },
      NOW,
      ids,
    );
    expect(out.held.map((h) => h.fileId)).toEqual(["a"]);
    expect(out.missing).toEqual(["ghost"]);
  });

  it("a file purged after it was held is still reported held, and one purged unheld is missing", async () => {
    const db = libWith();
    addFile(db, { id: "a" });
    const lib = fakeBucket({ "u/u1/a/v1/orig": "x" });
    const env = {
      DB: db,
      LIBRARY: lib.bucket,
      GUEST_FILES: fakeBucket().bucket,
    };
    const first = await holdFiles(env, { reportId: "r", target: { fileIds: ["a"] } }, NOW, ids);
    db.raw.prepare("UPDATE library_file SET status = 'purged' WHERE id = 'a'").run();
    addFile(db, { id: "b", status: "purged" });
    const again = await holdFiles(env, { reportId: "r", target: { fileIds: ["a", "b"] } }, NOW, ids);
    expect(again.held).toEqual(first.held);
    expect(again.missing).toEqual(["b"]);
  });
});
