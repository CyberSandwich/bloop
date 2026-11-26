import { describe, expect, it } from "vitest";
import {
  claimRun,
  type DonePayload,
  heartbeat,
  markCancelled,
  markFailed,
  markSkipped,
  publishDone,
  queueDepth,
  readRun,
  setStage,
  staleRuns,
  startAttempt,
} from "../../src/worker/convert/results.ts";
import { addGuest, world } from "./convert-world.ts";

const claim = (w: ReturnType<typeof world>, runId: string, now = 10) =>
  claimRun(w.db, { fileId: w.fileId, version: 1, ownerKind: "library", runId, now });
const key = (w: ReturnType<typeof world>, runId: string) => ({ fileId: w.fileId, version: 1, runId });

const payload: DonePayload = {
  pages: 3,
  hasNotes: true,
  hasMotion: false,
  fontsMissing: ["Aptos"],
  bytes: 1234,
  outputs: {
    v: 1,
    groups: { slides: true, pdf: true, notes: true, media: false, image: false },
    total: 3,
    rendered: 3,
    files: [{ path: "slides.json", size: 10, sha256: "a".repeat(64) }],
    packs: { "1920": { size: 99 } },
  },
};

describe("CONV-08 claim: one run per version", () => {
  it("one winner among concurrent claims", async () => {
    const w = world();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => claim(w, `r${i}`)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const row = await readRun(w.db, w.fileId, 1);
    expect(row).toMatchObject({ status: "queued", owner_kind: "library", attempts: 0 });
    expect(row?.run_id).toBe(`r${results.indexOf(true)}`);
  });

  it("a live, done or cancelled-then-live version cannot be claimed again", async () => {
    const w = world();
    expect(await claim(w, "r1")).toBe(true);
    expect(await claim(w, "r2")).toBe(false);
    await startAttempt(w.db, key(w, "r1"), 11);
    expect(await claim(w, "r2")).toBe(false);
    await publishDone(w.db, key(w, "r1"), payload, 12);
    expect(await claim(w, "r2")).toBe(false);
  });

  it("skipped and cancelled re-enter; skipped never counts as an attempt", async () => {
    const w = world();
    await claim(w, "r1");
    await markSkipped(w.db, key(w, "r1"), "busy", 11);
    expect((await readRun(w.db, w.fileId, 1))?.attempts).toBe(0);
    expect(await claim(w, "r2")).toBe(true);
    expect(await markCancelled(w.db, w.fileId, 1, 12)).toBe("r2");
    expect(await claim(w, "r3")).toBe(true);
    expect(await readRun(w.db, w.fileId, 1)).toMatchObject({
      run_id: "r3",
      status: "queued",
      error: null,
      attempts: 0,
    });
  });

  it("poison is final: a final code is never claimed again", async () => {
    const w = world();
    for (const code of ["bomb", "bad_magic", "convert_failed", "timeout", "output_invalid", "too_many_pages"]) {
      const id = `r-${code}`;
      const w2 = world();
      await claim(w2, id);
      await startAttempt(w2.db, key(w2, id), 11);
      await markFailed(w2.db, key(w2, id), code, 12);
      expect(await claim(w2, "again")).toBe(false);
    }
    expect(w).toBeTruthy();
  });

  it("at most two container starts across every claim", async () => {
    const w = world();
    await claim(w, "r1");
    await startAttempt(w.db, key(w, "r1"), 11);
    await markFailed(w.db, key(w, "r1"), "interrupted", 12);
    expect(await claim(w, "r2")).toBe(true);
    await startAttempt(w.db, key(w, "r2"), 13);
    await markFailed(w.db, key(w, "r2"), "interrupted", 14);
    expect((await readRun(w.db, w.fileId, 1))?.attempts).toBe(2);
    expect(await claim(w, "r3")).toBe(false);
  });

  it("a stale run id writes nothing", async () => {
    const w = world();
    await claim(w, "r1");
    await markSkipped(w.db, key(w, "r1"), "busy", 11);
    await claim(w, "r2");
    expect(await setStage(w.db, key(w, "r1"), "starting", 12)).toBe(false);
    expect(await startAttempt(w.db, key(w, "r1"), 12)).toBe(false);
    expect(await heartbeat(w.db, key(w, "r1"), 12)).toBe(false);
    expect(await markFailed(w.db, key(w, "r1"), "bomb", 12)).toBe(false);
    expect(await publishDone(w.db, key(w, "r1"), payload, 12)).toBe(false);
    expect((await readRun(w.db, w.fileId, 1))?.status).toBe("queued");
  });
});

describe("derived writes", () => {
  it("waiting keeps the row queued and a stage makes it running", async () => {
    const w = world();
    await claim(w, "r1");
    await setStage(w.db, key(w, "r1"), "waiting", 11);
    expect(await readRun(w.db, w.fileId, 1)).toMatchObject({ status: "queued", stage: "waiting", updated_at: 11 });
    await startAttempt(w.db, key(w, "r1"), 12);
    await setStage(w.db, key(w, "r1"), "rasterize", 13);
    expect(await readRun(w.db, w.fileId, 1)).toMatchObject({ status: "running", stage: "rasterize", attempts: 1 });
  });

  it("publishDone fills every field and parses back", async () => {
    const w = world();
    await claim(w, "r1");
    await startAttempt(w.db, key(w, "r1"), 11);
    expect(await publishDone(w.db, key(w, "r1"), payload, 12)).toBe(true);
    const row = await readRun(w.db, w.fileId, 1);
    expect(row).toMatchObject({
      status: "done",
      pages: 3,
      has_notes: 1,
      has_motion: 0,
      bytes: 1234,
      stage: null,
      error: null,
    });
    expect(JSON.parse(row?.fonts_missing ?? "")).toEqual(["Aptos"]);
    expect(JSON.parse(row?.outputs ?? "")).toEqual(payload.outputs);
  });

  it("CONV-12 publish: refused when the file is trashed, disabled or its owner is purging", async () => {
    for (const sql of [
      "UPDATE library_file SET trashed_at = 1",
      "UPDATE library_file SET disabled_at = 1",
      "UPDATE app_user SET status = 'purging'",
    ]) {
      const w = world();
      await claim(w, "r1");
      await startAttempt(w.db, key(w, "r1"), 11);
      w.db.raw.exec(sql);
      expect(await publishDone(w.db, key(w, "r1"), payload, 12)).toBe(false);
      expect((await readRun(w.db, w.fileId, 1))?.status).toBe("running");
    }
  });

  it("publishDone for a guest file needs the guest file undeleted", async () => {
    const w = world();
    addGuest(w.db, "s1");
    await claimRun(w.db, { fileId: "s1", version: 1, ownerKind: "guest", runId: "g1", now: 1 });
    await startAttempt(w.db, { fileId: "s1", version: 1, runId: "g1" }, 2);
    w.db.raw.exec("UPDATE guest_file SET deleted_at = 3");
    expect(await publishDone(w.db, { fileId: "s1", version: 1, runId: "g1" }, payload, 4)).toBe(false);
  });

  it("markCancelled only touches a live run and returns its id", async () => {
    const w = world();
    expect(await markCancelled(w.db, w.fileId, 1, 1)).toBeNull();
    await claim(w, "r1");
    await startAttempt(w.db, key(w, "r1"), 2);
    expect(await markCancelled(w.db, w.fileId, 1, 3)).toBe("r1");
    expect(await markCancelled(w.db, w.fileId, 1, 4)).toBeNull();
    expect((await readRun(w.db, w.fileId, 1))?.status).toBe("cancelled");
  });

  it("a done row is never cancelled", async () => {
    const w = world();
    await claim(w, "r1");
    await startAttempt(w.db, key(w, "r1"), 2);
    await publishDone(w.db, key(w, "r1"), payload, 3);
    expect(await markCancelled(w.db, w.fileId, 1, 4)).toBeNull();
    expect((await readRun(w.db, w.fileId, 1))?.status).toBe("done");
  });

  it("staleRuns lists live rows older than the cutoff, oldest first", async () => {
    const w = world();
    await claim(w, "r1", 100);
    expect(await staleRuns(w.db, 100)).toEqual([]);
    expect(await staleRuns(w.db, 101)).toEqual([{ fileId: w.fileId, version: 1, runId: "r1" }]);
    await markFailed(w.db, key(w, "r1"), "bomb", 102);
    expect(await staleRuns(w.db, 1000)).toEqual([]);
  });

  it("queueDepth counts live rows overall, per user and for guests", async () => {
    const w = world();
    addGuest(w.db, "s1");
    await claim(w, "r1");
    await claimRun(w.db, { fileId: "s1", version: 1, ownerKind: "guest", runId: "g1", now: 1 });
    expect(await queueDepth(w.db, w.userId)).toEqual({ all: 2, user: 1, guest: 1 });
    expect(await queueDepth(w.db, "someone")).toEqual({ all: 2, user: 0, guest: 1 });
    await markFailed(w.db, key(w, "r1"), "bomb", 5);
    expect(await queueDepth(w.db, w.userId)).toEqual({ all: 1, user: 0, guest: 1 });
  });
});
