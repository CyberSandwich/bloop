import { describe, expect, it } from "vitest";
import { cancelConversion } from "../../src/worker/convert/cancel.ts";
import type { ConvertDeps } from "../../src/worker/convert/deps-types.ts";
import { notifierFor } from "../../src/worker/convert/notify.ts";
import { claimRun, markFailed, startAttempt } from "../../src/worker/convert/results.ts";
import { QUEUE_CAPS, type StartRequest, startConversion } from "../../src/worker/convert/start.ts";
import { STALE_AFTER_MS, sweepConversions } from "../../src/worker/convert/sweep.ts";
import { RECORD_KEY } from "../../src/worker/do/converter-schema.ts";
import { begin, derived, drive, type Harness, harness, stepTo } from "./convert-harness.ts";
import { addGuest } from "./convert-world.ts";

let runs = 0;
const depsFor = (h: Harness, over: Partial<ConvertDeps> = {}): ConvertDeps => ({
  db: h.w.db,
  spend: h.spend,
  converter: () => h.runner,
  gates: async () => h.gates,
  leaseMaxSeconds: 1800,
  now: () => h.clock.t,
  newRunId: () => `run${++runs}`,
  log: () => undefined,
  ...over,
});

const libraryReq = (h: Harness, over: Partial<StartRequest> = {}): StartRequest => ({
  ownerKind: "library",
  fileId: h.w.fileId,
  version: 1,
  profile: "full",
  scope: h.w.userId,
  target: { kind: "library", userId: h.w.userId },
  ...over,
});
const guestReq = (over: Partial<StartRequest> = {}): StartRequest => ({
  ownerKind: "guest",
  fileId: "g1",
  version: 1,
  profile: "demo",
  scope: "iphash",
  target: { kind: "guest", screenRef: "screen1" },
  ...over,
});

const liveRow = (h: Harness, fileId: string, runId: string, ownerKind = "library") =>
  h.w.db.raw
    .prepare(
      "INSERT INTO derived (file_id, version, owner_kind, status, attempts, run_id, created_at, updated_at) VALUES (?, 1, ?, 'queued', 0, ?, 0, ?)",
    )
    .run(fileId, ownerKind, runId, 0);

describe("startConversion", () => {
  it("claims the version, takes the per-day meter for the user, and the Converter runs it to done", async () => {
    const h = harness();
    const result = await startConversion(depsFor(h), libraryReq(h));
    expect(result).toEqual({ state: "queued" });
    expect(h.spend.calls).toEqual(["take:convert_user"]);
    await drive(h);
    expect(derived(h)).toMatchObject({ status: "done" });
  });

  it("convert: probe account converts under account_only", async () => {
    const h = harness();
    h.gates.convert = "account_only";
    expect(await startConversion(depsFor(h), libraryReq(h))).toEqual({ state: "queued" });
    await drive(h);
    expect(derived(h)).toMatchObject({ status: "done" });
    expect(h.spend.calls).toEqual([
      "take:convert_user",
      "acquire:convert",
      "take:container_seconds",
      "release:lease1",
      "refund:container_seconds",
      "record:conversion_done",
    ]);
  });

  it("CONVERT_MODE off writes no row and starts nothing", async () => {
    const h = harness();
    h.gates.mode = "off";
    expect(await startConversion(depsFor(h), libraryReq(h))).toEqual({ state: "skipped", code: "off" });
    expect(derived(h)).toBeUndefined();
    expect(h.spend.calls).toEqual([]);
  });

  it("a file that is gone, trashed or whose owner is purging writes no row", async () => {
    const h = harness();
    expect(await startConversion(depsFor(h), libraryReq(h, { fileId: "nope" }))).toEqual({
      state: "skipped",
      code: "gone",
    });
    h.w.db.raw.exec("UPDATE library_file SET trashed_at = 1");
    expect(await startConversion(depsFor(h), libraryReq(h))).toEqual({ state: "skipped", code: "gone" });
    expect(derived(h)).toBeUndefined();
  });

  type RowOpts = { ext?: string; ownerKind?: "guest"; profile?: "demo" };
  it.each<[string, Record<string, string>, RowOpts]>([
    ["off", { convert: "off" }, {}],
    ["account_only", { convert: "account_only" }, { ownerKind: "guest" as const }],
    ["video_off", { convertVideo: "off" }, { ext: "mov" }],
    ["video_off", {}, { ext: "mov", ownerKind: "guest" as const, profile: "demo" as const }],
    ["unsupported", {}, { ext: "exe" }],
  ])("%s is a row and a refusal that costs nothing", async (code, gates, opts) => {
    const h = harness(opts);
    Object.assign(h.gates, gates);
    const guest = opts.ownerKind === "guest";
    const req = guest ? guestReq({ profile: opts.profile ?? "full" }) : libraryReq(h);
    expect(await startConversion(depsFor(h), req)).toEqual({ state: "skipped", code });
    expect(derived(h)).toMatchObject({ status: code === "unsupported" ? "failed" : "skipped", error: code });
    expect(h.spend.calls).toEqual([]);
    expect(h.starts).toEqual([]);
  });

  it("a deck too large for the lease is refused as too_large, final", async () => {
    const h = harness({ bytes: 5_000_000_000 });
    expect(await startConversion(depsFor(h), libraryReq(h))).toEqual({ state: "skipped", code: "too_large" });
    expect(derived(h)).toMatchObject({ status: "failed", error: "too_large" });
  });

  it("the 21st conversion of the day is daily_limit, with a row that a later start can claim", async () => {
    const h = harness();
    h.spend.capHit = "convert_user";
    expect(await startConversion(depsFor(h), libraryReq(h))).toMatchObject({ state: "skipped", code: "daily_limit" });
    expect(derived(h)).toMatchObject({ status: "skipped", error: "daily_limit" });
    h.spend.capHit = null;
    expect(await startConversion(depsFor(h), libraryReq(h))).toEqual({ state: "queued" });
  });

  it("an unreachable guard fails closed: busy", async () => {
    const h = harness();
    h.spend.take = async () => ({ ok: false, reason: "unavailable", retryAfterSeconds: 30 });
    expect(await startConversion(depsFor(h), libraryReq(h))).toMatchObject({ state: "skipped", code: "busy" });
    expect(derived(h)).toMatchObject({ status: "skipped", error: "busy" });
  });

  it("CONV-11 queue: the caps return queue_full for a user, for the public and overall", async () => {
    const h = harness();
    for (let i = 0; i < QUEUE_CAPS.user; i++) {
      h.w.db.raw
        .prepare(
          "INSERT INTO library_file (id, user_id, name, ext, bytes, version, r2_key, status, created_at, updated_at) VALUES (?, ?, 'x.pptx', 'pptx', 1, 1, ?, 'ready', 0, 0)",
        )
        .run(`other${i}`, h.w.userId, `u/u1/other${i}/v1/orig`);
      liveRow(h, `other${i}`, `r${i}`);
    }
    expect(await startConversion(depsFor(h), libraryReq(h))).toEqual({ state: "skipped", code: "queue_full" });
    expect(h.spend.calls).toEqual([]);

    const g = harness({ ownerKind: "guest", profile: "demo" });
    for (let i = 0; i < QUEUE_CAPS.public; i++) liveRow(g, `guest${i}`, `gr${i}`, "guest");
    expect(await startConversion(depsFor(g), guestReq())).toEqual({ state: "skipped", code: "queue_full" });

    const all = harness();
    for (let i = 0; i < QUEUE_CAPS.all; i++) liveRow(all, `x${i}`, `ar${i}`, "guest");
    expect(await startConversion(depsFor(all), libraryReq(all))).toEqual({ state: "skipped", code: "queue_full" });
  });

  it("CONV-08 claim: concurrent starts of one version have one winner, and a final failure is never started again", async () => {
    const h = harness();
    const results = await Promise.all(Array.from({ length: 5 }, () => startConversion(depsFor(h), libraryReq(h))));
    expect(results.filter((r) => r.state === "queued")).toHaveLength(1);
    expect(results.filter((r) => r.state === "exists")).toHaveLength(4);
    expect(h.spend.calls).toEqual(["take:convert_user"]);

    const bomb = harness({ mode: "bomb" });
    await startConversion(depsFor(bomb), libraryReq(bomb));
    await drive(bomb);
    expect(derived(bomb)).toMatchObject({ status: "failed", error: "bomb" });
    expect(await startConversion(depsFor(bomb), libraryReq(bomb))).toEqual({ state: "exists" });
    expect(bomb.starts).toHaveLength(1);
  });

  it("CONV-08 claim: a skipped or cancelled version can be started again and a done one cannot", async () => {
    const h = harness();
    h.gates.convert = "off";
    await startConversion(depsFor(h), libraryReq(h));
    h.gates.convert = "on";
    expect(await startConversion(depsFor(h), libraryReq(h))).toEqual({ state: "queued" });
    await cancelConversion(depsFor(h), h.w.fileId, 1, "trash");
    expect(await startConversion(depsFor(h), libraryReq(h))).toEqual({ state: "queued" });
    await drive(h);
    expect(await startConversion(depsFor(h), libraryReq(h))).toEqual({ state: "exists" });
  });

  it("uses the guest and demo meters, the public pool, and the guest's scope", async () => {
    const g = harness({ ownerKind: "guest", profile: "demo" });
    await startConversion(depsFor(g), guestReq());
    expect(g.spend.calls).toEqual(["take:convert_demo"]);
    const full = harness({ ownerKind: "guest" });
    full.gates.convert = "on";
    await startConversion(depsFor(full), guestReq({ profile: "full" }));
    expect(full.spend.calls).toEqual(["take:convert_guest"]);
  });

  it("never throws: a Converter that refuses the run leaves a skipped busy row", async () => {
    const h = harness();
    const result = await startConversion(
      depsFor(h, {
        converter: () => ({
          enqueue: async () => {
            throw new Error("down");
          },
          cancel: async () => "done",
          check: async () => "lost",
        }),
      }),
      libraryReq(h),
    );
    expect(result).toEqual({ state: "skipped", code: "busy" });
    expect(derived(h)).toMatchObject({ status: "skipped", error: "busy" });
    const broken = await startConversion(
      depsFor(h, {
        db: {
          prepare: () => {
            throw new Error("d1 down");
          },
        },
      }),
      libraryReq(h),
    );
    expect(broken).toEqual({ state: "skipped", code: "busy" });
  });
});

describe("CONV-12 cancel: cancelConversion", () => {
  it("marks the row, then ends the Converter's run: container, lease and keys", async () => {
    const h = harness({ mode: "slow" });
    await startConversion(depsFor(h), libraryReq(h));
    await stepTo(h, "run");
    await cancelConversion(depsFor(h), h.w.fileId, 1, "trash");
    expect(derived(h)).toMatchObject({ status: "cancelled" });
    expect(h.destroys).toBe(1);
    expect(h.spend.released).toBe(1);
    expect(((await h.store.get(RECORD_KEY)) as { phase: string }).phase).toBe("done");
    await cancelConversion(depsFor(h), h.w.fileId, 1, "trash");
    expect(h.destroys).toBe(1);
  });

  it("with nothing live it does nothing, and an unreachable Converter is logged, not thrown", async () => {
    const h = harness();
    await cancelConversion(depsFor(h), h.w.fileId, 1, "trash");
    expect(derived(h)).toBeUndefined();
    await begin(h);
    const logged: string[] = [];
    await cancelConversion(
      depsFor(h, {
        log: (l) => void logged.push(l),
        converter: () => ({
          enqueue: async () => "queued",
          cancel: async () => {
            throw new Error("down");
          },
          check: async () => "live",
        }),
      }),
      h.w.fileId,
      1,
      "purge",
    );
    expect(derived(h)).toMatchObject({ status: "cancelled" });
    expect(logged[0]).toContain("convert_cancel_failed");
  });

  it("a Converter that outlives a lost cancel ends itself the next time the row refuses it", async () => {
    const h = harness({ mode: "slow" });
    await begin(h);
    await stepTo(h, "run");
    h.w.db.raw.exec("UPDATE derived SET status = 'cancelled'");
    await drive(h);
    expect(h.destroys).toBe(1);
    expect(h.spend.released).toBe(1);
    expect(derived(h)).toMatchObject({ status: "cancelled" });
  });
});

describe("CONV-09 sweep", () => {
  const stale = (h: Harness) => {
    h.clock.t += STALE_AFTER_MS + 1;
  };

  it("a stale row whose Converter has no record is failed interrupted", async () => {
    const h = harness();
    await claimRun(h.w.db, { fileId: "f1", version: 1, ownerKind: "library", runId: "gone", now: h.clock.t });
    await startAttempt(h.w.db, { fileId: "f1", version: 1, runId: "gone" }, h.clock.t);
    stale(h);
    expect(await sweepConversions(depsFor(h))).toMatchObject({ checked: 1, lost: 1 });
    expect(derived(h)).toMatchObject({ status: "failed", error: "interrupted" });
  });

  it("a Converter with no alarm is re-armed and the run then finishes", async () => {
    const h = harness();
    await begin(h);
    await stepTo(h, "input");
    h.store.alarmAt = null;
    stale(h);
    expect(await sweepConversions(depsFor(h))).toMatchObject({ rearmed: 1 });
    expect(h.store.alarmAt).not.toBeNull();
    await drive(h);
    expect(derived(h)).toMatchObject({ status: "done" });
  });

  it("a run past its deadline is expired: container destroyed, lease released", async () => {
    const h = harness();
    await begin(h);
    await stepTo(h, "input");
    h.clock.t = ((await h.store.get(RECORD_KEY)) as { deadline: number }).deadline + STALE_AFTER_MS;
    expect(await sweepConversions(depsFor(h))).toMatchObject({ expired: 1 });
    expect(derived(h)).toMatchObject({ status: "failed", error: "deadline" });
    expect(h.destroys).toBe(1);
    expect(h.spend.released).toBe(1);
  });

  it("leaves fresh rows and finished rows alone and never sets queued", async () => {
    const h = harness();
    await begin(h);
    expect(await sweepConversions(depsFor(h))).toEqual({ checked: 0, lost: 0, expired: 0, rearmed: 0 });
    await drive(h);
    await markFailed(h.w.db, { fileId: "f1", version: 1, runId: h.runId }, "bomb", 0);
    stale(h);
    expect(await sweepConversions(depsFor(h))).toMatchObject({ checked: 0 });
    expect(derived(h)).toMatchObject({ status: "done" });
    const g = harness();
    g.gates.convert = "off";
    await startConversion(depsFor(g), libraryReq(g));
    stale(g);
    await sweepConversions(depsFor(g));
    expect(derived(g)).toMatchObject({ status: "skipped" });
  });
});

describe("notify", () => {
  const ns = (calls: unknown[][], receiver: object) => ({
    idFromName: (n: string) => n,
    get: (id: string) => ({ ...receiver, id, calls }),
  });

  type Space = { get(id: string): unknown; idFromName(n: string): string };
  const receiverOf =
    (env: { USER_LIBRARY: Space; SCREEN: Space }) =>
    (t: { kind: "library"; userId: string } | { kind: "guest"; screenRef: string }) => {
      const space = t.kind === "library" ? env.USER_LIBRARY : env.SCREEN;
      return space.get(space.idFromName(t.kind === "library" ? t.userId : t.screenRef));
    };

  it("sends progress to the user's library and the end to its derived handlers; guests hear on the screen", async () => {
    const calls: unknown[][] = [];
    const library =
      (name: string) =>
      async (...args: unknown[]) =>
        void calls.push(["library", name, ...args]);
    const screen = async (...args: unknown[]) => void calls.push(["screen", ...args]);
    const env = {
      PUBLIC_ORIGIN: "http://127.0.0.1:8787",
      USER_LIBRARY: ns(calls, {
        progress: library("progress"),
        pageReady: library("pageReady"),
        derivedReady: library("derivedReady"),
        derivedFailed: library("derivedFailed"),
      }),
      SCREEN: ns(calls, { derivedReady: screen }),
    };
    const n = notifierFor(receiverOf(env));
    const me = { kind: "library", userId: "u1" } as const;
    await n.progress(me, "f1", 1, "rasterize", 3, 40);
    await n.pageReady(me, "f1", 1);
    await n.terminal(me, "f1", 1, "done", null);
    await n.terminal(me, "f1", 1, "failed", "bomb");
    await n.terminal({ kind: "guest", screenRef: "s1" }, "g1", 1, "done", null);
    expect(calls).toEqual([
      ["library", "progress", "f1", 1, "rasterize", 3, 40],
      ["library", "pageReady", "f1", 1, 1],
      ["library", "derivedReady", "f1", 1, "done", null],
      ["library", "derivedFailed", "f1", 1, "failed", "bomb"],
      ["screen", "g1", 1, "done", null],
    ]);
  });

  it("a receiver that throws is logged once and the conversion carries on", async () => {
    const logged: string[] = [];
    const env = {
      PUBLIC_ORIGIN: "http://127.0.0.1:8787",
      USER_LIBRARY: ns([], {
        progress: async () => {
          throw new Error("no such method");
        },
      }),
      SCREEN: ns([], {}),
    };
    const n = notifierFor(receiverOf(env), (l) => void logged.push(l));
    const me = { kind: "library", userId: "u1" } as const;
    await n.progress(me, "f1", 1, "convert", null, null);
    await n.progress(me, "f1", 1, "convert", null, null);
    expect(logged.length).toBeLessThanOrEqual(1);
    expect(logged.every((l) => l.includes("convert_notify_missing"))).toBe(true);
  });
});

describe("guest rows", () => {
  it("a guest file's start claims under the session id", async () => {
    const h = harness();
    addGuest(h.w.db, "g2");
    expect(await startConversion(depsFor(h), guestReq({ fileId: "g2" }))).toEqual({ state: "queued" });
    expect(h.w.db.raw.prepare("SELECT owner_kind FROM derived WHERE file_id = 'g2'").get()).toEqual({
      owner_kind: "guest",
    });
  });
});
