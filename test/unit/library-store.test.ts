import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IDLE_DAYS } from "../../src/worker/auth/sessions.ts";
import {
  CURSOR_MAX_CHARS,
  fileRow,
  listFiles,
  makeDue,
  markPresented,
  PAGE_SIZE,
  RESTORE_MARGIN_MS,
  rename,
  restore,
  servable,
  servableRecent,
  setSelected,
  setUpNext,
  trash,
  UP_NEXT_MAX,
  upNext,
} from "../../src/worker/library/store.ts";
import { addFile, libWith } from "./library-db.ts";

const NOW = 1_000_000_000;
const DAY = 86_400_000;

const ids = (n: number, prefix = "f") => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, "0")}`);

describe("LIB-01 idor sql: every library_file statement binds the owner", () => {
  const dir = fileURLToPath(new URL("../../src/worker/library/", import.meta.url));
  const sources = readdirSync(dir)
    // hold.ts is the one admin-side reader: a report names file ids across owners, so it selects by id alone.
    .filter((f) => f.endsWith(".ts") && f !== "hold.ts")
    .map((f) => readFileSync(dir + f, "utf8"));
  const literals = sources.flatMap((s) => s.match(/`[^`]*library_file[^`]*`|"[^"\n]*library_file[^"\n]*"/g) ?? []);
  /** Constants that carry the owner's bind (user_id = ?1), which a statement may interpolate instead of naming it. */
  const OWNER_BOUND = ["OWNED", "SELECTED_SQL", "SELECTED_COUNT", "due", "SERVABLE_SQL"];
  // `user_id = ?n` is the owner bound to a parameter; a column named in a select list or a join does not count.
  const holdsOwner = (l: string) => /\buser_id = \?\d/.test(l) || OWNER_BOUND.some((c) => l.includes(`\${${c}}`));

  it("finds the statements it guards", () => {
    expect(literals.length).toBeGreaterThan(8);
  });
  it("names user_id, or an owner-bound constant, in each one", () => {
    expect(literals.filter((l) => !holdsOwner(l))).toEqual([]);
  });
  it("binds the owner in each of those constants", () => {
    const text = sources.join("\n");
    for (const name of OWNER_BOUND.filter((n) => n !== "SELECTED_COUNT")) {
      const def = new RegExp(`(?:const|export const) ${name} =[^;]*`).exec(text)?.[0] ?? "";
      expect([name, def.includes("user_id")]).toEqual([name, true]);
    }
  });
  it("gives another user's id the answer an unknown id gets, on every verb", async () => {
    const db = libWith(["u1", "u2"]);
    addFile(db, { id: "a" });
    addFile(db, { id: "t", trashedAt: NOW, purgeAfter: NOW + DAY });
    const foreign = [
      await fileRow(db, "u2", "a"),
      await fileRow(db, "u2", "nope"),
      await rename(db, "u2", "a", "x"),
      await rename(db, "u2", "nope", "x"),
      await setSelected(db, "u2", "a", true),
      await setSelected(db, "u2", "nope", true),
      await trash(db, "u2", "a", NOW, 30),
      await trash(db, "u2", "nope", NOW, 30),
      await restore(db, "u2", "t", NOW),
      await restore(db, "u2", "nope", NOW),
    ];
    expect(foreign).toEqual([
      null,
      null,
      "not_found",
      "not_found",
      "not_found",
      "not_found",
      "not_found",
      "not_found",
      "not_found",
      "not_found",
    ]);
    expect(await makeDue(db, "u2", ["t"], NOW)).toBe(0);
    expect(await upNext(db, "u2")).toEqual([]);
    const page = await listFiles(db, "u2", "files", "updated", null);
    expect(page).toEqual({ ok: true, files: [], next: null });
    expect((await fileRow(db, "u1", "a"))?.name).toBe("a.pptx");
  });
});

describe("LIB-02 race: Up Next is capped and absolute", () => {
  it("leaves 12 after 20 concurrent ticks", async () => {
    const db = libWith();
    for (const id of ids(20)) addFile(db, { id });
    const answers = await Promise.all(ids(20).map((id) => setSelected(db, "u1", id, true)));
    expect(answers.filter((a) => a === "ok")).toHaveLength(UP_NEXT_MAX);
    expect(answers.filter((a) => a === "up_next_full")).toHaveLength(8);
    expect(await upNext(db, "u1")).toHaveLength(UP_NEXT_MAX);
  });

  it("lands the same state when a request is doubled", async () => {
    const db = libWith();
    addFile(db, { id: "a" });
    expect(await Promise.all([setSelected(db, "u1", "a", true), setSelected(db, "u1", "a", true)])).toEqual([
      "ok",
      "ok",
    ]);
    expect(await upNext(db, "u1")).toEqual(["a"]);
    expect(await Promise.all([setSelected(db, "u1", "a", false), setSelected(db, "u1", "a", false)])).toEqual([
      "ok",
      "ok",
    ]);
    expect(await upNext(db, "u1")).toEqual([]);
    const name = await Promise.all([rename(db, "u1", "a", "Same"), rename(db, "u1", "a", "Same")]);
    expect(name).toEqual(["ok", "ok"]);
    expect((await fileRow(db, "u1", "a"))?.name).toBe("Same.pptx");
  });

  it("refuses a tick on a file that is not ready or is disabled", async () => {
    const db = libWith();
    addFile(db, { id: "c", status: "checking" });
    addFile(db, { id: "d", disabledAt: 5 });
    expect(await setSelected(db, "u1", "c", true)).toBe("not_found");
    expect(await setSelected(db, "u1", "d", true)).toBe("not_found");
  });

  it("orders Up Next by tick time", async () => {
    const db = libWith();
    for (const id of ["a", "b", "c"]) addFile(db, { id });
    for (const [i, id] of ["c", "a", "b"].entries()) {
      db.raw.prepare("UPDATE library_file SET selected_at = ? WHERE id = ?").run(10 + i, id);
    }
    expect(await upNext(db, "u1")).toEqual(["c", "a", "b"]);
  });
});

describe("setUpNext", () => {
  it("reorders, clears the rest and answers the order that resulted", async () => {
    const db = libWith();
    for (const id of ["a", "b", "c", "d"]) addFile(db, { id });
    await setSelected(db, "u1", "a", true);
    await setSelected(db, "u1", "b", true);
    expect(await setUpNext(db, "u1", ["c", "b", "d"], NOW)).toEqual(["c", "b", "d"]);
    expect(await setUpNext(db, "u1", [], NOW)).toEqual([]);
  });

  it("ignores another user's id and an unready one, and caps at 12", async () => {
    const db = libWith(["u1", "u2"]);
    addFile(db, { id: "mine" });
    addFile(db, { id: "theirs", user: "u2" });
    addFile(db, { id: "busy", status: "checking" });
    expect(await setUpNext(db, "u1", ["theirs", "busy", "mine"], NOW)).toEqual(["mine"]);
    expect(await upNext(db, "u2")).toEqual([]);
    for (const id of ids(14)) addFile(db, { id });
    expect(await setUpNext(db, "u1", ids(14), NOW)).toHaveLength(UP_NEXT_MAX);
  });

  it("leaves a trashed file's tick alone", async () => {
    const db = libWith();
    addFile(db, {
      id: "a",
      selectedAt: 5,
      trashedAt: NOW,
      purgeAfter: NOW + DAY,
    });
    await setUpNext(db, "u1", [], NOW);
    expect(db.raw.prepare("SELECT selected_at FROM library_file WHERE id = 'a'").get()).toEqual({ selected_at: 5 });
  });
});

describe("trash and restore", () => {
  it("trash keeps the tick, hides the row from Up Next and sets the due time", async () => {
    const db = libWith();
    addFile(db, { id: "a" });
    await setSelected(db, "u1", "a", true);
    expect(await trash(db, "u1", "a", NOW, 30)).toBe("ok");
    expect(await upNext(db, "u1")).toEqual([]);
    const row = await fileRow(db, "u1", "a");
    expect([row?.trashedAt, row?.purgeAfter, row?.selected]).toEqual([NOW, NOW + 30 * DAY, false]);
    expect(await trash(db, "u1", "a", NOW + 1, 30)).toBe("not_found");
  });

  it("restore puts the file back in its Up Next place", async () => {
    const db = libWith();
    addFile(db, { id: "a" });
    addFile(db, { id: "b" });
    await setSelected(db, "u1", "a", true);
    await setSelected(db, "u1", "b", true);
    await trash(db, "u1", "a", NOW, 30);
    expect(await restore(db, "u1", "a", NOW)).toBe("ok");
    expect(await upNext(db, "u1")).toEqual(["a", "b"]);
  });

  it("restore drops the tick when Up Next would reach 13", async () => {
    const db = libWith();
    addFile(db, {
      id: "x",
      selectedAt: 1,
      trashedAt: NOW,
      purgeAfter: NOW + DAY,
    });
    for (const [i, id] of ids(12).entries()) addFile(db, { id, selectedAt: 10 + i });
    expect(await restore(db, "u1", "x", NOW)).toBe("ok");
    expect((await upNext(db, "u1")).length).toBe(12);
    expect((await fileRow(db, "u1", "x"))?.selected).toBe(false);
  });

  it("closes the restore margin before due, and Delete Now closes it at once", async () => {
    const db = libWith();
    addFile(db, {
      id: "a",
      trashedAt: NOW,
      purgeAfter: NOW + RESTORE_MARGIN_MS,
    });
    addFile(db, {
      id: "b",
      trashedAt: NOW,
      purgeAfter: NOW + RESTORE_MARGIN_MS + 1,
    });
    addFile(db, { id: "c", trashedAt: NOW, purgeAfter: NOW + DAY });
    expect(await restore(db, "u1", "a", NOW)).toBe("not_found");
    expect(await restore(db, "u1", "b", NOW)).toBe("ok");
    expect(await makeDue(db, "u1", ["c"], NOW)).toBe(1);
    expect(await restore(db, "u1", "c", NOW)).toBe("not_found");
    expect((await fileRow(db, "u1", "c"))?.purgeAfter).toBe(NOW - 1);
  });

  it("empties the trash only for trashed rows of this owner", async () => {
    const db = libWith(["u1", "u2"]);
    addFile(db, { id: "a", trashedAt: NOW, purgeAfter: NOW + DAY });
    addFile(db, { id: "b", trashedAt: NOW, purgeAfter: NOW + DAY });
    addFile(db, { id: "live" });
    addFile(db, {
      id: "other",
      user: "u2",
      trashedAt: NOW,
      purgeAfter: NOW + DAY,
    });
    expect(await makeDue(db, "u1", "all", NOW)).toBe(2);
    expect(await makeDue(db, "u1", "all", NOW)).toBe(0);
    const many = ids(150, "m");
    for (const id of many) addFile(db, { id, trashedAt: NOW, purgeAfter: NOW + DAY });
    // The route accepts 150 ids; D1 binds at most 100 values a statement, which the test database now enforces.
    expect(await makeDue(db, "u1", many, NOW)).toBe(150);
    expect((await fileRow(db, "u1", "live"))?.purgeAfter).toBeNull();
    expect((await fileRow(db, "u2", "other"))?.purgeAfter).toBe(NOW + DAY);
  });
});

describe("LIB-12 race: rename, trash, restore and a due purge never leave a ghost", () => {
  const ops = {
    rename: (db: ReturnType<typeof libWith>) => rename(db, "u1", "a", "Renamed"),
    trash: (db: ReturnType<typeof libWith>) => trash(db, "u1", "a", NOW, 30),
    restore: (db: ReturnType<typeof libWith>) => restore(db, "u1", "a", NOW),
    due: (db: ReturnType<typeof libWith>) => makeDue(db, "u1", ["a"], NOW),
    purge: async (db: ReturnType<typeof libWith>) => {
      db.raw.prepare("DELETE FROM library_file WHERE id = 'a' AND purge_after <= ?").run(NOW);
    },
  };
  const orders = (list: string[]): string[][] =>
    list.length < 2 ? [list] : list.flatMap((x, i) => orders(list.filter((_, j) => j !== i)).map((o) => [x, ...o]));

  it("ends with at most the one row and a consistent state in every order, sequential or concurrent", async () => {
    for (const order of orders(Object.keys(ops))) {
      for (const concurrent of [false, true]) {
        const db = libWith();
        addFile(db, { id: "a" });
        const run = order.map((k) => () => ops[k as keyof typeof ops](db));
        if (concurrent) await Promise.all(run.map((f) => f()));
        else for (const f of run) await f();
        const rows = db.raw.prepare("SELECT * FROM library_file").all() as {
          name: string;
          trashed_at: number | null;
          purge_after: number | null;
        }[];
        expect(rows.length).toBeLessThanOrEqual(1);
        for (const r of rows) {
          expect(["a.pptx", "Renamed.pptx"]).toContain(r.name);
          expect(r.trashed_at === null).toBe(r.purge_after === null);
        }
      }
    }
    // 48 databases, each built from every migration: the default 5 s is too tight as the migration list grows.
  }, 30_000);
});

describe("LIB-03 fetch-time: servable is one predicate", () => {
  const refs = [{ id: "a", version: 1 }];
  it("serves a ready, untrashed, enabled file of an active owner", async () => {
    const db = libWith();
    addFile(db, { id: "a" });
    expect([...(await servable(db, "u1", refs, null)).keys()]).toEqual(["a"]);
  });

  it("refuses alike after trash, disable, suspend, a deletion request, a purge claim, another version and another owner", async () => {
    const cases: [string, (db: ReturnType<typeof libWith>) => void][] = [
      ["trash", (db) => db.raw.prepare("UPDATE library_file SET trashed_at = 1, purge_after = 2").run()],
      ["disable", (db) => db.raw.prepare("UPDATE library_file SET disabled_at = 1").run()],
      ["checking", (db) => db.raw.prepare("UPDATE library_file SET status = 'checking'").run()],
      ["purged", (db) => db.raw.prepare("UPDATE library_file SET status = 'purged'").run()],
      ["suspend", (db) => db.raw.prepare("UPDATE app_user SET suspended_at = 1").run()],
      ["deleting", (db) => db.raw.prepare("UPDATE app_user SET status = 'deleting'").run()],
      ["purging", (db) => db.raw.prepare("UPDATE app_user SET status = 'purging'").run()],
      ["version", (db) => db.raw.prepare("UPDATE library_file SET version = 2").run()],
    ];
    for (const [name, apply] of cases) {
      const db = libWith();
      addFile(db, { id: "a" });
      apply(db);
      expect([name, (await servable(db, "u1", refs, null)).size]).toEqual([name, 0]);
    }
    const db = libWith(["u1", "u2"]);
    addFile(db, { id: "a" });
    expect((await servable(db, "u2", refs, null)).size).toBe(0);
  });

  it("LIB-03 pinned: sign-out of the pinned session refuses every fetch", async () => {
    const db = libWith();
    addFile(db, { id: "a" });
    db.raw
      .prepare(
        "INSERT INTO phone_session (id_hash, user_id, created_at, last_seen_at, expires_at, public_id) VALUES ('h', 'u1', 0, 0, ?, 'pub1')",
      )
      .run(NOW + DAY);
    const live = { publicId: "pub1", now: NOW };
    expect((await servable(db, "u1", refs, live)).size).toBe(1);
    expect((await servable(db, "u1", refs, { publicId: "other", now: NOW })).size).toBe(0);
    expect((await servable(db, "u1", refs, { publicId: "pub1", now: NOW + 2 * DAY })).size).toBe(0);
    db.raw.prepare("DELETE FROM phone_session").run();
    expect((await servable(db, "u1", refs, live)).size).toBe(0);
    expect((await servable(db, "u1", refs, null)).size).toBe(1);
  });

  it("LIB-03 pinned: a session idle for the idle limit refuses, though it has not expired", async () => {
    const db = libWith();
    addFile(db, { id: "a" });
    const day = 86_400_000;
    db.raw
      .prepare(
        "INSERT INTO phone_session (id_hash, user_id, created_at, last_seen_at, expires_at, public_id) VALUES ('h', 'u1', 0, 0, ?, 'pub1')",
      )
      .run(100 * day);
    expect((await servable(db, "u1", refs, { publicId: "pub1", now: IDLE_DAYS * day - 1 })).size).toBe(1);
    expect((await servable(db, "u1", refs, { publicId: "pub1", now: IDLE_DAYS * day })).size).toBe(0);
  });

  it("answers more than 90 refs in several queries", async () => {
    const db = libWith();
    const many = ids(130);
    for (const id of many) addFile(db, { id });
    expect(
      (
        await servable(
          db,
          "u1",
          many.map((id) => ({ id, version: 1 })),
          null,
        )
      ).size,
    ).toBe(130);
  });

  it("lists Up Next first, then the newest, only what is servable", async () => {
    const db = libWith();
    addFile(db, { id: "old", updatedAt: 1 });
    addFile(db, { id: "new", updatedAt: 9 });
    addFile(db, { id: "pick", updatedAt: 2, selectedAt: 7 });
    addFile(db, { id: "gone", updatedAt: 99, trashedAt: 1, purgeAfter: 2 });
    expect((await servableRecent(db, "u1", null, 50)).map((f) => f.id)).toEqual(["pick", "new", "old"]);
    expect(await servableRecent(db, "u1", null, 2)).toHaveLength(2);
  });
});

describe("listFiles", () => {
  it("sorts names naturally: Lecture 2 before Lecture 10", async () => {
    const db = libWith();
    for (const [id, name] of [
      ["a", "Lecture 10.pptx"],
      ["b", "lecture 2.pptx"],
      ["c", "Zeta.pdf"],
      ["d", "alpha.pdf"],
    ] as const) {
      addFile(db, { id, name });
    }
    const page = await listFiles(db, "u1", "files", "name", null);
    expect(page.ok && page.files.map((f) => f.name)).toEqual([
      "alpha.pdf",
      "lecture 2.pptx",
      "Lecture 10.pptx",
      "Zeta.pdf",
    ]);
  });

  it("sorts by size largest first and by update newest first", async () => {
    const db = libWith();
    addFile(db, { id: "a", bytes: 5, updatedAt: 30 });
    addFile(db, { id: "b", bytes: 50, updatedAt: 10 });
    addFile(db, { id: "c", bytes: 20, updatedAt: 20 });
    const by = async (sort: "size" | "updated") => {
      const p = await listFiles(db, "u1", "files", sort, null);
      return p.ok ? p.files.map((f) => f.id) : [];
    };
    expect(await by("size")).toEqual(["b", "c", "a"]);
    expect(await by("updated")).toEqual(["a", "c", "b"]);
  });

  it("pages by keyset and survives the cursor's row being deleted", async () => {
    const db = libWith();
    for (const [i, id] of ids(PAGE_SIZE + 30).entries()) addFile(db, { id, updatedAt: 1000 - i });
    const first = await listFiles(db, "u1", "files", "updated", null);
    if (!first.ok) throw new Error("page");
    expect(first.files).toHaveLength(PAGE_SIZE);
    expect(first.next).not.toBeNull();
    const last = first.files.at(-1)?.id ?? "";
    db.raw.prepare("DELETE FROM library_file WHERE id = ?").run(last);
    const second = await listFiles(db, "u1", "files", "updated", first.next);
    expect(second.ok && second.files).toHaveLength(30);
    expect(second.ok && second.next).toBeNull();
    expect(await listFiles(db, "u1", "files", "updated", "not a cursor")).toEqual({ ok: false });
  });

  it("B1 cursor: a name that is not Latin-1 pages under every sort, and its cursor fits the route's cap", async () => {
    const names = ["講義", "😀 deck", `${"講".repeat(190)}\ud800x`, '"'.repeat(200)];
    for (const sort of ["updated", "name", "size"] as const) {
      const db = libWith();
      for (const [i, id] of ids(PAGE_SIZE + 1).entries()) {
        const name = names[i % names.length] as string;
        addFile(db, {
          id,
          name: i === PAGE_SIZE - 1 ? `${"講".repeat(200)}` : name,
          updatedAt: 5000 - i,
          bytes: 1000 - i,
        });
      }
      const first = await listFiles(db, "u1", "files", sort, null);
      if (!first.ok) throw new Error("page");
      expect(first.next).not.toBeNull();
      expect((first.next as string).length).toBeLessThanOrEqual(CURSOR_MAX_CHARS);
      const second = await listFiles(db, "u1", "files", sort, first.next);
      expect(second.ok && second.files.length).toBeGreaterThanOrEqual(1);
      const seen = new Set([...first.files, ...(second.ok ? second.files : [])].map((f) => f.id));
      expect(seen.size).toBe(PAGE_SIZE + 1);
    }
  });

  it("B1 cursor: a cursor of another sort or view is refused, as is one that is not UTF-8 JSON", async () => {
    const db = libWith();
    for (const [i, id] of ids(PAGE_SIZE + 1).entries()) addFile(db, { id, name: `n${i}`, updatedAt: 5000 - i });
    const byName = await listFiles(db, "u1", "files", "name", null);
    if (!byName.ok) throw new Error("page");
    expect(await listFiles(db, "u1", "files", "size", byName.next)).toEqual({ ok: false });
    expect(await listFiles(db, "u1", "files", "name", "_w")).toEqual({ ok: false });
  });

  it("B1 cursor: integer-keyed cursors do not cross sorts or views", async () => {
    const live = libWith();
    const trashed = libWith();
    for (const [i, id] of ids(PAGE_SIZE + 1).entries()) {
      addFile(live, { id, updatedAt: 5000 - i, bytes: 900 - i });
      addFile(trashed, { id, updatedAt: 5000 - i, trashedAt: 1, purgeAfter: 5000 - i });
    }
    const byUpdated = await listFiles(live, "u1", "files", "updated", null);
    const inTrash = await listFiles(trashed, "u1", "trash", "updated", null);
    if (!byUpdated.ok || !inTrash.ok) throw new Error("page");
    expect(await listFiles(live, "u1", "files", "size", byUpdated.next)).toEqual({ ok: false });
    expect(await listFiles(trashed, "u1", "files", "updated", inTrash.next)).toEqual({ ok: false });
  });

  it("B1 cursor: the largest cursor, a 200-emoji name and a 64-character id, fits CURSOR_MAX_CHARS", async () => {
    const db = libWith();
    for (let i = 0; i <= PAGE_SIZE; i++)
      addFile(db, { id: `${String(i).padStart(3, "0")}`.padEnd(64, "x"), name: "😀".repeat(200) });
    const page = await listFiles(db, "u1", "files", "name", null);
    if (!page.ok) throw new Error("page");
    expect(page.files.at(-1)?.id).toHaveLength(64);
    const length = (page.next as string).length;
    expect(length).toBeLessThanOrEqual(CURSOR_MAX_CHARS);
    expect(length).toBeGreaterThan(CURSOR_MAX_CHARS - 20);
  });

  it("shows the trash by due time, soonest first, and files only in the files view", async () => {
    const db = libWith();
    addFile(db, { id: "live" });
    addFile(db, { id: "late", trashedAt: 1, purgeAfter: 900 });
    addFile(db, { id: "soon", trashedAt: 1, purgeAfter: 100 });
    addFile(db, { id: "gone", status: "purged", trashedAt: 1, purgeAfter: 50 });
    const t = await listFiles(db, "u1", "trash", "updated", null);
    const f = await listFiles(db, "u1", "files", "updated", null);
    expect(t.ok && t.files.map((x) => x.id)).toEqual(["soon", "late"]);
    expect(f.ok && f.files.map((x) => x.id)).toEqual(["live"]);
  });

  it("reports the derived state from the matching version only", async () => {
    const db = libWith();
    addFile(db, { id: "a", version: 2 });
    const derived = db.raw.prepare(
      "INSERT INTO derived (file_id, version, owner_kind, status, stage, pages, fonts_missing, created_at, updated_at) VALUES ('a', ?, 'library', ?, 'render', ?, ?, 0, 0)",
    );
    derived.run(1, "failed", 1, null);
    derived.run(2, "running", 40, '["Calibri","x"]');
    const row = await fileRow(db, "u1", "a");
    expect(row?.derived).toEqual({
      state: "preparing",
      stage: "render",
      pages: 40,
      fontsMissing: ["Calibri", "x"],
    });
    db.raw.prepare("UPDATE derived SET fonts_missing = 'not json'").run();
    expect((await fileRow(db, "u1", "a"))?.derived.fontsMissing).toEqual([]);
  });
});

describe("LIB-06 names: rename", () => {
  const table: [string, string, string | null][] = [
    ["Lecture 5", "pptx", "Lecture 5.pptx"],
    ["  padded  ", "pdf", "padded.pdf"],
    ["Café", "pdf", "Café.pdf"],
    ["a.b", "pdf", "a.b.pdf"],
    ["", "pdf", null],
    ["   ", "pdf", null],
    ["a/b", "pdf", null],
    ["a\\b", "pdf", null],
    ["tab\there", "pdf", null],
    ["nul\u0000", "pdf", null],
    ["c1\u0085", "pdf", null],
    [`li${String.fromCharCode(0x2028)}ne`, "pdf", null],
    [`pa${String.fromCharCode(0x2029)}ra`, "pdf", null],
    ["bidi" + String.fromCharCode(0x202e), "pdf", null],
    ["iso" + String.fromCharCode(0x2066), "pdf", null],
    ["lrm" + String.fromCharCode(0x200e), "pdf", null],
    ["rlm" + String.fromCharCode(0x200f), "pdf", null],
    ["alm" + String.fromCharCode(0x061c), "pdf", null],
    ["zw" + String.fromCharCode(0x200b), "pdf", null],
    ["wj" + String.fromCharCode(0x2060), "pdf", null],
    ["b" + String.fromCharCode(0xfeff) + "om", "pdf", null],
    ["pair \u{1F468}‍\u{1F469}", "pdf", "pair \u{1F468}‍\u{1F469}.pdf"],
    ["x".repeat(195), "pdf", "x".repeat(195) + ".pdf"],
    ["x".repeat(197), "pdf", null],
    ["lone\ud800", "pdf", null],
    ["lone\udc00x", "pdf", null],
    // The limit counts characters, not UTF-16 units: 150 emoji and ".pdf" are 154 characters, 304 units.
    ["\u{1F600}".repeat(150), "pdf", `${"\u{1F600}".repeat(150)}.pdf`],
    ["\u{1F600}".repeat(197), "pdf", null],
  ];
  it.each(table)("%j.%s -> %j", async (base, ext, want) => {
    const db = libWith();
    addFile(db, { id: "a", ext });
    const answer = await rename(db, "u1", "a", base);
    expect(answer).toBe(want === null ? "bad_request" : "ok");
    expect((await fileRow(db, "u1", "a"))?.name).toBe(want ?? `a.pptx`);
  });

  it("leaves updated_at alone and refuses a trashed file", async () => {
    const db = libWith();
    addFile(db, { id: "a", updatedAt: 77 });
    await rename(db, "u1", "a", "New");
    expect((await fileRow(db, "u1", "a"))?.updatedAt).toBe(77);
    await trash(db, "u1", "a", NOW, 30);
    expect(await rename(db, "u1", "a", "Again")).toBe("not_found");
  });
});

describe("markPresented", () => {
  it("stamps only this owner's named files", async () => {
    const db = libWith(["u1", "u2"]);
    addFile(db, { id: "a" });
    addFile(db, { id: "b" });
    addFile(db, { id: "x", user: "u2" });
    await db.batch(markPresented(db, "u1", ["a", "x"], NOW));
    const at = (id: string) => db.raw.prepare("SELECT last_presented_at AS t FROM library_file WHERE id = ?").get(id);
    expect([at("a"), at("b"), at("x")]).toEqual([{ t: NOW }, { t: null }, { t: null }]);
  });

  it("stays under D1's bind limit for a long list: one statement per 90 ids", async () => {
    const db = libWith();
    const names = Array.from({ length: 200 }, (_, i) => `f${i}`);
    for (const id of names) addFile(db, { id });
    const statements = markPresented(db, "u1", names, NOW);
    expect(statements).toHaveLength(3);
    await db.batch(statements);
    expect(db.raw.prepare("SELECT count(*) AS n FROM library_file WHERE last_presented_at = ?").get(NOW)).toEqual({
      n: 200,
    });
  });
});
