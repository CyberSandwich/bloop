import { describe, expect, it } from "vitest";
import type { RetentionDeps } from "../../src/worker/library/retention.ts";
import { resumeClocks, runLibraryRetention, warnInactive } from "../../src/worker/library/retention.ts";
import { addFile, type LibTestDb, libWith } from "./library-db.ts";
import { fakeBucket } from "./library-r2.ts";

const DAY = 86_400_000;
const NOW = 1_000 * DAY;
const config = { inactiveDays: 730, inactiveGraceDays: 30 };
const deps = (over: Partial<RetentionDeps> = {}): RetentionDeps => ({
  cancelConversion: async () => {},
  exporting: async () => false,
  now: () => NOW,
  endScreens: async () => {},
  closeSessions: async () => {},
  abortUploads: async () => false,
  eraseObject: async () => {},
  warn: async () => true,
  lockoutMembers: null,
  ...over,
});
const asMember = (db: LibTestDb, id: string, lastSeen: number, extra = "") =>
  db.raw
    .prepare(`UPDATE app_user SET tid = 'email', email_norm = ?, last_seen_at = ? ${extra} WHERE id = ?`)
    .run(`${id}@x.test`, lastSeen, id);
const user = (db: LibTestDb, id: string) =>
  db.raw
    .prepare("SELECT inactive_warned_at AS w, delete_after AS d, last_seen_at AS l FROM app_user WHERE id = ?")
    .get(id);

describe("LIB-09 inactive warning", () => {
  it("warns only the long-unused, then marks and schedules the deletion", async () => {
    const db = libWith(["old", "recent"]);
    asMember(db, "old", NOW - 731 * DAY);
    asMember(db, "recent", NOW - 10 * DAY);
    const warned: string[] = [];
    const n = await warnInactive({ DB: db }, config, deps({ warn: async (u) => (warned.push(u.id), true) }), NOW);
    expect(n).toBe(1);
    expect(warned).toEqual(["old"]);
    expect(user(db, "old")).toEqual({
      w: NOW,
      d: NOW + 30 * DAY,
      l: NOW - 731 * DAY,
    });
    expect(user(db, "recent")).toMatchObject({ w: null, d: null });
  });

  it("a failed send changes nothing, so no deletion starts without a sent warning", async () => {
    const db = libWith(["old"]);
    asMember(db, "old", 1);
    expect(await warnInactive({ DB: db }, config, deps({ warn: async () => false }), NOW)).toBe(0);
    expect(user(db, "old")).toMatchObject({ w: null, d: null });
  });

  it("a sign-in between the send and the mark wins", async () => {
    const db = libWith(["old"]);
    asMember(db, "old", 1);
    const warn = async () => {
      db.raw.prepare("UPDATE app_user SET last_seen_at = ? WHERE id = 'old'").run(NOW);
      return true;
    };
    expect(await warnInactive({ DB: db }, config, deps({ warn }), NOW)).toBe(0);
    expect(user(db, "old")).toMatchObject({ w: null, d: null });
  });

  it("skips the warned, the suspended and non-email accounts", async () => {
    const db = libWith(["w", "s", "o"]);
    asMember(db, "w", 1, ", inactive_warned_at = 5");
    asMember(db, "s", 1, ", suspended_at = 5");
    db.raw.prepare("UPDATE app_user SET email_norm = 'o@x.test', last_seen_at = 1 WHERE id = 'o'").run();
    expect(await warnInactive({ DB: db }, config, deps(), NOW)).toBe(0);
  });

  it("in the preview lockout considers only listed members, chosen in the query", async () => {
    const db = libWith(["a", "b"]);
    asMember(db, "a", 1);
    asMember(db, "b", 1);
    const warned: string[] = [];
    const warn = async (u: { id: string }) => (warned.push(u.id), true);
    await warnInactive({ DB: db }, config, deps({ warn, lockoutMembers: ["b@x.test"] }), NOW);
    expect(warned).toEqual(["b"]);
    expect(await warnInactive({ DB: db }, config, deps({ warn, lockoutMembers: [] }), NOW)).toBe(0);
  });
});

describe("LIB-09 trash and deletion through the cron", () => {
  it("purges due trash, deletes a due account, and reports what it did", async () => {
    const db = libWith(["u1", "u2"]);
    addFile(db, { id: "t", user: "u1", trashedAt: 1, purgeAfter: NOW - 1 });
    db.raw.prepare("UPDATE app_user SET status = 'deleting', delete_after = ? WHERE id = 'u2'").run(NOW - 1);
    const r2 = fakeBucket({ "u/u1/t/v1/orig": "x", "u/u2/a/v1/orig": "y" });
    const report = await runLibraryRetention({ DB: db, LIBRARY: r2.bucket }, config, deps(), { daily: false });
    expect(report).toMatchObject({
      trashPurged: 1,
      accountsPurged: 1,
      warned: 0,
      more: false,
    });
    expect([...r2.objects.keys()].sort()).toEqual(["purged/u2"]);
  });

  it("the hourly run skips the daily scans; the daily run does them", async () => {
    const db = libWith(["old"]);
    asMember(db, "old", 1);
    const r2 = fakeBucket({ "u/gone/a/v1/orig": "x" });
    const hourly = await runLibraryRetention({ DB: db, LIBRARY: r2.bucket }, config, deps(), { daily: false });
    expect(hourly).toMatchObject({ warned: 0, orphans: 0 });
    const daily = await runLibraryRetention({ DB: db, LIBRARY: r2.bucket }, config, deps(), { daily: true });
    expect(daily).toMatchObject({ warned: 1, orphans: 1 });
  });

  it("says more while a user still has to be continued", async () => {
    const db = libWith(["u1"]);
    db.raw.prepare("UPDATE app_user SET status = 'deleting', delete_after = ? WHERE id = 'u1'").run(NOW - 1);
    const report = await runLibraryRetention(
      { DB: db, LIBRARY: fakeBucket().bucket },
      config,
      deps({ abortUploads: async () => true }),
      { daily: false },
    );
    expect(report).toMatchObject({ accountsPending: 1, more: true });
  });
});

describe("LIB-11 moderation: resumeClocks", () => {
  it("moves trash, deletion and last-seen later by the suspended time, never past now", async () => {
    const db = libWith(["u1"]);
    addFile(db, { id: "t", trashedAt: 1, purgeAfter: 5000 });
    addFile(db, { id: "k" });
    db.raw.prepare("UPDATE app_user SET delete_after = 9000, last_seen_at = ? WHERE id = 'u1'").run(NOW - 10);
    await db.batch(resumeClocks(db, "u1", NOW - 100, NOW));
    expect(db.raw.prepare("SELECT id, purge_after AS p FROM library_file ORDER BY id").all()).toEqual([
      { id: "k", p: null },
      { id: "t", p: 5100 },
    ]);
    expect(user(db, "u1")).toMatchObject({ d: 9100, l: NOW });
  });

  it("leaves a user with no deletion time without one, and does not touch other users", async () => {
    const db = libWith(["u1", "u2"]);
    addFile(db, { id: "x", user: "u2", trashedAt: 1, purgeAfter: 5000 });
    await db.batch(resumeClocks(db, "u1", NOW - 100, NOW));
    expect(user(db, "u1")).toMatchObject({ d: null });
    expect(db.raw.prepare("SELECT purge_after AS p FROM library_file WHERE id = 'x'").get()).toEqual({ p: 5000 });
  });

  it("a suspension time in the future adds nothing", async () => {
    const db = libWith(["u1"]);
    addFile(db, { id: "t", trashedAt: 1, purgeAfter: 5000 });
    await db.batch(resumeClocks(db, "u1", NOW + 100, NOW));
    expect(db.raw.prepare("SELECT purge_after AS p FROM library_file").get()).toEqual({ p: 5000 });
  });
});
