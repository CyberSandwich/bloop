import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/worker/config.ts";
import {
  abortLibrary,
  completeLibrary,
  confirmPart,
  createLibrary,
  type Deps,
  type Presigner,
  putPart,
  stateOf,
  urlsFor,
} from "../../src/worker/uploads/pipeline.ts";
import * as store from "../../src/worker/uploads/store.ts";
import { sweepUploads } from "../../src/worker/uploads/sweep.ts";
import { PROD_VARS } from "../env-vars.ts";
import { validDeck, validJpeg, validPdf } from "../zip-builder.ts";
import { addUser, testDb } from "./d1-shim.ts";
import { fakeMultipart } from "./fake-multipart.ts";
import { fakeSpend } from "./spend-helpers.ts";

const parsed = parseConfig({ ...PROD_VARS });
if (!parsed.ok) throw new Error(parsed.problems.join());
const FINGERPRINT = "a".repeat(64);
const refusedSpend = {
  ok: false,
  reason: "cap_hit",
  meter: "upload_user_bytes",
  period: "day",
  scope: "own",
  retryAfterSeconds: 7,
} as const;
const baseConfig = parsed.config;

const streamOf = (bytes: Uint8Array) => new Blob([Buffer.from(bytes)]).stream() as ReadableStream<Uint8Array>;

function rig(partBytes: number, spendOverrides: Parameters<typeof fakeSpend>[0] = {}, presigner?: Presigner) {
  const db = testDb();
  addUser(db, "u1");
  addUser(db, "u2");
  const mp = fakeMultipart();
  const spend = fakeSpend(spendOverrides);
  const clock = { now: 1_000_000_000 };
  const config = {
    ...baseConfig,
    library: { ...baseConfig.library, partBytes, uploadMode: presigner ? ("direct" as const) : ("proxy" as const) },
  };
  const d: Deps = { db, mp, spend, config, now: () => clock.now, ...(presigner ? { presigner } : {}) };
  const counters = (id = "u1") =>
    db.raw.prepare("SELECT used_bytes AS used, reserved_bytes AS reserved FROM app_user WHERE id = ?").get(id) as {
      used: number;
      reserved: number;
    };
  return { db, mp, spend, clock, d, counters };
}

const slice = (bytes: Uint8Array, partBytes: number, n: number) => bytes.subarray((n - 1) * partBytes, n * partBytes);

/** Creates an upload of `bytes` under `name` and returns the row. */
async function started(r: ReturnType<typeof rig>, bytes: Uint8Array, name = "Deck.pptx", fingerprint = FINGERPRINT) {
  const made = await createLibrary(r.d, "u1", { name, bytes: bytes.length, fingerprint, idemKey: null });
  if (!made.ok) throw new Error(`create refused: ${JSON.stringify(made.error)}`);
  const row = await store.get(r.d.db, made.value.answer.uploadId);
  if (!row) throw new Error("no row");
  return { row, answer: made.value.answer, created: made.value.created };
}

async function storeAll(r: ReturnType<typeof rig>, row: store.UploadRow, bytes: Uint8Array) {
  for (let n = 1; n <= row.parts; n++) {
    const part = slice(bytes, row.partBytes, n);
    const out = await putPart(r.d, row, n, streamOf(part), part.length);
    if (!out.ok) throw new Error(`part ${n} refused: ${JSON.stringify(out.error)}`);
  }
}

const DECK = validDeck();
const PART = Math.ceil(DECK.length / 3);
const signer: Presigner = {
  part: async (row, n, bytes) => ({
    url: `https://r2.example/${row.r2Key}?partNumber=${n}&len=${bytes}`,
    expiresAt: 1,
  }),
};

describe("the library upload, end to end through the pipeline", () => {
  it("creates, stores three parts, completes and leaves a ready file with its digests", async () => {
    const r = rig(PART);
    const { row, answer, created } = await started(r, DECK);
    expect(created).toBe(true);
    expect(answer).toMatchObject({ parts: 3, partBytes: PART, mode: "proxy", done: [] });
    expect(answer.urls.map((u) => u.url)).toEqual([1, 2, 3].map((n) => `/api/uploads/${row.id}/parts/${n}`));
    expect(r.counters()).toEqual({ used: 0, reserved: DECK.length });

    await storeAll(r, row, DECK);
    const done = await completeLibrary(r.d, row);
    expect(done).toMatchObject({ ok: true, value: { state: "ready" } });
    expect(r.counters()).toEqual({ used: DECK.length, reserved: 0 });
    const file = r.db.raw.prepare("SELECT status, ext, sha256, crc32, r2_key AS key FROM library_file").get() as {
      status: string;
      ext: string;
      sha256: string;
      crc32: number;
      key: string;
    };
    expect(file).toMatchObject({ status: "ready", ext: "pptx", key: row.r2Key });
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.mp.objects.get(row.r2Key)).toEqual(DECK);
  });

  it("carries the last part on complete in direct mode (O5) and a repeat of complete answers the settled file", async () => {
    const r = rig(PART, {}, signer);
    const { row } = await started(r, DECK);
    for (const n of [1, 2]) {
      const part = slice(DECK, PART, n);
      const etag = await r.mp.part(row.r2Key, row.r2UploadId, n, streamOf(part), part.length);
      await confirmPart(r.d, row, n, etag, part.length);
    }
    const last = slice(DECK, PART, 3);
    const stored = await r.mp.part(row.r2Key, row.r2UploadId, 3, streamOf(last), last.length);
    const first = await completeLibrary(r.d, row, { n: 3, etag: stored, bytes: last.length });
    expect(first).toMatchObject({ ok: true, value: { state: "ready" } });
    const again = await completeLibrary(r.d, (await store.get(r.db, row.id)) as store.UploadRow);
    expect(again).toMatchObject({ ok: true, value: { state: "ready" } });
    expect(r.counters()).toEqual({ used: DECK.length, reserved: 0 });
  });

  it("resumes the open upload of the same file: no second R2 upload, no take, the stored parts listed", async () => {
    const r = rig(PART);
    const { row } = await started(r, DECK);
    await putPart(r.d, row, 1, streamOf(slice(DECK, PART, 1)), PART);
    const takes = r.spend.calls.filter((c) => c.method === "take").length;
    const again = await createLibrary(r.d, "u1", {
      name: "Deck.pptx",
      bytes: DECK.length,
      fingerprint: FINGERPRINT,
      idemKey: null,
    });
    expect(again).toMatchObject({ ok: true, value: { created: false, answer: { uploadId: row.id, done: [1] } } });
    expect(r.mp.calls.filter((c) => c.startsWith("create"))).toHaveLength(1);
    expect(r.spend.calls.filter((c) => c.method === "take")).toHaveLength(takes);
    expect(r.counters().reserved).toBe(DECK.length);
  });
});

describe("UP-01 scope: one URL, one part", () => {
  const presigner: Presigner = {
    part: async (row, n, bytes) => ({
      url: `https://r2.example/${row.r2Key}?partNumber=${n}&len=${bytes}`,
      expiresAt: 1,
    }),
  };

  it("UP-01 scope: a direct URL names one part of one key and is minted only for a pending part", async () => {
    const r = rig(PART, {}, presigner);
    const { row, answer } = await started(r, DECK);
    expect(answer.mode).toBe("direct");
    expect(answer.urls.map((u) => u.n)).toEqual([1, 2, 3]);
    for (const u of answer.urls) {
      expect(u.url).toContain(`${row.r2Key}?partNumber=${u.n}&len=`);
    }
    await confirmPart(r.d, row, 2, `"${"b".repeat(32)}"`, PART);
    const wanted = await urlsFor(r.d, row, [1, 2]);
    expect(wanted).toMatchObject({ ok: true });
    expect(wanted.ok && wanted.value.map((u) => u.n)).toEqual([1]);
  });

  it("UP-01 scope: a part outside the upload is refused and a closed upload mints nothing", async () => {
    const r = rig(PART, {}, presigner);
    const { row } = await started(r, DECK);
    expect(await urlsFor(r.d, row, [4])).toMatchObject({ ok: false, error: "bad_request" });
    expect(await urlsFor(r.d, row, [0])).toMatchObject({ ok: false, error: "bad_request" });
    await abortLibrary(r.d, row);
    expect(await urlsFor(r.d, (await store.get(r.db, row.id)) as store.UploadRow, [1])).toMatchObject({
      ok: false,
      error: "upload_gone",
    });
  });

  it("UP-01 scope: URL mints are capped at three per part, then refused", async () => {
    const r = rig(PART, {}, presigner);
    const { row } = await started(r, DECK);
    const budget = row.parts * store.MINTS_PER_PART;
    expect((await store.get(r.db, row.id))?.mints).toBe(3);
    let minted = 3;
    while (minted + 1 <= budget) {
      expect(await urlsFor(r.d, row, [1])).toMatchObject({ ok: true });
      minted += 1;
    }
    expect(await urlsFor(r.d, row, [1])).toMatchObject({ ok: false, error: "rate_limited" });
  });
});

describe("UP-02 size: the declared size is the bound", () => {
  it("UP-02 size: a file over the cap, or over 10000 parts, is refused before anything is written", async () => {
    const r = rig(1);
    const huge = await createLibrary(r.d, "u1", {
      name: "a.pptx",
      bytes: 10_001,
      fingerprint: FINGERPRINT,
      idemKey: null,
    });
    expect(huge).toMatchObject({ ok: false, error: "too_large" });
    const over = await createLibrary(r.d, "u1", {
      name: "a.pptx",
      bytes: r.d.config.library.maxFileBytes + 1,
      fingerprint: FINGERPRINT,
      idemKey: null,
    });
    expect(over).toMatchObject({ ok: false, error: "too_large" });
    expect(r.mp.calls).toEqual([]);
    expect(r.db.raw.prepare("SELECT count(*) AS n FROM upload").get()).toEqual({ n: 0 });
  });

  it("UP-02 size: a part of the wrong length is refused and nothing is recorded", async () => {
    const r = rig(PART);
    const { row } = await started(r, DECK);
    const short = slice(DECK, PART, 1).subarray(1);
    expect(await putPart(r.d, row, 1, streamOf(short), short.length)).toMatchObject({
      ok: false,
      error: "bad_request",
    });
    expect(await putPart(r.d, row, 9, streamOf(short), PART)).toMatchObject({ ok: false, error: "bad_request" });
    expect(await store.doneParts(r.db, row.id)).toEqual([]);
  });

  it("UP-02 size: a stored object whose size differs from the declared one is refused at complete and released", async () => {
    const r = rig(PART);
    const { row } = await started(r, DECK);
    await storeAll(r, row, DECK);
    const real = r.mp.head;
    r.mp.head = async (key) => ({ size: ((await real(key))?.size ?? 0) + 1 });
    expect(await completeLibrary(r.d, row)).toMatchObject({ ok: false, error: "size_mismatch" });
    expect(r.counters()).toEqual({ used: 0, reserved: 0 });
    expect(r.mp.objects.has(row.r2Key)).toBe(false);
  });
});

describe("UP-05 type: the stored type is the validated one", () => {
  it("UP-05 type: a .pptx name over PDF bytes is refused, the reservation and the object go", async () => {
    const r = rig(1000);
    const pdf = validPdf();
    const { row } = await started(r, pdf, "Deck.pptx");
    await storeAll(r, row, pdf);
    const out = await completeLibrary(r.d, row);
    expect(out).toMatchObject({ ok: true, value: { state: "refused" } });
    expect(r.counters()).toEqual({ used: 0, reserved: 0 });
    expect(r.mp.objects.has(row.r2Key)).toBe(false);
    expect(r.db.raw.prepare("SELECT status, refusal FROM library_file").get()).toMatchObject({ status: "refused" });
  });

  it("UP-05 type: a .jpeg name stores the validated type jpg", async () => {
    const r = rig(1000);
    const jpg = validJpeg();
    const { row } = await started(r, jpg, "photo.jpeg");
    await storeAll(r, row, jpg);
    expect(await completeLibrary(r.d, row)).toMatchObject({ ok: true, value: { state: "ready" } });
    expect(r.db.raw.prepare("SELECT ext FROM library_file").get()).toEqual({ ext: "jpg" });
  });

  it("UP-05 type: a name with no known extension is refused at create", async () => {
    const r = rig(1000);
    expect(
      await createLibrary(r.d, "u1", { name: "run.exe", bytes: 10, fingerprint: FINGERPRINT, idemKey: null }),
    ).toMatchObject({
      ok: false,
      error: "bad_type",
    });
  });
});

describe("UP-08 resume: the part list comes from D1", () => {
  it("UP-08 resume: a forged ETag for the last part fails R2's join and gives the reservation back", async () => {
    const r = rig(PART, {}, signer);
    const { row } = await started(r, DECK);
    for (const n of [1, 2]) {
      const part = slice(DECK, PART, n);
      const etag = await r.mp.part(row.r2Key, row.r2UploadId, n, streamOf(part), part.length);
      await confirmPart(r.d, row, n, etag, part.length);
    }
    const last = slice(DECK, PART, 3);
    const out = await completeLibrary(r.d, row, { n: 3, etag: `"${"f".repeat(32)}"`, bytes: last.length });
    expect(out).toMatchObject({ ok: false });
    expect(r.counters()).toEqual({ used: 0, reserved: 0 });
  });

  it("UP-08 resume: complete with parts missing refuses, keeps the upload and frees the claim for a retry", async () => {
    const r = rig(PART);
    const { row } = await started(r, DECK);
    await putPart(r.d, row, 1, streamOf(slice(DECK, PART, 1)), PART);
    expect(await completeLibrary(r.d, row)).toMatchObject({ ok: false, error: "bad_request" });
    const current = (await store.get(r.db, row.id)) as store.UploadRow;
    expect(current.completingAt).toBeNull();
    expect(r.counters().reserved).toBe(DECK.length);
    await putPart(r.d, current, 2, streamOf(slice(DECK, PART, 2)), PART);
    await putPart(r.d, current, 3, streamOf(slice(DECK, PART, 3)), DECK.length - 2 * PART);
    expect(await completeLibrary(r.d, current)).toMatchObject({ ok: true, value: { state: "ready" } });
  });
});

describe("UP-04 abort: a cancel returns everything", () => {
  it("UP-04 abort: cancel aborts the multipart, returns the reservation and repeats as a no-op", async () => {
    const r = rig(PART);
    const { row } = await started(r, DECK);
    await putPart(r.d, row, 1, streamOf(slice(DECK, PART, 1)), PART);
    expect(await abortLibrary(r.d, row)).toMatchObject({ ok: true });
    expect(r.counters()).toEqual({ used: 0, reserved: 0 });
    expect(r.mp.open.size).toBe(0);
    const closed = (await store.get(r.db, row.id)) as store.UploadRow;
    expect(await abortLibrary(r.d, closed)).toMatchObject({ ok: true });
    expect(r.counters()).toEqual({ used: 0, reserved: 0 });
  });

  it("UP-04 abort: a cancel during a fresh complete claim is refused", async () => {
    const r = rig(PART);
    const { row } = await started(r, DECK);
    await store.claim(r.db, row.id, r.clock.now);
    expect(await abortLibrary(r.d, row)).toMatchObject({ ok: false, error: "upload_busy" });
    expect(r.counters().reserved).toBe(DECK.length);
  });

  it("UP-04 abort: a second complete while one holds the claim answers upload_busy and changes nothing", async () => {
    const r = rig(PART);
    const { row } = await started(r, DECK);
    await storeAll(r, row, DECK);
    await store.claim(r.db, row.id, r.clock.now);
    expect(await completeLibrary(r.d, row)).toMatchObject({ ok: false, error: "upload_busy" });
    expect(r.counters()).toEqual({ used: 0, reserved: DECK.length });
  });
});

describe("W10: a refused request leaves no row, no R2 call and no kept take", () => {
  it("W10: a create over the quota reserves nothing and calls nothing", async () => {
    const r = rig(PART);
    r.db.raw.prepare("UPDATE app_user SET quota_bytes = 10 WHERE id = 'u1'").run();
    expect(
      await createLibrary(r.d, "u1", {
        name: "Deck.pptx",
        bytes: DECK.length,
        fingerprint: FINGERPRINT,
        idemKey: null,
      }),
    ).toMatchObject({
      ok: false,
      error: "quota_exceeded",
    });
    expect(r.mp.calls).toEqual([]);
    expect(r.spend.calls).toEqual([]);
    expect(r.db.raw.prepare("SELECT count(*) AS n FROM upload").get()).toEqual({ n: 0 });
  });

  it("W10: a spend refusal on the count take refunds the bytes take and writes nothing", async () => {
    let takes = 0;
    const r = rig(PART, {
      take: (async (meter: string, n: number) => {
        takes += 1;
        return takes === 2 ? refusedSpend : { ok: true, ticket: { id: `t${takes}`, meter, n } };
      }) as never,
    });
    expect(
      await createLibrary(r.d, "u1", {
        name: "Deck.pptx",
        bytes: DECK.length,
        fingerprint: FINGERPRINT,
        idemKey: null,
      }),
    ).toMatchObject({
      ok: false,
      error: "rate_limited",
      retryAfter: 7,
    });
    expect(r.spend.calls.filter((c) => c.method === "refund")).toHaveLength(1);
    expect(r.mp.calls).toEqual([]);
    expect(r.db.raw.prepare("SELECT count(*) AS n FROM upload WHERE aborted_at IS NULL").get()).toEqual({ n: 0 });
    expect(r.counters()).toEqual({ used: 0, reserved: 0 });
  });

  it("W10: an R2 failure at create refunds both takes and writes nothing", async () => {
    const r = rig(PART);
    r.mp.failNext("create");
    expect(
      await createLibrary(r.d, "u1", {
        name: "Deck.pptx",
        bytes: DECK.length,
        fingerprint: FINGERPRINT,
        idemKey: null,
      }),
    ).toMatchObject({
      ok: false,
      error: "internal",
    });
    expect(r.spend.calls.filter((c) => c.method === "refund")).toHaveLength(2);
    expect(r.db.raw.prepare("SELECT count(*) AS n FROM upload WHERE aborted_at IS NULL").get()).toEqual({ n: 0 });
    expect(r.counters()).toEqual({ used: 0, reserved: 0 });
  });

  it("W10: a part over a refused class A charge stores nothing", async () => {
    const r = rig(PART);
    const { row } = await started(r, DECK);
    r.spend.charge = async () => refusedSpend;
    const part = slice(DECK, PART, 1);
    expect(await putPart(r.d, row, 1, streamOf(part), part.length)).toMatchObject({ ok: false, error: "rate_limited" });
    expect(r.mp.calls.some((c) => c.startsWith("part"))).toBe(false);
    expect(await store.doneParts(r.db, row.id)).toEqual([]);
  });
});

describe("UP-12 unsettled: a check that cannot finish leaves the file checking", () => {
  it("UP-12 unsettled: a refused class B charge answers checking, keeps the bytes used, and the next complete finishes it", async () => {
    let refuseB = true;
    const r = rig(PART, {
      charge: async (cls: string) => (cls === "B" && refuseB ? refusedSpend : { ok: true }),
    } as never);
    const { row } = await started(r, DECK);
    await storeAll(r, row, DECK);
    expect(await completeLibrary(r.d, row)).toMatchObject({ ok: true, value: { state: "checking" } });
    expect(r.counters()).toEqual({ used: DECK.length, reserved: 0 });

    refuseB = false;
    r.clock.now += store.CLAIM_MS + 1;
    const closed = (await store.get(r.db, row.id)) as store.UploadRow;
    expect(await stateOf(r.d, closed)).toMatchObject({ state: "completed", file: { status: "checking" } });
    expect(await completeLibrary(r.d, closed)).toMatchObject({ ok: true, value: { state: "ready" } });
    expect(await stateOf(r.d, closed)).toMatchObject({ state: "completed", file: { status: "ready" } });
    expect(r.counters()).toEqual({ used: DECK.length, reserved: 0 });
  });

  it("UP-12 unsettled: reading an upload is a pure read; it never reruns the check, reads R2 or charges", async () => {
    const r = rig(PART, { charge: async (cls: string) => (cls === "B" ? refusedSpend : { ok: true }) } as never);
    const { row } = await started(r, DECK);
    await storeAll(r, row, DECK);
    await completeLibrary(r.d, row);
    r.clock.now += store.CLAIM_MS + 1;
    r.mp.calls.length = 0;
    const spent = r.spend.calls.length;
    const closed = (await store.get(r.db, row.id)) as store.UploadRow;
    expect(await stateOf(r.d, closed)).toMatchObject({ state: "completed", file: { status: "checking" } });
    expect(r.mp.calls).toEqual([]);
    expect(r.spend.calls).toHaveLength(spent);
    expect(r.db.raw.prepare("SELECT updated_at AS at FROM library_file").get()).toEqual({ at: row.createdAt });
  });
});

describe("UP-13 crc32: the stored digest is the file's", () => {
  it("UP-13 crc32: the file row keeps the CRC-32 of the stored bytes", async () => {
    const { crc32 } = await import("../../src/worker/crc32.ts");
    const r = rig(PART);
    const { row } = await started(r, DECK);
    await storeAll(r, row, DECK);
    await completeLibrary(r.d, row);
    expect(r.db.raw.prepare("SELECT crc32 FROM library_file").get()).toEqual({ crc32: crc32(DECK) });
  });
});

const current = async (r: ReturnType<typeof rig>, id: string) => (await store.get(r.db, id)) as store.UploadRow;
const create = (r: ReturnType<typeof rig>, over: Partial<Parameters<typeof createLibrary>[2]> = {}) =>
  createLibrary(r.d, "u1", { name: "Deck.pptx", bytes: DECK.length, fingerprint: FINGERPRINT, idemKey: null, ...over });

describe("the ordering rule: the guarded D1 move first, R2's bytes only when it won", () => {
  it("UP-04 abort: a client gone after R2 joined the parts, then a cancel after the claim went stale, leaves no object and no reservation", async () => {
    const r = rig(PART);
    const { row } = await started(r, DECK);
    await storeAll(r, row, DECK);
    r.mp.failNext("head");
    await expect(completeLibrary(r.d, row)).rejects.toThrow();
    expect(r.mp.objects.has(row.r2Key)).toBe(true);
    r.clock.now += store.CLAIM_MS + 1;
    expect(await abortLibrary(r.d, await current(r, row.id))).toMatchObject({ ok: true });
    expect(r.counters()).toEqual({ used: 0, reserved: 0 });
    expect(r.mp.objects.has(row.r2Key)).toBe(false);
    expect(r.mp.open.size).toBe(0);
  });

  it("LIB-02 race: a complete whose stale claim the sweep finished loses its settle and deletes nothing", async () => {
    const r = rig(PART);
    const { row } = await started(r, DECK);
    await storeAll(r, row, DECK);
    const head = r.mp.head;
    let raced = false;
    r.mp.head = async (key) => {
      if (!raced) {
        raced = true;
        r.clock.now += store.CLAIM_MS + 1;
        expect(await sweepUploads(r.d, 50)).toMatchObject({ finished: 1 });
      }
      return head(key);
    };
    expect(await completeLibrary(r.d, row)).toMatchObject({ ok: true, value: { state: "ready" } });
    expect(r.mp.objects.get(row.r2Key)).toEqual(DECK);
    expect(r.counters()).toEqual({ used: DECK.length, reserved: 0 });
    expect(r.db.raw.prepare("SELECT status FROM library_file").get()).toEqual({ status: "ready" });
  });

  it("LIB-02 race: a complete that gives up after another claimant settled answers the settled file and deletes nothing", async () => {
    const r = rig(PART);
    const { row } = await started(r, DECK);
    await storeAll(r, row, DECK);
    const head = r.mp.head;
    let raced = false;
    r.mp.head = async (key) => {
      if (raced) return head(key);
      raced = true;
      r.clock.now += store.CLAIM_MS + 1;
      await sweepUploads(r.d, 50);
      return { size: 1 };
    };
    expect(await completeLibrary(r.d, row)).toMatchObject({ ok: true, value: { state: "ready" } });
    expect(r.mp.objects.get(row.r2Key)).toEqual(DECK);
    expect(r.counters()).toEqual({ used: DECK.length, reserved: 0 });
  });

  it("LIB-02 race: a refusal that loses to another check deletes nothing and answers the file as it stands", async () => {
    const r = rig(1000);
    const pdf = validPdf();
    const { row } = await started(r, pdf, "Deck.pptx");
    await storeAll(r, row, pdf);
    const get = r.mp.get;
    r.mp.get = async (key, range) => {
      r.db.raw.prepare("UPDATE library_file SET status = 'ready'").run();
      return get(key, range);
    };
    expect(await completeLibrary(r.d, row)).toMatchObject({ ok: true, value: { state: "ready" } });
    expect(r.mp.objects.has(row.r2Key)).toBe(true);
  });

  it("a suspended member's complete settles nothing: the reservation returns and the object is deleted", async () => {
    const r = rig(PART);
    const { row } = await started(r, DECK);
    await storeAll(r, row, DECK);
    r.db.raw.prepare("UPDATE app_user SET suspended_at = 1 WHERE id = 'u1'").run();
    expect(await completeLibrary(r.d, row)).toMatchObject({ ok: false, error: "upload_gone" });
    expect(r.counters()).toEqual({ used: 0, reserved: 0 });
    expect(r.mp.objects.has(row.r2Key)).toBe(false);
    expect(r.db.raw.prepare("SELECT count(*) AS n FROM library_file").get()).toEqual({ n: 0 });
  });

  it("calls afterReady only when markReady won", async () => {
    const r = rig(PART);
    const ready: string[] = [];
    r.d.afterReady = async (f) => void ready.push(f.id);
    const { row } = await started(r, DECK);
    await storeAll(r, row, DECK);
    const get = r.mp.get;
    r.mp.get = async (key, range) => {
      r.db.raw.prepare("UPDATE library_file SET status = 'refused'").run();
      return get(key, range);
    };
    expect(await completeLibrary(r.d, row)).toMatchObject({ ok: true, value: { state: "refused" } });
    expect(ready).toEqual([]);
  });
});

describe("UP-08 resume: complete's body", () => {
  it("UP-08 resume: proxy mode refuses a part confirmation and a last part on complete, and changes nothing", async () => {
    const r = rig(PART);
    const { row } = await started(r, DECK);
    await storeAll(r, row, DECK);
    const etags = await store.doneParts(r.db, row.id);
    expect(await confirmPart(r.d, row, 1, `"${"b".repeat(32)}"`, PART)).toMatchObject({
      ok: false,
      error: "bad_request",
    });
    const last = { n: 3, etag: `"${"f".repeat(32)}"`, bytes: DECK.length - 2 * PART };
    expect(await completeLibrary(r.d, row, last)).toMatchObject({ ok: false, error: "bad_request" });
    expect(await store.doneParts(r.db, row.id)).toEqual(etags);
    expect((await current(r, row.id)).completingAt).toBeNull();
    expect(r.counters()).toEqual({ used: 0, reserved: DECK.length });
  });

  it("UP-08 resume: in direct mode `last` must be the final part; any other is a plain 400 that changes nothing", async () => {
    const r = rig(PART, {}, signer);
    const { row } = await started(r, DECK);
    for (const last of [
      { n: 1, etag: `"${"f".repeat(32)}"`, bytes: PART },
      { n: 3, etag: `"${"f".repeat(32)}"`, bytes: PART },
      { n: 4, etag: `"${"f".repeat(32)}"`, bytes: 1 },
    ]) {
      expect(await completeLibrary(r.d, row, last), JSON.stringify(last)).toMatchObject({
        ok: false,
        error: "bad_request",
      });
    }
    expect(await store.doneParts(r.db, row.id)).toEqual([]);
    const now = await current(r, row.id);
    expect(now).toMatchObject({ completingAt: null, abortedAt: null });
    expect(r.counters()).toEqual({ used: 0, reserved: DECK.length });
  });
});

describe("status codes of the failure paths", () => {
  it("an R2 part fault is a retryable service_busy, a body of the wrong length is bad_request, a gone multipart is upload_aborted; none records a part", async () => {
    const r = rig(PART);
    const { row } = await started(r, DECK);
    const part = slice(DECK, PART, 1);
    r.mp.failNext("part");
    expect(await putPart(r.d, row, 1, streamOf(part), part.length)).toMatchObject({
      ok: false,
      error: "service_busy",
    });
    expect(await putPart(r.d, row, 1, streamOf(part.subarray(1)), part.length)).toMatchObject({
      ok: false,
      error: "bad_request",
    });
    r.mp.open.delete(row.r2UploadId);
    expect(await putPart(r.d, row, 1, streamOf(part), part.length)).toMatchObject({
      ok: false,
      error: "upload_aborted",
    });
    expect(await store.doneParts(r.db, row.id)).toEqual([]);
    expect(await current(r, row.id)).toMatchObject({ abortedAt: null, completedAt: null });
  });

  it("a reserve whose D1 answer was lost after it committed goes on as reserved", async () => {
    const r = rig(PART);
    let lost = false;
    r.d.db = {
      prepare: (sql) => r.db.prepare(sql),
      batch: async (statements) => {
        const out = await r.db.batch(statements);
        if (lost) return out;
        lost = true;
        throw new Error("network lost the answer");
      },
    };
    const made = await create(r);
    expect(made).toMatchObject({ ok: true, value: { created: true } });
    expect(r.counters()).toEqual({ used: 0, reserved: DECK.length });
    expect(r.db.raw.prepare("SELECT count(*) AS n FROM upload WHERE aborted_at IS NULL").get()).toEqual({ n: 1 });
    expect(r.spend.calls.filter((c) => c.method === "refund")).toEqual([]);
  });

  it("REL-14 idem: two creates racing on one Idempotency-Key with different files: one is created, the other is bad_request, never internal", async () => {
    const r = rig(PART);
    const [a, b] = await Promise.all([
      create(r, { idemKey: "k1" }),
      create(r, { idemKey: "k1", fingerprint: "b".repeat(64), name: "Other.pptx" }),
    ]);
    const outcomes = [a, b].map((o) => (o.ok ? "created" : o.error)).sort();
    expect(outcomes).toEqual(["bad_request", "created"]);
    expect(r.counters()).toEqual({ used: 0, reserved: DECK.length });
    expect(r.spend.calls.filter((c) => c.method === "take")).toHaveLength(2);
  });

  it("REL-14 idem: two creates racing on one Idempotency-Key with the same file reserve once", async () => {
    const r = rig(PART);
    const both = await Promise.all([create(r, { idemKey: "k1" }), create(r, { idemKey: "k1" })]);
    expect(both.filter((o) => o.ok && o.value.created)).toHaveLength(1);
    for (const o of both) expect(o.ok || o.error === "upload_busy").toBe(true);
    expect(r.counters()).toEqual({ used: 0, reserved: DECK.length });
  });

  it("the same fingerprint with another name or size is bad_request before any take or reserve", async () => {
    const r = rig(PART);
    await started(r, DECK);
    const takes = r.spend.calls.length;
    expect(await create(r, { name: "Renamed.pptx" })).toMatchObject({ ok: false, error: "bad_request" });
    expect(await create(r, { bytes: DECK.length + 1 })).toMatchObject({ ok: false, error: "bad_request" });
    expect(r.spend.calls).toHaveLength(takes);
    expect(r.counters().reserved).toBe(DECK.length);
  });

  it("an expired upload the sweep has not reached yet does not block a new upload of the same file", async () => {
    const r = rig(PART);
    const { row } = await started(r, DECK);
    r.clock.now = row.expiresAt + 1;
    const again = await create(r);
    expect(again).toMatchObject({ ok: true, value: { created: true } });
    expect(again.ok && again.value.answer.uploadId).not.toBe(row.id);
  });
});

describe("UP-01 scope: direct mode mints", () => {
  it("UP-01 scope: resumes of a one-part file are never locked out: past the budget they wait one URL lifetime", async () => {
    const r = rig(1_000_000, {}, signer);
    const jpg = validJpeg();
    const fresh = () => create(r, { name: "p.jpg", bytes: jpg.length });
    expect(await fresh()).toMatchObject({ ok: true, value: { created: true } });
    expect(await fresh()).toMatchObject({ ok: true, value: { created: false } });
    expect(await fresh()).toMatchObject({ ok: true, value: { created: false } });
    const spent = await fresh();
    expect(spent).toMatchObject({ ok: false, error: "rate_limited" });
    expect(!spent.ok && spent.retryAfter).toBeGreaterThan(0);
    r.clock.now += r.d.config.library.urlTtlSeconds * 1000;
    expect(await fresh()).toMatchObject({ ok: true, value: { created: false, answer: { urls: [{ n: 1 }] } } });
  });
});
