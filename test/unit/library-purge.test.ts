import { describe, expect, it } from "vitest";
import { LATE_WRITE_WINDOW_MS, type PurgeDeps, purgeDueFiles } from "../../src/worker/library/purge.ts";
import { fileRow } from "../../src/worker/library/store.ts";
import { addFile, type LibTestDb, libWith } from "./library-db.ts";
import { fakeBucket } from "./library-r2.ts";

const NOW = 1_000_000_000;
const deps = (over: Partial<PurgeDeps> = {}): PurgeDeps => ({
  cancelConversion: async () => {},
  exporting: async () => false,
  now: () => NOW,
  ...over,
});
const setUsed = (db: LibTestDb, user: string, bytes: number) =>
  db.raw.prepare("UPDATE app_user SET used_bytes = ? WHERE id = ?").run(bytes, user);
const used = (db: LibTestDb, user = "u1") =>
  (db.raw.prepare("SELECT used_bytes AS n FROM app_user WHERE id = ?").get(user) as { n: number }).n;
const rows = (db: LibTestDb) => db.raw.prepare("SELECT id, status FROM library_file ORDER BY id").all();
const due = { trashedAt: NOW - 10, purgeAfter: NOW - 1 };
const keysFor = (user: string, id: string) => ({
  [`u/${user}/${id}/v1/orig`]: "x",
  [`u/${user}/${id}/v1/d/s/1/800.webp`]: "x",
  [`u/${user}/${id}/v1/n/notes.json`]: "x",
  [`u/${user}/${id}/stray`]: "x",
});

describe("LIB-08 erase: a due file's prefix is emptied by listing, in two passes", () => {
  it("removes the original, derived, notes and an unrecorded key, and nothing outside the prefix", async () => {
    const db = libWith();
    addFile(db, { id: "a", ...due });
    const r2 = fakeBucket({
      ...keysFor("u1", "a"),
      "u/u1/b/v1/orig": "keep",
      "h/hold1": "hold",
      "purged/u9": "t",
    });
    setUsed(db, "u1", 100);
    const first = await purgeDueFiles({ DB: db, LIBRARY: r2.bucket }, { budget: { rounds: 10 } }, deps());
    expect([...r2.objects.keys()].sort()).toEqual(["h/hold1", "purged/u9", "u/u1/b/v1/orig"]);
    expect(first).toMatchObject({ purged: 1, more: false, freed: ["u1"] });
    expect(used(db)).toBe(0);
    expect(rows(db)).toEqual([{ id: "a", status: "purged" }]);

    const second = await purgeDueFiles(
      { DB: db, LIBRARY: r2.bucket },
      { budget: { rounds: 10 } },
      deps({ now: () => NOW + LATE_WRITE_WINDOW_MS + 1 }),
    );
    expect(second.purged).toBe(1);
    expect(rows(db)).toEqual([]);
  });

  it("LIB-08 late-put: a put that lands after pass 1 is gone after pass 2", async () => {
    const db = libWith();
    addFile(db, { id: "a", ...due });
    const r2 = fakeBucket(keysFor("u1", "a"));
    await purgeDueFiles({ DB: db, LIBRARY: r2.bucket }, { budget: { rounds: 10 } }, deps());
    await r2.bucket.put("u/u1/a/v1/d/s/2/800.webp", "late");
    expect(r2.objects.size).toBe(1);
    const early = await purgeDueFiles(
      { DB: db, LIBRARY: r2.bucket },
      { budget: { rounds: 10 } },
      deps({ now: () => NOW + 1000 }),
    );
    expect(early.purged).toBe(0);
    expect(r2.objects.size).toBe(1);
    await purgeDueFiles(
      { DB: db, LIBRARY: r2.bucket },
      { budget: { rounds: 10 } },
      deps({ now: () => NOW + LATE_WRITE_WINDOW_MS + 1 }),
    );
    expect(r2.objects.size).toBe(0);
    expect(rows(db)).toEqual([]);
  });

  it("the claim comes first: a crash at any delete leaves the file purged and its bytes released once, and pass 2 finishes", async () => {
    for (let crashAt = 1; crashAt <= 3; crashAt++) {
      const db = libWith();
      addFile(db, { id: "a", ...due });
      setUsed(db, "u1", 100);
      const many = Object.fromEntries(
        Array.from({ length: 2500 }, (_, i) => [`u/u1/a/v1/d/p${String(i).padStart(4, "0")}`, "x"]),
      );
      const r2 = fakeBucket(many);
      let calls = 0;
      r2.beforeDelete = () => {
        if (++calls === crashAt) throw new Error("crash");
      };
      await expect(purgeDueFiles({ DB: db, LIBRARY: r2.bucket }, { budget: { rounds: 10 } }, deps())).rejects.toThrow(
        "crash",
      );
      expect(used(db)).toBe(0);
      expect(rows(db)).toEqual([{ id: "a", status: "purged" }]);
      r2.beforeDelete = () => {};
      await purgeDueFiles(
        { DB: db, LIBRARY: r2.bucket },
        { budget: { rounds: 10 } },
        deps({ now: () => NOW + LATE_WRITE_WINDOW_MS + 1 }),
      );
      expect(r2.objects.size).toBe(0);
      expect(rows(db)).toEqual([]);
      expect(used(db)).toBe(0);
    }
  });

  it("stops at its budget with more to do, and the next run finishes", async () => {
    const db = libWith();
    addFile(db, { id: "a", ...due });
    const many = Object.fromEntries(
      Array.from({ length: 2500 }, (_, i) => [`u/u1/a/v1/d/p${String(i).padStart(4, "0")}`, "x"]),
    );
    const r2 = fakeBucket(many);
    const one = await purgeDueFiles({ DB: db, LIBRARY: r2.bucket }, { budget: { rounds: 2 } }, deps());
    expect(one).toMatchObject({ more: true, purged: 1 });
    expect(r2.objects.size).toBe(500);
    expect(rows(db)).toEqual([{ id: "a", status: "purged" }]);
    const later = deps({ now: () => NOW + LATE_WRITE_WINDOW_MS + 1 });
    const two = await purgeDueFiles({ DB: db, LIBRARY: r2.bucket }, { budget: { rounds: 2 } }, later);
    expect(two.purged).toBe(1);
    expect(r2.objects.size).toBe(0);
  });

  it("cancels the conversion before touching the prefix", async () => {
    const db = libWith();
    addFile(db, { id: "a", ...due });
    const seen: string[] = [];
    const r2 = fakeBucket(keysFor("u1", "a"));
    r2.beforeDelete = () => seen.push(`delete after ${seen.join()}`);
    await purgeDueFiles(
      { DB: db, LIBRARY: r2.bucket },
      { budget: { rounds: 5 } },
      deps({ cancelConversion: async (id) => void seen.push(`cancel ${id}`) }),
    );
    expect(seen[0]).toBe("cancel a");
  });
});

describe("LIB-02 race: bytes are released once", () => {
  it("two concurrent purges of one file drop the bytes once", async () => {
    const db = libWith();
    addFile(db, { id: "a", bytes: 40, ...due });
    addFile(db, { id: "b", bytes: 60 });
    setUsed(db, "u1", 100);
    const r2 = fakeBucket(keysFor("u1", "a"));
    await Promise.all([
      purgeDueFiles({ DB: db, LIBRARY: r2.bucket }, { budget: { rounds: 5 } }, deps()),
      purgeDueFiles({ DB: db, LIBRARY: r2.bucket }, { budget: { rounds: 5 } }, deps()),
    ]);
    expect(used(db)).toBe(60);
  });

  it("releases nothing for a refused file, whose bytes went at refusal", async () => {
    const db = libWith();
    addFile(db, { id: "a", bytes: 40, status: "refused", ...due });
    setUsed(db, "u1", 100);
    await purgeDueFiles({ DB: db, LIBRARY: fakeBucket().bucket }, { budget: { rounds: 5 } }, deps());
    expect(used(db)).toBe(100);
  });

  it("never takes used bytes below zero", async () => {
    const db = libWith();
    addFile(db, { id: "a", bytes: 40, ...due });
    setUsed(db, "u1", 10);
    await purgeDueFiles({ DB: db, LIBRARY: fakeBucket().bucket }, { budget: { rounds: 5 } }, deps());
    expect(used(db)).toBe(0);
  });
});

describe("LIB-09 trash: who is purged and who waits", () => {
  it("purges due rows only, never one not yet due", async () => {
    const db = libWith();
    addFile(db, { id: "due", ...due });
    addFile(db, { id: "later", trashedAt: NOW, purgeAfter: NOW + 1000 });
    addFile(db, { id: "live" });
    await purgeDueFiles({ DB: db, LIBRARY: fakeBucket().bucket }, { budget: { rounds: 5 } }, deps());
    expect(await fileRow(db, "u1", "due")).toBeNull();
    expect((await fileRow(db, "u1", "later"))?.trashedAt).toBe(NOW);
    expect(await fileRow(db, "u1", "live")).not.toBeNull();
  });

  it("skips a suspended or purging owner and an owner with a live export", async () => {
    const db = libWith(["u1", "u2", "u3", "u4"]);
    for (const user of ["u1", "u2", "u3", "u4"]) addFile(db, { id: `f-${user}`, user, ...due });
    db.raw.prepare("UPDATE app_user SET suspended_at = 1 WHERE id = 'u2'").run();
    db.raw.prepare("UPDATE app_user SET status = 'purging' WHERE id = 'u3'").run();
    const r2 = fakeBucket(Object.assign({}, ...["u1", "u2", "u3", "u4"].map((u) => keysFor(u, `f-${u}`))));
    await purgeDueFiles(
      { DB: db, LIBRARY: r2.bucket },
      { budget: { rounds: 20 } },
      deps({ exporting: async (user) => user === "u4" }),
    );
    expect(rows(db)).toEqual([
      { id: "f-u1", status: "purged" },
      { id: "f-u2", status: "ready" },
      { id: "f-u3", status: "ready" },
      { id: "f-u4", status: "ready" },
    ]);
  });

  it("with a user id, purges that user's files only", async () => {
    const db = libWith(["u1", "u2"]);
    addFile(db, { id: "a", ...due });
    addFile(db, { id: "b", user: "u2", ...due });
    await purgeDueFiles({ DB: db, LIBRARY: fakeBucket().bucket }, { userId: "u2", budget: { rounds: 5 } }, deps());
    expect(rows(db)).toEqual([
      { id: "a", status: "ready" },
      { id: "b", status: "purged" },
    ]);
  });

  it("deletes the derived rows with the file", async () => {
    const db = libWith();
    addFile(db, { id: "a", ...due });
    db.raw
      .prepare(
        "INSERT INTO derived (file_id, version, owner_kind, status, created_at, updated_at) VALUES ('a', 1, 'library', 'done', 0, 0)",
      )
      .run();
    const r2 = fakeBucket();
    await purgeDueFiles({ DB: db, LIBRARY: r2.bucket }, { budget: { rounds: 5 } }, deps());
    await purgeDueFiles(
      { DB: db, LIBRARY: r2.bucket },
      { budget: { rounds: 5 } },
      deps({ now: () => NOW + LATE_WRITE_WINDOW_MS + 1 }),
    );
    expect(db.raw.prepare("SELECT count(*) AS n FROM derived").get()).toEqual({
      n: 0,
    });
  });
});

describe("LIB-09 trash: isolation between owners", () => {
  it("an owner with a live export never fills the window, so another owner's due file still goes", async () => {
    const db = libWith(["busy", "free"]);
    for (let i = 0; i < 60; i++)
      addFile(db, {
        id: `b${String(i).padStart(2, "0")}`,
        user: "busy",
        trashedAt: 1,
        purgeAfter: NOW - 100,
      });
    addFile(db, { id: "f1", user: "free", trashedAt: 1, purgeAfter: NOW - 1 });
    const r2 = fakeBucket({
      "u/busy/b00/v1/orig": "keep",
      "u/free/f1/v1/orig": "x",
    });
    const report = await purgeDueFiles(
      { DB: db, LIBRARY: r2.bucket },
      { budget: { rounds: 10 } },
      deps({ exporting: async (u) => u === "busy" }),
    );
    expect(report).toMatchObject({ purged: 1, more: false, freed: ["free"] });
    expect(r2.objects.has("u/busy/b00/v1/orig")).toBe(true);
    expect(
      db.raw.prepare("SELECT count(*) AS n FROM library_file WHERE user_id = 'busy' AND status != 'purged'").get(),
    ).toEqual({ n: 60 });
  });

  it("OSA-02: a file whose hold copy is not yet made keeps its bytes, and does not block the rest", async () => {
    const db = libWith();
    addFile(db, { id: "held", trashedAt: 1, purgeAfter: NOW - 100 });
    addFile(db, { id: "plain", trashedAt: 1, purgeAfter: NOW - 50 });
    db.raw
      .prepare(
        "INSERT INTO hold (id, file_id, owner_user_id, bucket, r2_key, created_at, release_after) VALUES ('hx', 'held', 'u1', 'library', 'h/hx', 1, ?)",
      )
      .run(NOW + 1000);
    const r2 = fakeBucket({
      "u/u1/held/v1/orig": "source",
      "u/u1/plain/v1/orig": "x",
    });
    const env = { DB: db, LIBRARY: r2.bucket };
    await purgeDueFiles(env, { budget: { rounds: 10 } }, deps());
    expect(r2.objects.has("u/u1/held/v1/orig")).toBe(true);
    expect(r2.objects.has("u/u1/plain/v1/orig")).toBe(false);
    await r2.bucket.put("h/hx", "copy");
    db.raw.prepare("UPDATE hold SET copied_at = 5 WHERE id = 'hx'").run();
    await purgeDueFiles(env, { budget: { rounds: 10 } }, deps());
    expect(r2.objects.has("u/u1/held/v1/orig")).toBe(false);
    expect(r2.objects.has("h/hx")).toBe(true);
  });

  it("a derived row of a guest file with the same id is not touched", async () => {
    const db = libWith();
    addFile(db, { id: "a", trashedAt: 1, purgeAfter: NOW - 1 });
    db.raw
      .prepare(
        "INSERT INTO derived (file_id, version, owner_kind, status, created_at, updated_at) VALUES ('a', 1, 'guest', 'done', 0, 0)",
      )
      .run();
    const r2 = fakeBucket();
    await purgeDueFiles({ DB: db, LIBRARY: r2.bucket }, { budget: { rounds: 5 } }, deps());
    await purgeDueFiles(
      { DB: db, LIBRARY: r2.bucket },
      { budget: { rounds: 5 } },
      deps({ now: () => NOW + LATE_WRITE_WINDOW_MS + 1 }),
    );
    expect(db.raw.prepare("SELECT count(*) AS n FROM derived").get()).toEqual({
      n: 1,
    });
  });
});
