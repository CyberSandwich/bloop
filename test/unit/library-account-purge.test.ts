import { describe, expect, it } from "vitest";
import {
  type AccountPurgeDeps,
  dueUsers,
  purgeUser,
  resweepTombstones,
  sweepOrphans,
} from "../../src/worker/library/account-purge.ts";
import { LATE_WRITE_WINDOW_MS } from "../../src/worker/library/purge.ts";
import { addFile, type LibTestDb, libWith } from "./library-db.ts";
import { fakeBucket } from "./library-r2.ts";

const NOW = 1_000_000_000;
const calls: string[] = [];
const deps = (over: Partial<AccountPurgeDeps> = {}): AccountPurgeDeps => ({
  cancelConversion: async (id) => void calls.push(`cancel:${id}`),
  exporting: async () => false,
  now: () => NOW,
  endScreens: async (u) => void calls.push(`screens:${u}`),
  closeSessions: async (u, ids) => void calls.push(`close:${u}:${ids.join(",")}`),
  abortUploads: async () => false,
  eraseObject: async (u) => void calls.push(`erase:${u}`),
  ...over,
});
const dueUser = (db: LibTestDb, id = "u1", over = "") =>
  db.raw
    .prepare(`UPDATE app_user SET status = 'deleting', delete_after = ?, email_norm = ? ${over} WHERE id = ?`)
    .run(NOW - 1, `${id}@x.test`, id);
const userRow = (db: LibTestDb, id = "u1") => db.raw.prepare("SELECT status FROM app_user WHERE id = ?").get(id);
const budget = () => ({ rounds: 10 });

describe("LIB-08 account purge", () => {
  it("erases every key under the prefix, the rows and the user, and leaves holds and other users", async () => {
    calls.length = 0;
    const db = libWith(["u1", "u2"]);
    dueUser(db);
    addFile(db, { id: "a" });
    db.raw
      .prepare(
        "INSERT INTO phone_session (id_hash, user_id, created_at, last_seen_at, expires_at, public_id) VALUES ('h', 'u1', 1, 1, 9, 'pub1')",
      )
      .run();
    db.raw
      .prepare(
        "INSERT INTO invite (id, token_hash, email_norm, email, created_at, expires_at) VALUES ('i', 't', 'u1@x.test', 'u1@x.test', 1, 2)",
      )
      .run();
    db.raw
      .prepare("INSERT INTO waitlist (id, email_norm, email, created_at) VALUES ('w', 'u1@x.test', 'u1@x.test', 1)")
      .run();
    const r2 = fakeBucket({
      "u/u1/a/v1/orig": "x",
      "u/u1/stray": "x",
      "u/u2/b/v1/orig": "keep",
      "h/hold1": "hold",
    });

    expect(await purgeUser({ DB: db, LIBRARY: r2.bucket }, "u1", budget(), deps())).toBe("purged");
    expect([...r2.objects.keys()].sort()).toEqual(["h/hold1", "purged/u1", "u/u2/b/v1/orig"]);
    expect(userRow(db)).toBeUndefined();
    expect(db.raw.prepare("SELECT count(*) AS n FROM invite").get()).toEqual({
      n: 0,
    });
    expect(db.raw.prepare("SELECT count(*) AS n FROM waitlist").get()).toEqual({
      n: 0,
    });
    expect(db.raw.prepare("SELECT count(*) AS n FROM phone_session").get()).toEqual({ n: 0 });
    expect(userRow(db, "u2")).toEqual({ status: "active" });
    expect(calls).toEqual(["screens:u1", "close:u1:pub1", "erase:u1"]);
    const stone = JSON.parse(new TextDecoder().decode(r2.objects.get("purged/u1")));
    expect(stone).toEqual({
      purgedAt: NOW,
      resweepAfter: NOW + LATE_WRITE_WINDOW_MS,
    });
  });

  it("refuses a user who is not due, suspended, or under a live hold", async () => {
    const r2 = fakeBucket({ "u/u1/a/v1/orig": "x" });
    for (const [label, sql] of [
      ["not due", "UPDATE app_user SET delete_after = delete_after + 5 WHERE id = 'u1'"],
      ["suspended", "UPDATE app_user SET suspended_at = 5 WHERE id = 'u1'"],
      [
        "held",
        "INSERT INTO hold (id, file_id, owner_user_id, bucket, r2_key, created_at, release_after) VALUES ('h', 'f', 'u1', 'library', 'h/h', 1, 9999999999)",
      ],
    ] as const) {
      const db = libWith();
      dueUser(db);
      db.raw.exec(sql);
      expect(await purgeUser({ DB: db, LIBRARY: r2.bucket }, "u1", budget(), deps()), label).toBe("skipped");
      expect(r2.objects.size, label).toBe(1);
      expect(userRow(db), label).not.toEqual({ status: "purging" });
    }
  });

  it("OSA-02: a hold already released no longer blocks the purge", async () => {
    const db = libWith();
    dueUser(db);
    db.raw
      .prepare(
        "INSERT INTO hold (id, file_id, owner_user_id, bucket, r2_key, created_at, release_after) VALUES ('h', 'f', 'u1', 'library', 'h/h', 1, ?)",
      )
      .run(NOW - 1);
    const r2 = fakeBucket({ "h/h": "copy" });
    expect(await purgeUser({ DB: db, LIBRARY: r2.bucket }, "u1", budget(), deps())).toBe("purged");
    expect(r2.objects.has("h/h")).toBe(true);
  });

  it("stops while an upload settles, and a later run finishes from the purging row", async () => {
    const db = libWith();
    dueUser(db);
    const r2 = fakeBucket({ "u/u1/a/v1/orig": "x" });
    let settling = true;
    const d = deps({ abortUploads: async () => settling });
    expect(await purgeUser({ DB: db, LIBRARY: r2.bucket }, "u1", budget(), d)).toBe("more");
    expect(userRow(db)).toEqual({ status: "purging" });
    expect(r2.objects.size).toBe(1);
    expect(await dueUsers({ DB: db }, NOW, 5)).toEqual(["u1"]);
    settling = false;
    expect(await purgeUser({ DB: db, LIBRARY: r2.bucket }, "u1", budget(), d)).toBe("purged");
  });

  it("returns more when the budget runs out and resumes without losing a key", async () => {
    const db = libWith();
    dueUser(db);
    const many = Object.fromEntries(
      Array.from({ length: 2500 }, (_, i) => [`u/u1/a/v1/d/p${String(i).padStart(4, "0")}`, "x"]),
    );
    const r2 = fakeBucket(many);
    expect(await purgeUser({ DB: db, LIBRARY: r2.bucket }, "u1", { rounds: 1 }, deps())).toBe("more");
    expect(userRow(db)).toEqual({ status: "purging" });
    expect(await purgeUser({ DB: db, LIBRARY: r2.bucket }, "u1", budget(), deps())).toBe("purged");
    expect([...r2.objects.keys()]).toEqual(["purged/u1"]);
  });

  it("resumes after a crash at the object erase: the row is still purging, nothing is deleted twice", async () => {
    const db = libWith();
    dueUser(db);
    const r2 = fakeBucket({ "u/u1/a/v1/orig": "x" });
    await expect(
      purgeUser(
        { DB: db, LIBRARY: r2.bucket },
        "u1",
        budget(),
        deps({
          eraseObject: async () => {
            throw new Error("crash");
          },
        }),
      ),
    ).rejects.toThrow("crash");
    expect(userRow(db)).toEqual({ status: "purging" });
    expect(await purgeUser({ DB: db, LIBRARY: r2.bucket }, "u1", budget(), deps())).toBe("purged");
    expect(userRow(db)).toBeUndefined();
  });

  it("cancels the conversion of a file still queued or running before its prefix goes", async () => {
    calls.length = 0;
    const db = libWith();
    dueUser(db);
    addFile(db, { id: "a" });
    addFile(db, { id: "b" });
    const states: [string, string][] = [
      ["a", "running"],
      ["b", "done"],
    ];
    for (const [id, status] of states) {
      db.raw
        .prepare(
          "INSERT INTO derived (file_id, version, owner_kind, status, created_at, updated_at) VALUES (?, 1, 'library', ?, 1, 1)",
        )
        .run(id, status);
    }
    await purgeUser({ DB: db, LIBRARY: fakeBucket().bucket }, "u1", budget(), deps());
    expect(calls.filter((c) => c.startsWith("cancel"))).toEqual(["cancel:a"]);
    expect(db.raw.prepare("SELECT count(*) AS n FROM derived").get()).toEqual({
      n: 0,
    });
  });
});

describe("dueUsers", () => {
  it("lists purging rows first, then due ones; skips suspended and not-yet-due", async () => {
    const db = libWith(["a", "b", "c", "d"]);
    db.raw.prepare("UPDATE app_user SET delete_after = ?, status = 'active' WHERE id = 'a'").run(NOW - 5);
    db.raw.prepare("UPDATE app_user SET status = 'purging' WHERE id = 'b'").run();
    db.raw.prepare("UPDATE app_user SET delete_after = ?, suspended_at = 1 WHERE id = 'c'").run(NOW - 5);
    db.raw.prepare("UPDATE app_user SET delete_after = ? WHERE id = 'd'").run(NOW + 5);
    expect(await dueUsers({ DB: db }, NOW, 10)).toEqual(["b", "a"]);
    expect(await dueUsers({ DB: db }, NOW, 1)).toEqual(["b"]);
  });
});

describe("LIB-08 late-put: tombstone resweep", () => {
  it("deletes a put that landed after the purge, once, and only past the resweep time", async () => {
    const r2 = fakeBucket({
      "purged/u1": JSON.stringify({ purgedAt: NOW, resweepAfter: NOW + 100 }),
      "u/u1/late/v1/orig": "late",
      "u/u2/keep/v1/orig": "keep",
    });
    expect(await resweepTombstones({ LIBRARY: r2.bucket }, budget(), NOW + 50)).toEqual({ swept: 0, more: false });
    expect(r2.objects.has("u/u1/late/v1/orig")).toBe(true);
    expect(await resweepTombstones({ LIBRARY: r2.bucket }, budget(), NOW + 100)).toEqual({ swept: 1, more: false });
    expect([...r2.objects.keys()].sort()).toEqual(["purged/u1", "u/u2/keep/v1/orig"]);
    await r2.bucket.put("u/u1/later/v1/orig", "x");
    expect((await resweepTombstones({ LIBRARY: r2.bucket }, budget(), NOW + 200)).swept).toBe(0);
    expect(r2.objects.has("u/u1/later/v1/orig")).toBe(true);
  });

  it("leaves a tombstone unswept when the budget runs out, so the next run continues", async () => {
    const many = Object.fromEntries(
      Array.from({ length: 2500 }, (_, i) => [`u/u1/a/p${String(i).padStart(4, "0")}`, "x"]),
    );
    const r2 = fakeBucket({
      "purged/u1": JSON.stringify({ purgedAt: 1, resweepAfter: 2 }),
      ...many,
    });
    expect(await resweepTombstones({ LIBRARY: r2.bucket }, { rounds: 1 }, 10)).toMatchObject({ swept: 0, more: true });
    expect(await resweepTombstones({ LIBRARY: r2.bucket }, budget(), 10)).toMatchObject({ swept: 1 });
    expect(JSON.parse(new TextDecoder().decode(r2.objects.get("purged/u1")))).toMatchObject({ sweptAt: 10 });
  });
});

describe("LIB-08 orphan: prefixes whose owner row is gone", () => {
  it("empties an unowned prefix and leaves a live user's", async () => {
    const db = libWith(["u1"]);
    const r2 = fakeBucket({
      "u/u1/a/v1/orig": "keep",
      "u/gone/a/v1/orig": "x",
      "u/gone/stray": "x",
      "h/hold": "h",
    });
    expect(await sweepOrphans({ DB: db, LIBRARY: r2.bucket }, budget())).toEqual({ orphans: 1, more: false });
    expect([...r2.objects.keys()].sort()).toEqual(["h/hold", "u/u1/a/v1/orig"]);
  });
});
