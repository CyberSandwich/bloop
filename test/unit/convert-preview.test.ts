import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/worker/convert/outputs.ts";
import {
  deadlineSeconds,
  instanceFor,
  instanceMicroUsdPerSecond,
  meterWeight,
  PROFILES,
} from "../../src/worker/convert/profile.ts";
import { isPlayable, playableKey } from "../../src/worker/convert/results.ts";
import { buildStubOutputs, type StubOutputs, stubWebp } from "../../src/worker/convert/stub-outputs.ts";
import { STALE_AFTER_MS, sweepConversions } from "../../src/worker/convert/sweep.ts";
import { jobRecordSchema, RECORD_KEY } from "../../src/worker/do/converter-schema.ts";
import { begin, derived, type Harness, harness } from "./convert-harness.ts";

const JOB = "f1_v1_a1";
const PREFIX = "u/u1/f1/v1";
const key = (rel: string) => `${PREFIX}/d/${rel}`;

type Ending = "full" | "fails" | "preview_only" | "lost";

interface Scenario {
  /** Status polls before the 720p is listed ready (0 lists it at once). */
  readyAfter: number;
  /** Polls after that before the job ends. */
  endAfter: number;
  ending: Ending;
  /** The 720p's bytes are not what its manifest claims. */
  corrupt?: boolean;
  /** The container never lists a 720p: the copy path. */
  noPreview?: boolean;
  /** The full encode's bytes are not what its manifest claims. */
  badFull?: boolean;
}

/** A video container that lists its 720p as ready, keeps encoding, then ends as the scenario says. */
async function videoContainer(h: Harness, s: Scenario): Promise<void> {
  const sha = "a".repeat(64);
  const full = await buildStubOutputs(JOB, "mp4", PROFILES.full, sha, { pages: 0 });
  // The preview's thumbnail has bytes of its own, so a store that confuses the two shows.
  const thumb = stubWebp(480, 270, 7);
  const thumbSha = await sha256Hex(thumb);
  const rename = (o: StubOutputs): StubOutputs => {
    const files = new Map(o.files);
    const bytes = files.get("m/0.mp4") as Uint8Array;
    files.delete("m/0.mp4");
    files.set("m/720.mp4", bytes);
    files.set("t.webp", thumb);
    const list = o.manifest.files.map((f) =>
      f.path === "m/0.mp4"
        ? { ...f, path: "m/720.mp4" }
        : f.path === "t.webp"
          ? { ...f, size: thumb.length, sha256: thumbSha }
          : f,
    );
    return { files, manifest: { ...o.manifest, files: list } };
  };
  const preview = rename(full);
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  let polls = 0;
  const finished = () => polls > s.readyAfter + s.endAfter;
  h.respond = (path) => {
    if (path === "/job/status") {
      polls++;
      const listed = !s.noPreview && polls > s.readyAfter && !finished();
      if (finished()) {
        if (s.ending === "fails")
          return json({ state: "failed", stage: "video", pct: 50, error: "timeout", pages: null, ready: [] });
        if (s.ending === "lost")
          return json({ state: "idle", stage: null, pct: 0, error: null, pages: null, ready: [] });
        return json({ state: "done", stage: "done", pct: 100, error: null, pages: null, ready: [] });
      }
      return json({
        state: "running",
        stage: "video",
        pct: 40,
        error: null,
        pages: null,
        ready: listed ? ["m/720.mp4", "t.webp", "meta.json"] : [],
      });
    }
    const rel = path.slice("/out/".length);
    if (!path.startsWith("/out/")) return null;
    if (rel === "preview.json")
      return s.noPreview || finished() ? json({ error: "not_ready" }, 409) : json(preview.manifest);
    if (rel === "manifest.json") {
      if (!finished()) return json({ error: "not_ready" }, 409);
      return json(s.ending === "preview_only" ? preview.manifest : full.manifest);
    }
    const from = s.ending === "preview_only" || !finished() ? preview : full;
    const bytes = from.files.get(rel);
    if (!bytes) return json({ error: "not_found" }, 404);
    if (s.corrupt && rel === "m/720.mp4" && !finished()) return new Response(new Uint8Array(bytes.length));
    if (s.badFull && rel === "m/0.mp4") return new Response(new Uint8Array(bytes.length));
    return new Response(bytes as Uint8Array<ArrayBuffer>);
  };
}

/** Runs the job alarm by alarm, noting each distinct (status, stage) the row shows. */
async function watch(h: Harness): Promise<string[]> {
  const seen: string[] = [];
  const note = () => {
    const row = derived(h);
    const tag = row ? `${row.status}${row.stage ? `:${row.stage}` : ""}` : "none";
    if (seen[seen.length - 1] !== tag) seen.push(tag);
  };
  for (let i = 0; i < 400; i++) {
    const rec = (await h.store.get(RECORD_KEY)) as { phase: string } | undefined;
    if (!rec || rec.phase === "done" || h.store.alarmAt === null) break;
    h.clock.t = Math.max(h.clock.t, h.store.alarmAt);
    h.store.alarmAt = null;
    try {
      await h.runner.alarm();
    } catch {
      h.store.alarmAt ??= h.clock.t + 2000;
    }
    note();
  }
  return seen;
}

async function run(s: Scenario) {
  const h = harness({ ext: "mp4", bytes: 4000 });
  await videoContainer(h, s);
  await begin(h, { ext: "mp4" });
  const seen = await watch(h);
  return {
    h,
    seen,
    row: derived(h) as { status: string; stage: string | null; outputs: string | null; bytes: number },
  };
}

const files = (row: { outputs: string | null }): string[] =>
  (JSON.parse(row.outputs ?? "{}").files ?? []).map((f: { path: string }) => f.path).sort();

describe("the 720p comes first: a video's row is playable before its full encode ends", () => {
  it("720p ready, then the full encode: ready720 while it runs, done after, the 720p object gone", async () => {
    const { h, seen, row } = await run({ readyAfter: 1, endAfter: 3, ending: "full" });
    expect(seen).toContain("ready720:video");
    expect(seen.indexOf("ready720:video")).toBeLessThan(seen.indexOf("done"));
    expect(seen[seen.length - 1]).toBe("done");
    expect(row.status).toBe("done");
    expect(files(row)).toEqual(["m/0.mp4", "t.webp"]);
    expect(h.bucket.keys(`${PREFIX}/d/`)).toEqual([key("m/0.mp4"), key("t.webp")]);
    expect(playableKey(row)).toBe("m/0.mp4");
    expect(h.starts).toHaveLength(1);
    expect(h.notify.terminal_.map((t) => t.state)).toEqual(["done", "done"]);
    // The published thumbnail is never written again, so a reader fetching it never sees it change.
    expect(h.bucket.objects.get(key("t.webp"))).toEqual(stubWebp(480, 270, 7));
  });

  it("the 720p alone is playable while the full encode runs, and counts against the row's bytes", async () => {
    const h = harness({ ext: "mp4", bytes: 4000 });
    await videoContainer(h, { readyAfter: 0, endAfter: 50, ending: "full" });
    await begin(h, { ext: "mp4" });
    for (let i = 0; i < 40 && (derived(h) as { status: string }).status !== "ready720"; i++) {
      h.clock.t = Math.max(h.clock.t, h.store.alarmAt as number);
      h.store.alarmAt = null;
      await h.runner.alarm();
    }
    const row = derived(h) as { status: string; outputs: string; bytes: number };
    expect(row.status).toBe("ready720");
    expect(isPlayable(row.status)).toBe(true);
    expect(playableKey(row)).toBe("m/720.mp4");
    expect(files(row)).toEqual(["m/720.mp4", "t.webp"]);
    expect(row.bytes).toBeGreaterThan(0);
    expect(h.bucket.keys(`${PREFIX}/d/`)).toEqual([key("m/720.mp4"), key("t.webp")]);
  });

  it("a full encode that fails leaves ready720 as the final state, with no error shown and no retry", async () => {
    const { h, seen, row } = await run({ readyAfter: 1, endAfter: 3, ending: "fails" });
    expect(seen[seen.length - 1]).toBe("ready720");
    expect(row.status).toBe("ready720");
    expect(row.stage).toBeNull();
    expect(files(row)).toEqual(["m/720.mp4", "t.webp"]);
    expect(playableKey(row)).toBe("m/720.mp4");
    expect(h.bucket.keys(`${PREFIX}/d/`)).toEqual([key("m/720.mp4"), key("t.webp")]);
    expect(h.starts).toHaveLength(1);
    expect(h.notify.terminal_.map((t) => t.state)).not.toContain("failed");
    expect(h.spend.calls).toContain("record:conversion_done");
    expect(h.spend.calls).not.toContain("record:conversion_failed");
  });

  it("a retryable end after the 720p (the container lost) is not retried either", async () => {
    const { h, row } = await run({ readyAfter: 1, endAfter: 3, ending: "lost" });
    expect(row.status).toBe("ready720");
    expect(h.starts).toHaveLength(1);
  });

  it("a container that finishes with only the 720p ends ready720 with the 720p stored once", async () => {
    const { h, row } = await run({ readyAfter: 1, endAfter: 3, ending: "preview_only" });
    expect(row.status).toBe("ready720");
    expect(row.stage).toBeNull();
    expect(files(row)).toEqual(["m/720.mp4", "t.webp"]);
    expect(h.bucket.keys(`${PREFIX}/d/`)).toEqual([key("m/720.mp4"), key("t.webp")]);
    expect(playableKey(row)).toBe("m/720.mp4");
  });

  it("the copy path never lists a 720p: the row goes straight to done", async () => {
    const { h, seen, row } = await run({ readyAfter: 1, endAfter: 3, ending: "full", noPreview: true });
    expect(seen).not.toContain("ready720:video");
    expect(row.status).toBe("done");
    expect(h.bucket.keys(`${PREFIX}/d/`)).toEqual([key("m/0.mp4"), key("t.webp")]);
  });

  it("a 720p whose bytes do not match its manifest is dropped and the finished job still publishes", async () => {
    const { h, seen, row } = await run({ readyAfter: 1, endAfter: 3, ending: "full", corrupt: true });
    expect(seen).not.toContain("ready720:video");
    expect(row.status).toBe("done");
    expect(h.bucket.keys(`${PREFIX}/d/`)).toEqual([key("m/0.mp4"), key("t.webp")]);
  });

  it("a cancel while the full encode runs removes the 720p with the rest", async () => {
    const h = harness({ ext: "mp4", bytes: 4000 });
    await videoContainer(h, { readyAfter: 0, endAfter: 50, ending: "full" });
    await begin(h, { ext: "mp4" });
    for (let i = 0; i < 40 && (derived(h) as { status: string }).status !== "ready720"; i++) {
      h.clock.t = Math.max(h.clock.t, h.store.alarmAt as number);
      h.store.alarmAt = null;
      await h.runner.alarm();
    }
    expect(await h.runner.cancel(h.runId)).toBe("cancelled");
    expect((derived(h) as { status: string }).status).toBe("cancelled");
    expect(h.bucket.keys(`${PREFIX}/d/`)).toEqual([]);
  });
});

/** Runs alarms until the row shows ready720 with its stage (the 720p is published, the full encode still going). */
async function untilReady720(h: Harness): Promise<void> {
  for (let i = 0; i < 60 && (derived(h) as { status: string }).status !== "ready720"; i++) {
    h.clock.t = Math.max(h.clock.t, h.store.alarmAt as number);
    h.store.alarmAt = null;
    await h.runner.alarm();
  }
  expect((derived(h) as { status: string }).status).toBe("ready720");
}

describe("the published 720p is the row's: nothing later in the run may take it away", () => {
  it("a full encode that fails its checks leaves the 720p and its thumbnail published and stored", async () => {
    const { h, row } = await run({ readyAfter: 1, endAfter: 3, ending: "full", badFull: true });
    expect(row.status).toBe("ready720");
    expect(row.stage).toBeNull();
    expect(files(row)).toEqual(["m/720.mp4", "t.webp"]);
    expect(h.bucket.keys(`${PREFIX}/d/`)).toEqual([key("m/720.mp4"), key("t.webp")]);
    expect(h.notify.terminal_.map((t) => t.state)).not.toContain("failed");
    expect(h.starts).toHaveLength(1);
  });

  it("a cancel that lands before the full encode's failed end leaves the row cancelled and the bucket empty", async () => {
    const h = harness({ ext: "mp4", bytes: 4000 });
    await videoContainer(h, { readyAfter: 0, endAfter: 6, ending: "fails" });
    await begin(h, { ext: "mp4" });
    await untilReady720(h);
    h.w.db.raw.exec("UPDATE derived SET status = 'cancelled', stage = NULL");
    await watch(h);
    expect((derived(h) as { status: string }).status).toBe("cancelled");
    expect(h.bucket.keys(`${PREFIX}/d/`)).toEqual([]);
    expect(h.notify.terminal_.at(-1)?.state).toBe("cancelled");
    expect(h.spend.calls).not.toContain("record:conversion_failed");
  });

  it("a lost Converter record leaves a ready720 row playable: the sweep settles it instead of failing it", async () => {
    const h = harness({ ext: "mp4", bytes: 4000 });
    await videoContainer(h, { readyAfter: 0, endAfter: 50, ending: "full" });
    await begin(h, { ext: "mp4" });
    await untilReady720(h);
    await h.store.deleteAll();
    h.clock.t += STALE_AFTER_MS + 1;
    const deps = {
      db: h.w.db,
      spend: h.spend,
      converter: () => h.runner,
      gates: async () => h.gates,
      leaseMaxSeconds: 1800,
      now: () => h.clock.t,
      newRunId: () => "x",
      log: () => undefined,
    };
    expect(await sweepConversions(deps)).toMatchObject({ checked: 1, lost: 1 });
    expect(derived(h)).toMatchObject({ status: "ready720", stage: null, error: null });
  });

  it("only a video may use the early manifest: a deck whose container lists a 720p is not published early", async () => {
    const h = harness({ ext: "pptx" });
    const deck = await buildStubOutputs(JOB, "pptx", PROFILES.full, "a".repeat(64), { pages: 2 });
    let polls = 0;
    h.respond = (path) => {
      const json = (v: unknown, status = 200) =>
        new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
      if (path === "/job/status") {
        polls++;
        return polls > 3
          ? json({ state: "done", stage: "done", pct: 100, error: null, pages: null, ready: [] })
          : json({ state: "running", stage: "convert", pct: 10, error: null, pages: null, ready: ["m/720.mp4"] });
      }
      if (!path.startsWith("/out/")) return null;
      const rel = path.slice("/out/".length);
      if (rel === "preview.json") return json(deck.manifest);
      if (rel === "manifest.json") return polls > 3 ? json(deck.manifest) : json({ error: "not_ready" }, 409);
      const bytes = deck.files.get(rel);
      return bytes ? new Response(bytes as Uint8Array<ArrayBuffer>) : json({ error: "not_found" }, 404);
    };
    await begin(h, { ext: "pptx" });
    const seen = await watch(h);
    expect(seen).not.toContain("ready720:convert");
    expect(seen.some((s) => s.startsWith("ready720"))).toBe(false);
    expect((derived(h) as { status: string }).status).toBe("done");
  });

  it("a run past its deadline while the 720p is 'storing' but already committed keeps the 720p", async () => {
    const h = harness({ ext: "mp4", bytes: 4000 });
    await videoContainer(h, { readyAfter: 0, endAfter: 50, ending: "full" });
    await begin(h, { ext: "mp4" });
    await untilReady720(h);
    // The early publish committed, then the Converter lost the write that records it.
    const rec = (await h.store.get(RECORD_KEY)) as Record<string, unknown>;
    await h.store.put(RECORD_KEY, { ...rec, preview: "storing", deadline: h.clock.t - 1 });
    h.store.alarmAt = h.clock.t;
    await h.runner.alarm();
    expect(derived(h)).toMatchObject({ status: "ready720", stage: null, error: null });
    expect(h.bucket.keys(`${PREFIX}/d/`)).toEqual([key("m/720.mp4"), key("t.webp")]);
    expect(h.starts).toHaveLength(1);
    expect(h.spend.calls).toContain("record:conversion_done");
  });

  it("a record stored before the 720p existed still parses, with no preview and a weight of one", async () => {
    const h = harness({ ext: "mp4", bytes: 4000 });
    await begin(h, { ext: "mp4" });
    const rec = (await h.store.get(RECORD_KEY)) as Record<string, unknown>;
    const { preview: _p, weight: _w, ...old } = rec;
    expect(jobRecordSchema.parse(old)).toMatchObject({ preview: "none", weight: 1 });
    const plan = {
      manifest: "m",
      rendered: 0,
      total: 0,
      passed: ["media"],
      pages: [],
      noteCount: 0,
      motion: false,
      media: false,
      fonts: [],
    };
    expect(jobRecordSchema.parse({ ...old, plan }).plan?.preview).toBe(false);
  });
});

describe("a video runs on standard-4 and the meter counts it at standard-4 rates", () => {
  it("the container starts on standard-4 with the measured encode rate, and a deck stays on standard-2", async () => {
    const { h } = await run({ readyAfter: 1, endAfter: 2, ending: "full" });
    expect(h.starts[0]?.instance).toBe("standard-4");
    expect(h.starts[0]?.env.BLOOP_VIDEO_RATE).toBe("1");
    const deck = harness({ ext: "pptx" });
    await begin(deck, { ext: "pptx" });
    await deck.runner.alarm();
    for (let i = 0; i < 12 && deck.starts.length === 0; i++) {
      deck.clock.t = Math.max(deck.clock.t, deck.store.alarmAt as number);
      deck.store.alarmAt = null;
      await deck.runner.alarm();
    }
    expect(deck.starts[0]?.instance).toBe("standard-2");
    expect(deck.starts[0]?.env.BLOOP_VIDEO_RATE).toBeUndefined();
  });

  it("vCPU, memory and disk are priced at Cloudflare's rates: standard-4 is 3.11 standard-2 seconds", () => {
    // $0.000020 per vCPU-second, $0.0000025 per GiB-second, $0.00000007 per GB-second, in micro-dollars.
    expect(instanceMicroUsdPerSecond("standard-2")).toBeCloseTo(1 * 20 + 6 * 2.5 + 12 * 0.07, 10);
    expect(instanceMicroUsdPerSecond("standard-4")).toBeCloseTo(4 * 20 + 12 * 2.5 + 20 * 0.07, 10);
    expect(instanceMicroUsdPerSecond("standard-4")).toBeCloseTo(111.4, 10);
    expect(meterWeight("standard-2")).toBe(1);
    expect(meterWeight("standard-4")).toBe(3.11);
    expect(instanceFor("video")).toBe("standard-4");
    expect(instanceFor("deck")).toBe("standard-2");
  });

  it("a standard-4 run takes container seconds at that weight, and a refund counts the same weight", async () => {
    const { h } = await run({ readyAfter: 1, endAfter: 2, ending: "full" });
    const seconds = deadlineSeconds("video", "mp4", 4000, PROFILES.full);
    const rec = (await h.store.get(RECORD_KEY)) as { weight: number; secondsTaken: number; takenAt: number };
    expect(rec.weight).toBe(3.11);
    expect(rec.secondsTaken).toBe(Math.ceil(seconds * 3.11));
    // The run used some of the ticket; the rest comes back counted at the same weight.
    const used = Math.ceil(((h.clock.t - rec.takenAt) / 1000) * 3.11);
    expect(used).toBeGreaterThan(0);
    expect(used).toBeLessThan(rec.secondsTaken);
    expect(h.spend.refunds).toEqual([{ meter: "container_seconds", n: rec.secondsTaken - used }]);
  });
});

describe("readers go through isPlayable and playableKey", () => {
  const outputs = (paths: string[], media = true) =>
    JSON.stringify({
      v: 1,
      groups: { slides: false, pdf: false, notes: false, media, image: false },
      total: 0,
      rendered: 0,
      files: paths.map((path) => ({ path, size: 1, sha256: "b".repeat(64) })),
      packs: {},
    });

  it("done and ready720 are playable; a row still being made, failed or gone is not", () => {
    for (const s of ["done", "ready720"]) expect(isPlayable(s)).toBe(true);
    for (const s of ["queued", "running", "failed", "skipped", "cancelled", "", null, undefined])
      expect(isPlayable(s)).toBe(false);
  });

  it("the key is the full encode when stored, the 720p otherwise, and null when nothing plays", () => {
    expect(playableKey({ status: "done", outputs: outputs(["m/0.mp4", "t.webp"]) })).toBe("m/0.mp4");
    expect(playableKey({ status: "ready720", outputs: outputs(["m/720.mp4", "t.webp"]) })).toBe("m/720.mp4");
    expect(playableKey({ status: "ready720", outputs: outputs(["m/720.mp4", "m/0.mp4", "t.webp"]) })).toBe("m/0.mp4");
    expect(playableKey({ status: "running", outputs: outputs(["m/720.mp4"]) })).toBeNull();
    expect(playableKey({ status: "done", outputs: null })).toBeNull();
    expect(playableKey({ status: "done", outputs: "not json" })).toBeNull();
    expect(playableKey({ status: "done", outputs: outputs(["doc.pdf"], false) })).toBeNull();
  });
});
