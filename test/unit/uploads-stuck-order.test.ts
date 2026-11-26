import { describe, expect, it } from "vitest";
import { staleChecking } from "../../src/worker/uploads/quota.ts";
import { addUser, testDb } from "./d1-shim.ts";

describe("UP-12 unsettled: the stuck-check sweep takes the longest waiting file first", () => {
  it("UP-12 unsettled: files left checking come oldest created first, ties by id, and a limit keeps the oldest", async () => {
    const db = testDb();
    addUser(db, "u1");
    const insert = db.raw.prepare(
      `INSERT INTO library_file (id, user_id, name, ext, bytes, version, r2_key, status, created_at, updated_at)
       VALUES (?1, 'u1', 'a.pdf', 'pdf', 10, 1, ?2, 'checking', ?3, 1000)`,
    );
    for (const [id, created] of [
      ["c", 1],
      ["a", 3],
      ["b", 2],
      ["d", 2],
    ] as const)
      insert.run(id, `k/${id}`, created);
    const now = 10_000_000;
    expect((await staleChecking(db, now, 10)).map((f) => f.id)).toEqual(["c", "b", "d", "a"]);
    expect((await staleChecking(db, now, 2)).map((f) => f.id)).toEqual(["c", "b"]);
  });
});
