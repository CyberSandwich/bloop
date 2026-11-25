import { describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/worker/auth/db.ts";
import { admitted, CACHE_MS, launchReader, readLaunchState } from "../../src/worker/mode.ts";
import { testDb } from "./d1-shim.ts";

const NOW = 1_800_000_000_000;
const set = (db: ReturnType<typeof testDb>, key: string, value: string) =>
  db.raw.prepare("INSERT OR REPLACE INTO setting (key, value, updated_at) VALUES (?, ?, ?)").run(key, value, NOW);

describe("MODE-01 modes: the launch mode read", () => {
  it("MODE-01 modes: a missing row is preview with no lockout", async () => {
    expect(await readLaunchState(testDb())).toEqual({ mode: "preview", lockout: false });
  });

  it("MODE-01 modes: open is exactly the value open; anything else is preview", async () => {
    for (const value of ["OPEN", "open ", "true", "1", "", "preview"]) {
      const db = testDb();
      set(db, "launch_mode", value);
      expect((await readLaunchState(db)).mode).toBe("preview");
    }
    const db = testDb();
    set(db, "launch_mode", "open");
    expect(await readLaunchState(db)).toEqual({ mode: "open", lockout: false });
  });

  it("MODE-01 modes: the lockout is set only by the value 1 and counts only in preview", async () => {
    const db = testDb();
    set(db, "preview_lockout", "1");
    expect(await readLaunchState(db)).toEqual({ mode: "preview", lockout: true });
    set(db, "preview_lockout", "yes");
    expect((await readLaunchState(db)).lockout).toBe(false);
    set(db, "preview_lockout", "1");
    set(db, "launch_mode", "open");
    expect(await readLaunchState(db)).toEqual({ mode: "open", lockout: false });
  });
});

describe("MODE-01 modes: the cache", () => {
  const counting = (db: Db) => {
    let reads = 0;
    const counted: Db = {
      prepare(sql) {
        reads++;
        return db.prepare(sql);
      },
    };
    return { db: counted, reads: () => reads };
  };

  it("MODE-01 modes: a read is trusted for 30 s, then repeated", async () => {
    let now = NOW;
    const read = launchReader(() => now);
    const raw = testDb();
    const { db, reads } = counting(raw);
    expect((await read(db)).mode).toBe("preview");
    set(raw, "launch_mode", "open");
    now += CACHE_MS - 1;
    expect((await read(db)).mode).toBe("preview");
    expect(reads()).toBe(1);
    now += 1;
    expect((await read(db)).mode).toBe("open");
    expect(reads()).toBe(2);
  });

  it("MODE-01 modes: a zero TTL (TEST_TIMING) reads every time", async () => {
    const read = launchReader(() => NOW);
    const raw = testDb();
    expect((await read(raw, { ttlMs: 0 })).mode).toBe("preview");
    set(raw, "launch_mode", "open");
    expect((await read(raw, { ttlMs: 0 })).mode).toBe("open");
  });

  it("MODE-01 modes: a state-creating step reads fresh, so a switch back to preview is seen at once with the cache warm", async () => {
    const read = launchReader(() => NOW);
    const raw = testDb();
    set(raw, "launch_mode", "open");
    expect((await read(raw)).mode).toBe("open");
    set(raw, "launch_mode", "preview");
    expect((await read(raw)).mode).toBe("open");
    expect((await read(raw, { fresh: true })).mode).toBe("preview");
    // The fresh read refreshes the cache for everyone after it.
    expect((await read(raw)).mode).toBe("preview");
  });

  it("MODE-01 modes: a failed read is preview, is logged, and is not cached", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const read = launchReader(() => NOW);
    const raw = testDb();
    set(raw, "launch_mode", "open");
    const broken: Db = {
      prepare() {
        throw new Error("D1 down");
      },
    };
    expect(await read(broken)).toEqual({ mode: "preview", lockout: false });
    expect(error).toHaveBeenCalledWith("launch_mode_read_failed");
    expect((await read(raw)).mode).toBe("open");
    error.mockRestore();
  });

  it("MODE-01 modes: an expired cache with a failing read answers preview, not the stale open", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let now = NOW;
    const read = launchReader(() => now);
    const raw = testDb();
    set(raw, "launch_mode", "open");
    expect((await read(raw)).mode).toBe("open");
    now += CACHE_MS;
    const broken: Db = {
      prepare() {
        throw new Error("D1 down");
      },
    };
    expect((await read(broken)).mode).toBe("preview");
    vi.restoreAllMocks();
  });
});

describe("MODE-01 modes: who the lockout admits", () => {
  const account = { adminEmails: new Set(["admin@example.test"]), testEmails: new Set(["test@example.test"]) };
  const locked = { mode: "preview", lockout: true } as const;

  it("MODE-01 modes: with the lockout only the admin and test addresses pass; an Entra user is not a member and passes", () => {
    expect(admitted(locked, account, "admin@example.test")).toBe(true);
    expect(admitted(locked, account, "test@example.test")).toBe(true);
    expect(admitted(locked, account, "member@example.test")).toBe(false);
    expect(admitted(locked, account, null)).toBe(true);
  });

  it("MODE-01 modes: without the lockout everyone passes", () => {
    expect(admitted({ mode: "preview", lockout: false }, account, "member@example.test")).toBe(true);
    expect(admitted({ mode: "open", lockout: false }, account, "member@example.test")).toBe(true);
  });
});
