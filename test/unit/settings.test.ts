import { describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/worker/auth/db.ts";
import { CACHE_MS, RESTRICTIVE, STALE_MS, settingsReader } from "../../src/worker/settings.ts";
import { testDb } from "./d1-shim.ts";

const NOW = 1_800_000_000_000;
const set = (db: ReturnType<typeof testDb>, key: string, value: string) =>
  db.raw.prepare("INSERT OR REPLACE INTO setting (key, value, updated_at) VALUES (?, ?, ?)").run(key, value, NOW);
const broken: Db = {
  prepare() {
    throw new Error("D1 down");
  },
};
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

describe("MODE-01 settings: the one reader", () => {
  it("MODE-01 settings: reads every row in one query and leaves a missing key absent", async () => {
    const raw = testDb();
    set(raw, "launch_mode", "open");
    set(raw, "other", "x");
    const { db, reads } = counting(raw);
    expect(await settingsReader(() => NOW)(db)).toEqual({
      launch_mode: "open",
      other: "x",
    });
    expect(reads()).toBe(1);
    expect(await settingsReader(() => NOW)(testDb())).toEqual({});
  });

  it("MODE-01 settings: a read is trusted for 30 s, then repeated", async () => {
    let now = NOW;
    const read = settingsReader(() => now);
    const raw = testDb();
    const { db, reads } = counting(raw);
    expect(await read(db)).toEqual({});
    set(raw, "launch_mode", "open");
    now += CACHE_MS - 1;
    expect(await read(db)).toEqual({});
    expect(reads()).toBe(1);
    now += 1;
    expect(await read(db)).toEqual({ launch_mode: "open" });
    expect(reads()).toBe(2);
  });

  it("MODE-01 settings: a zero TTL (TEST_TIMING) reads every time", async () => {
    const read = settingsReader(() => NOW);
    const raw = testDb();
    expect(await read(raw, { ttlMs: 0 })).toEqual({});
    set(raw, "launch_mode", "open");
    expect(await read(raw, { ttlMs: 0 })).toEqual({ launch_mode: "open" });
  });

  it("MODE-01 settings: a state-creating step reads fresh, and the fresh read refreshes the cache for everyone after it", async () => {
    const read = settingsReader(() => NOW);
    const raw = testDb();
    set(raw, "launch_mode", "open");
    expect((await read(raw)).launch_mode).toBe("open");
    set(raw, "launch_mode", "preview");
    expect((await read(raw)).launch_mode).toBe("open");
    expect((await read(raw, { fresh: true })).launch_mode).toBe("preview");
    expect((await read(raw)).launch_mode).toBe("preview");
  });

  it("MODE-01 settings: a failed read with nothing cached answers the most restrictive values, is logged and is not cached", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const read = settingsReader(() => NOW);
    const raw = testDb();
    set(raw, "launch_mode", "open");
    expect(await read(broken)).toEqual(RESTRICTIVE);
    expect(error).toHaveBeenCalledWith("settings_read_failed");
    expect((await read(raw)).launch_mode).toBe("open");
    error.mockRestore();
  });

  it("MODE-01 settings: a failed read serves the last good snapshot for 5 minutes, then the restrictive values", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let now = NOW;
    const read = settingsReader(() => now);
    const raw = testDb();
    set(raw, "launch_mode", "open");
    expect((await read(raw)).launch_mode).toBe("open");
    now += CACHE_MS;
    expect((await read(broken)).launch_mode).toBe("open");
    now = NOW + STALE_MS - 1;
    expect((await read(broken)).launch_mode).toBe("open");
    now = NOW + STALE_MS;
    expect(await read(broken)).toEqual(RESTRICTIVE);
    vi.restoreAllMocks();
  });

  it("MODE-01 settings: a failed fresh read is the restrictive values, never the cached snapshot", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const read = settingsReader(() => NOW);
    const raw = testDb();
    set(raw, "launch_mode", "open");
    expect((await read(raw)).launch_mode).toBe("open");
    expect(await read(broken, { fresh: true })).toEqual(RESTRICTIVE);
    vi.restoreAllMocks();
  });
});
