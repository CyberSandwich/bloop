import { describe, expect, it } from "vitest";
import { realPort } from "../../src/worker/convert/port.ts";
import { claimRun, markCancelled, startAttempt } from "../../src/worker/convert/results.ts";
import { RECORD_KEY } from "../../src/worker/do/converter-schema.ts";
import { begin, derived, drive, type Harness, harness, stepTo } from "./convert-harness.ts";

const prefix = "u/u1/f1/v1";
const bundleKeys = (h: Harness) => h.bucket.keys(prefix).filter((k) => k !== `${prefix}/orig`);
const record = async (h: Harness) => (await h.store.get(RECORD_KEY)) as Record<string, unknown>;

describe("CONV-01 isolation", () => {
  it("starts with enableInternet false, the converter image, standard-2, and registers no intercept", () => {
    const starts: unknown[] = [];
    const touched: string[] = [];
    const container = {
      running: false,
      images: { converter: "registry.example/converter@sha256:abc" },
      start: (o: unknown) => starts.push(o),
      destroy: async () => undefined,
      setInactivityTimeout: async () => undefined,
      getTcpPort: () => ({ fetch: async () => new Response("ok") }),
      interceptOutboundHttp: () => touched.push("http"),
      interceptAllOutboundHttp: () => touched.push("all"),
      interceptOutboundHttps: () => touched.push("https"),
    };
    realPort({ container } as unknown as Parameters<typeof realPort>[0]).start({ BLOOP_MAX_INPUT: "1" });
    expect(starts).toEqual([
      {
        image: "registry.example/converter@sha256:abc",
        instance: "standard-2",
        enableInternet: false,
        env: { BLOOP_MAX_INPUT: "1" },
        labels: { app: "bloop-converter" },
      },
    ]);
    expect(touched).toEqual([]);
  });

  it("a Durable Object with no container or no image cannot start one", () => {
    expect(() => realPort({}).start({})).toThrow();
    expect(() =>
      realPort({ container: { images: {} } } as unknown as Parameters<typeof realPort>[0]).start({}),
    ).toThrow();
  });
});

describe("CONV-07 fresh: one container per attempt", () => {
  it("a retry destroys, then starts a new container with a new jobId", async () => {
    const h = harness({ mode: "crash_once" });
    await begin(h);
    await drive(h);
    expect(derived(h)).toMatchObject({ status: "done", attempts: 2 });
    expect(h.posts.map((p) => p.jobId)).toEqual(["f1_v1_a1", "f1_v1_a2"]);
    expect(h.events.filter((e) => e.startsWith("container"))).toEqual([
      "container start",
      "container destroy",
      "container start",
      "container destroy",
    ]);
  });

  it("a stale runId is refused and does nothing", async () => {
    const h = harness();
    await begin(h);
    expect(await h.runner.cancel("other")).toBe("wrong_run");
    expect(await h.runner.check("other")).toBe("lost");
    expect((await record(h)).phase).toBe("admit");
  });

  it("a container that answers 409 is interrupted, retried once, then failed", async () => {
    const h = harness();
    h.respond = (path) =>
      path.startsWith("/job/input/") ? new Response('{"error":"already_started"}', { status: 409 }) : null;
    await begin(h);
    await drive(h);
    expect(derived(h)).toMatchObject({ status: "failed", error: "interrupted", attempts: 2 });
    expect(h.starts).toHaveLength(2);
  });

  it("an enqueue for another run is refused while a run is live; the same run is a no-op", async () => {
    const h = harness();
    await begin(h);
    const again = await h.runner.enqueue({ ...(await specOf(h)), runId: "run2" });
    expect(again).toBe("busy");
    expect(await h.runner.enqueue(await specOf(h))).toBe("duplicate");
  });
});

async function specOf(h: Harness) {
  const { specFor } = await import("./convert-harness.ts");
  return specFor(h);
}

describe("CONV-02 deadline", () => {
  it.each(["start", "health", "input", "run", "store", "publish"])(
    "checked on the %s alarm: destroys, releases, fails the row",
    async (phase) => {
      const h = harness();
      await begin(h);
      await stepTo(h, phase);
      const rec = await record(h);
      expect(rec.phase).toBe(phase);
      h.clock.t = (rec.deadline as number) + 1;
      h.store.alarmAt = h.clock.t;
      await h.runner.alarm();
      expect(derived(h)).toMatchObject({ status: "failed", error: "deadline" });
      expect(h.spend.released).toBe(1);
      expect(h.destroys).toBe(phase === "start" ? 0 : 1);
      expect(bundleKeys(h)).toEqual([]);
    },
  );

  it("the sweep's check expires a run past its deadline", async () => {
    const h = harness();
    await begin(h);
    await stepTo(h, "input");
    h.clock.t = ((await record(h)).deadline as number) + 5;
    expect(await h.runner.check(h.runId)).toBe("expired");
    expect(derived(h)).toMatchObject({ status: "failed", error: "deadline" });
  });
});

describe("CONV-02 release on every path", () => {
  it("a fault injected at each external call still ends with one balanced lease, no container and no strays", async () => {
    const clean = harness();
    await begin(clean);
    await drive(clean);
    const total = clean.calls;
    expect(total).toBeGreaterThan(40);
    for (let k = 1; k <= total; k++) {
      const h = harness();
      h.failAt = k;
      await begin(h);
      await drive(h);
      const row = derived(h);
      const where = `fault at call ${k}: ${clean.sites[k - 1]}`;
      expect(["done", "failed", "skipped"], where).toContain(row?.status);
      expect(h.spend.released, where).toBe(h.spend.acquired);
      expect(
        h.events.filter((e) => e === "container start"),
        where,
      ).toHaveLength(h.destroys);
      if (row?.status !== "done") expect(bundleKeys(h), where).toEqual([]);
    }
  }, 120_000);
});

describe("converter: errors are values", () => {
  it("a container fault is a code, never a throw", async () => {
    const h = harness();
    h.respond = (path) => (path === "/job/status" ? new Response("boom", { status: 500 }) : null);
    await begin(h);
    await drive(h);
    expect(h.thrown).toBe(0);
    expect(derived(h)).toMatchObject({ status: "failed", error: "interrupted" });
  });

  it("an unknown throw is counted: the seventh alarm gives up, and a retry gets a fresh count", async () => {
    const h = harness();
    h.bucket.head = async () => {
      throw new Error("boom");
    };
    await begin(h);
    await stepTo(h, "input");
    for (let i = 1; i <= 6; i++) {
      h.store.alarmAt = h.clock.t;
      await expect(h.runner.alarm()).rejects.toThrow("boom");
      expect((await record(h)).infraErrors).toBe(i);
    }
    h.store.alarmAt = h.clock.t;
    await h.runner.alarm();
    expect(await record(h)).toMatchObject({ attempt: 2, phase: "lease", infraErrors: 0 });
    await drive(h);
    expect(derived(h)).toMatchObject({ status: "failed", error: "interrupted" });
  });

  it("retryable codes get one new attempt; final codes get none", async () => {
    const retry = harness({ mode: "crash_once" });
    await begin(retry);
    await drive(retry);
    expect(retry.starts).toHaveLength(2);
    for (const mode of ["bomb", "timeout"]) {
      const h = harness({ mode });
      await begin(h);
      await drive(h);
      expect(derived(h)).toMatchObject({ status: "failed", error: mode, attempts: 1 });
      expect(h.starts).toHaveLength(1);
      expect(bundleKeys(h)).toEqual([]);
      expect(h.spend.released).toBe(1);
    }
  });
});

describe("converter: input in 64 MiB chunks", () => {
  const MIB = 1024 * 1024;

  it("sends 4 chunks an alarm, then starts the job with the size, hash and chunk count", async () => {
    const h = harness({ bytes: 300 * MIB, virtual: true });
    await begin(h);
    await stepTo(h, "input");
    let alarms = 0;
    while (((await record(h)).phase as string) === "input") {
      h.store.alarmAt = h.clock.t;
      await h.runner.alarm();
      alarms++;
      if (alarms === 1) expect(h.puts).toEqual([0, 1, 2, 3]);
    }
    expect(alarms).toBe(2);
    expect(h.puts).toEqual([0, 1, 2, 3, 4]);
    expect(h.posts).toEqual([{ jobId: "f1_v1_a1", ext: "pptx", size: 300 * MIB, sha256: "a".repeat(64), chunks: 5 }]);
  }, 60_000);

  it("a re-run after a fault resumes at the next unsent chunk", async () => {
    const h = harness({ bytes: 200 * MIB, virtual: true });
    const get = h.bucket.get.bind(h.bucket);
    let ranges = 0;
    h.bucket.get = async (key, options) => {
      if (options?.range && ++ranges === 3) throw new Error("R2 hiccup");
      return get(key, options);
    };
    await begin(h);
    await drive(h);
    expect(h.thrown).toBe(1);
    expect(h.puts).toEqual([0, 1, 2, 3]);
    expect(derived(h)).toMatchObject({ status: "done" });
  }, 60_000);

  it("a missing original is input_missing and a size that is not the row's is input_mismatch", async () => {
    const missing = harness();
    missing.bucket.objects.clear();
    await begin(missing);
    await drive(missing);
    expect(derived(missing)).toMatchObject({ status: "failed", error: "input_missing" });
    const wrong = harness();
    wrong.bucket.objects.set(wrong.w.originalKey, new Uint8Array(999));
    await begin(wrong);
    await drive(wrong);
    expect(derived(wrong)).toMatchObject({ status: "failed", error: "input_mismatch" });
  });

  it("a hash the container disagrees with is input_mismatch", async () => {
    const h = harness();
    h.respond = (path) => (path === "/job/start" ? new Response('{"error":"sha256_mismatch"}', { status: 422 }) : null);
    await begin(h);
    await drive(h);
    expect(derived(h)).toMatchObject({ status: "failed", error: "input_mismatch" });
  });

  it("computes the original's hash once when the row has none, and keeps it in outputs", async () => {
    const h = harness({ sha256: null });
    await begin(h);
    await drive(h);
    // the stub echoes the start body's hash into meta.json, so a computed hash is also the one meta must match
    expect(derived(h)).toMatchObject({ status: "done" });
    expect(h.posts[0]?.chunks).toBe(1);
    expect(JSON.parse(String(derived(h)?.outputs)).originalSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("converter: the record", () => {
  it("an unreadable record destroys the container, releases a readable lease and fails the row", async () => {
    const h = harness();
    await claimRun(h.w.db, { fileId: "f1", version: 1, ownerKind: "library", runId: "r9", now: 1 });
    await startAttempt(h.w.db, { fileId: "f1", version: 1, runId: "r9" }, 2);
    h.store.map.set(RECORD_KEY, { runId: "r9", fileId: "f1", version: 1, leaseId: "leaseX", junk: true });
    await h.runner.boot();
    expect(derived(h)).toMatchObject({ status: "failed", error: "internal" });
    expect(h.spend.calls).toContain("release:leaseX");
    expect(h.store.map.size).toBe(0);
  });

  it("a live job re-arms the inactivity stop to its deadline when the object wakes", async () => {
    const h = harness();
    await begin(h);
    await stepTo(h, "input");
    const deadline = (await record(h)).deadline as number;
    h.inactivity.length = 0;
    h.clock.t += 5000;
    await h.runner.boot();
    expect(h.inactivity).toEqual([deadline - h.clock.t]);
  });

  it("the cleanup alarm after the end deletes the record", async () => {
    const h = harness();
    await begin(h);
    await drive(h);
    expect(h.store.alarmAt).toBe(h.clock.t + 3_600_000);
    h.clock.t = h.store.alarmAt as number;
    await h.runner.alarm();
    expect(h.store.map.size).toBe(0);
  });
});

describe("CONV-12 cancel", () => {
  it("destroys the container, releases the lease and deletes what was written", async () => {
    const h = harness({ mode: "slow" });
    await begin(h);
    await stepTo(h, "run");
    await markCancelled(h.w.db, "f1", 1, h.clock.t);
    expect(await h.runner.cancel(h.runId)).toBe("cancelled");
    expect(derived(h)).toMatchObject({ status: "cancelled" });
    expect(h.destroys).toBe(1);
    expect(h.spend.released).toBe(1);
    expect(bundleKeys(h)).toEqual([]);
    expect(h.notify.terminal_).toEqual([{ state: "cancelled", code: null }]);
    expect(await h.runner.cancel(h.runId)).toBe("done");
    h.store.alarmAt = h.clock.t;
    await h.runner.alarm();
    expect(derived(h)).toMatchObject({ status: "cancelled" });
  });

  it("a put in flight when the cancel lands deletes its own key", async () => {
    const h = harness();
    await begin(h);
    h.bucket.afterRead = async (key) => {
      if (key.endsWith("/d/t.webp")) await h.runner.cancel(h.runId);
    };
    await drive(h);
    expect(derived(h)).toMatchObject({ status: "cancelled" });
    expect(bundleKeys(h)).toEqual([]);
    expect(h.destroys).toBe(1);
  });

  it("a file trashed mid-run ends the run as cancelled and stores nothing more", async () => {
    const h = harness();
    await begin(h);
    await stepTo(h, "store");
    h.w.db.raw.exec("UPDATE library_file SET trashed_at = 5");
    await drive(h);
    expect(derived(h)).toMatchObject({ status: "cancelled" });
    expect(bundleKeys(h)).toEqual([]);
  });
});

describe("CONV-11 queue", () => {
  it("a busy pool waits with jitter inside [retryAfter, retryAfter + 5 s] and shows 'waiting'", async () => {
    const h = harness();
    h.spend.busy = true;
    await begin(h);
    await stepTo(h, "lease");
    const before = h.clock.t;
    h.store.alarmAt = before;
    await h.runner.alarm();
    const wait = (h.store.alarmAt as number) - before;
    expect(wait).toBeGreaterThanOrEqual(20_000);
    expect(wait).toBeLessThanOrEqual(25_000);
    expect(derived(h)).toMatchObject({ status: "queued", stage: "waiting" });
  });

  it("gives up at 30 minutes with skipped busy and no container ever started", async () => {
    const h = harness();
    h.spend.busy = true;
    await begin(h);
    await drive(h);
    expect(derived(h)).toMatchObject({ status: "skipped", error: "busy", attempts: 0 });
    expect(h.clock.t - 1_000_000).toBeGreaterThan(30 * 60_000);
    expect(h.starts).toEqual([]);
    expect(h.spend.released).toBe(0);
  });

  it("a pool that frees up mid-wait lets the job run", async () => {
    const h = harness();
    h.spend.busy = true;
    await begin(h);
    await stepTo(h, "lease");
    h.store.alarmAt = h.clock.t;
    await h.runner.alarm();
    h.spend.busy = false;
    await drive(h);
    expect(derived(h)).toMatchObject({ status: "done" });
  });

  it("a daily container-seconds cap skips with daily_budget and frees the lease", async () => {
    const h = harness();
    h.spend.capHit = "container_seconds";
    await begin(h);
    await drive(h);
    expect(derived(h)).toMatchObject({ status: "skipped", error: "daily_budget" });
    expect(h.spend.released).toBe(1);
    expect(h.starts).toEqual([]);
  });
});

describe("conversion: gates and profiles", () => {
  it("off, account_only (guest, full profile), video off and the demo's no-video each skip without a container", async () => {
    const cases: [string, Parameters<typeof harness>[0], Partial<Harness["gates"]>][] = [
      ["off", {}, { convert: "off" }],
      ["off", {}, { mode: "off" }],
      ["account_only", { ownerKind: "guest" }, { convert: "account_only" }],
      ["video_off", { ext: "mov" }, { convertVideo: "off" }],
      ["video_off", { ext: "mov", profile: "demo" }, {}],
    ];
    for (const [code, opts, gates] of cases) {
      const h = harness(opts);
      Object.assign(h.gates, gates);
      await begin(h, opts);
      await drive(h);
      expect(derived(h), code).toMatchObject({ status: "skipped", error: code });
      expect(h.starts).toEqual([]);
    }
  });

  it("account_only still converts a demo drop and a library file", async () => {
    const demo = harness({ ownerKind: "guest", profile: "demo" });
    demo.gates.convert = "account_only";
    await begin(demo, { ownerKind: "guest", profile: "demo" });
    await drive(demo);
    expect(derived(demo)).toMatchObject({ status: "done" });
    expect(demo.spend.calls[0]).toBe("acquire:convert_public");
    expect(demo.starts[0]?.env).toMatchObject({ BLOOP_MAX_PAGES: "40", BLOOP_WIDTHS: "1920,480" });
    const lib = harness();
    lib.gates.convert = "account_only";
    await begin(lib);
    await drive(lib);
    expect(derived(lib)).toMatchObject({ status: "done" });
  });

  it("a guest file stores under its own prefix in the guest bucket", async () => {
    const h = harness({ ownerKind: "guest", profile: "demo" });
    await begin(h, { ownerKind: "guest", profile: "demo" });
    await drive(h);
    expect(h.guestBucket.keys("g/g1/").map((k) => k.slice("g/g1/".length))).toContain("n/notes.json");
    expect(h.guestBucket.keys("g/g1/").map((k) => k.slice("g/g1/".length))).toContain("d/s/1920.pack");
    expect(h.bucket.keys("g/")).toEqual([]);
  });

  it("demo truncation: 60 slides render 40, reported as total 60 and not a failure", async () => {
    const h = harness({ mode: "pages60", ownerKind: "guest", profile: "demo" });
    await begin(h, { ownerKind: "guest", profile: "demo" });
    await drive(h);
    expect(derived(h)).toMatchObject({ status: "done", pages: 40 });
    expect(JSON.parse(String(derived(h)?.outputs))).toMatchObject({ total: 60, rendered: 40 });
  });

  it("a full-profile deck of 301 pages is too_many_pages", async () => {
    const h = harness({ mode: "pages301" });
    await begin(h);
    await drive(h);
    expect(derived(h)).toMatchObject({ status: "failed", error: "too_many_pages" });
    expect(bundleKeys(h)).toEqual([]);
  });
});

describe("CONV-04 outputs: groups", () => {
  it("a bad page publishes the PDF only: no slide images, packs or slides.json are left", async () => {
    const h = harness({ mode: "bad_webp" });
    await begin(h);
    await drive(h);
    expect(derived(h)).toMatchObject({ status: "done" });
    expect(JSON.parse(String(derived(h)?.outputs)).groups).toEqual({
      slides: false,
      pdf: true,
      notes: true,
      media: false,
      image: false,
    });
    expect(bundleKeys(h)).toEqual([`${prefix}/d/doc.pdf`, `${prefix}/n/notes.json`]);
  });

  it("a file the manifest does not list fails the whole job", async () => {
    const h = harness({ mode: "extra_file" });
    await begin(h);
    await drive(h);
    expect(derived(h)).toMatchObject({ status: "failed", error: "output_invalid" });
    expect(bundleKeys(h)).toEqual([]);
  });

  it("a slow job runs to the end and is still done", async () => {
    const h = harness({ mode: "slow" });
    await begin(h);
    await drive(h);
    expect(derived(h)).toMatchObject({ status: "done" });
    expect(h.clock.t - 1_000_000).toBeGreaterThanOrEqual(180_000);
  });
});
