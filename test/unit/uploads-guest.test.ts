// A guest's upload on the shared pipeline (src/worker/uploads/guest.ts): its own create, complete and cancel, the
// session's caps, the guest bucket, and a session's end. The storage and the Screen are a fake `GuestSide`.
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/worker/config.ts";
import type { SettledFile } from "../../src/worker/seams/guest-drop/index.ts";
import type { OpClass } from "../../src/worker/seams/guest-drop/meter.ts";
import { readBudget } from "../../src/worker/uploads/check.ts";
import {
  abortGuest,
  abortSession,
  completeGuest,
  createGuest,
  GUEST_MAX_OPEN,
  type GuestSide,
  meteredFor,
  putGuestPart,
} from "../../src/worker/uploads/guest.ts";
import { type Deps, putPart, stateOf } from "../../src/worker/uploads/pipeline.ts";
import * as store from "../../src/worker/uploads/store.ts";
import { sweepUploads } from "../../src/worker/uploads/sweep.ts";
import { PROD_VARS } from "../env-vars.ts";
import { validDeck, validPdf } from "../zip-builder.ts";
import { addUser, testDb } from "./d1-shim.ts";
import { fakeMultipart } from "./fake-multipart.ts";
import { fakeSpend } from "./spend-helpers.ts";

const parsed = parseConfig({ ...PROD_VARS });
if (!parsed.ok) throw new Error(parsed.problems.join());
const BASE = parsed.config;
const LIMITS = { maxBytes: 25 * 1024 * 1024, maxFiles: 12, maxOpen: GUEST_MAX_OPEN, expiryMs: 15 * 60_000 };
const DECK = validDeck();
const fp = (n: number) => n.toString(16).padStart(64, "0");
const streamOf = (bytes: Uint8Array) => new Blob([Buffer.from(bytes)]).stream() as ReadableStream<Uint8Array>;

function rig(partBytes = Math.ceil(DECK.length / 2)) {
  const db = testDb();
  addUser(db, "u1");
  const mp = fakeMultipart();
  const guestMp = fakeMultipart();
  const clock = { now: 1_000_000_000 };
  const config = { ...BASE, library: { ...BASE.library, partBytes } };
  /** The guest meter: what each class counted, against its cap. */
  const meter = { counts: { A: 0, B: 0 }, caps: { A: Number.POSITIVE_INFINITY, B: Number.POSITIVE_INFINITY } };
  const charge = async (cls: OpClass, n: number) => {
    if (meter.counts[cls] + n > meter.caps[cls]) return false;
    meter.counts[cls] += n;
    return true;
  };
  const d: Deps = meteredFor({ db, mp, guestMp, spend: fakeSpend(), config, now: () => clock.now }, { charge });
  const log = { reserved: [] as string[], settled: [] as SettledFile[], forgot: [] as string[] };
  const outcome = { reserve: null as string | null, settle: true };
  const side = (sessionId = "s1"): GuestSide => ({
    charge,
    sessionId,
    screenRef: "scr1",
    reserve: async (key) => {
      log.reserved.push(key);
      return outcome.reserve as never;
    },
    settle: async (file) => {
      log.settled.push(file);
      return outcome.settle;
    },
    forget: async (key) => void log.forgot.push(key),
  });
  return { db, mp, guestMp, clock, d, log, outcome, side, meter };
}

type Rig = ReturnType<typeof rig>;

async function created(r: Rig, bytes: Uint8Array, name = "Talk.pptx", fingerprint = fp(1), sessionId = "s1") {
  const made = await createGuest(
    r.d,
    r.side(sessionId),
    { name, bytes: bytes.length, fingerprint, idemKey: null },
    LIMITS,
  );
  if (!made.ok) throw new Error(`create refused: ${JSON.stringify(made.error)}`);
  const row = await store.get(r.db, made.value.answer.uploadId);
  if (!row) throw new Error("no row");
  return { row, made: made.value };
}

async function sendAll(r: Rig, row: store.UploadRow, bytes: Uint8Array) {
  for (let n = 1; n <= row.parts; n++) {
    const part = bytes.subarray((n - 1) * row.partBytes, n * row.partBytes);
    const out = await putPart(r.d, row, n, streamOf(part), part.length);
    if (!out.ok) throw new Error(`part ${n}: ${JSON.stringify(out.error)}`);
  }
}

const libraryTouched = (r: Rig) => ({
  files: (r.db.raw.prepare("SELECT count(*) AS c FROM library_file").get() as { c: number }).c,
  user: r.db.raw.prepare("SELECT used_bytes AS used, reserved_bytes AS reserved FROM app_user WHERE id = 'u1'").get(),
});

describe("a guest upload through the pipeline", () => {
  it("opens in the guest bucket under g/, proxied on the guest routes, and is ready once its file is settled", async () => {
    const r = rig();
    const { row, made } = await created(r, DECK);
    expect(made.created).toBe(true);
    expect(row).toMatchObject({
      ownerKind: "guest",
      bucket: "guest",
      sessionId: "s1",
      screenRef: "scr1",
      userId: null,
    });
    expect(row.r2Key).toMatch(/^g\/[A-Za-z0-9_-]{22}$/);
    expect(made.answer.mode).toBe("proxy");
    expect(made.answer.urls.map((u) => u.url)).toEqual([1, 2].map((n) => `/api/guest/uploads/${row.id}/parts/${n}`));
    expect(r.log.reserved).toEqual([row.r2Key]);
    expect(r.mp.calls).toEqual([]);
    await sendAll(r, row, DECK);
    const done = await completeGuest(r.d, r.side(), row);
    expect(done).toEqual({ ok: true, value: { state: "ready", file: { id: row.fileId, status: "ready" } } });
    expect(r.log.settled).toEqual([
      expect.objectContaining({
        uploadId: row.id,
        fileId: row.fileId,
        r2Key: row.r2Key,
        kind: "pptx",
        size: DECK.length,
      }),
    ]);
    expect(r.guestMp.objects.get(row.r2Key)).toEqual(DECK);
    expect(r.mp.calls).toEqual([]);
    expect(libraryTouched(r)).toEqual({ files: 0, user: { used: 0, reserved: 0 } });
    const after = await store.get(r.db, row.id);
    expect(after?.completedAt).not.toBeNull();
    expect((await stateOf(r.d, after as store.UploadRow)).file).toEqual({ id: row.fileId, status: "ready" });
    // A repeat answers the ready file and settles nothing twice.
    expect(await completeGuest(r.d, r.side(), after as store.UploadRow)).toMatchObject({
      ok: true,
      value: { state: "ready" },
    });
    expect(r.log.settled).toHaveLength(1);
  });

  it("UP-09 retry: the same file on the same session resumes its upload with the parts it has, never a second one", async () => {
    const r = rig();
    const first = await created(r, DECK);
    const part = DECK.subarray(0, first.row.partBytes);
    expect((await putPart(r.d, first.row, 1, streamOf(part), part.length)).ok).toBe(true);
    const again = await created(r, DECK);
    expect(again.made.created).toBe(false);
    expect(again.row.id).toBe(first.row.id);
    expect(again.made.answer.done).toEqual([1]);
    expect(r.guestMp.calls.filter((c) => c.startsWith("create"))).toHaveLength(1);
    expect(r.log.reserved).toHaveLength(1);
    // Another session's same file is its own upload.
    const other = await created(r, DECK, "Talk.pptx", fp(1), "s2");
    expect(other.row.id).not.toBe(first.row.id);
  });

  it("refuses a name a guest may not send, and a file over the screen's cap, before any write", async () => {
    const r = rig();
    const ask = (name: string, bytes: number) =>
      createGuest(r.d, r.side(), { name, bytes, fingerprint: fp(9), idemKey: null }, LIMITS);
    expect(await ask("notes.txt", 10)).toEqual({ ok: false, error: "bad_type", retryAfter: undefined });
    expect(await ask("Talk.pptx", LIMITS.maxBytes + 1)).toEqual({
      ok: false,
      error: "too_large",
      retryAfter: undefined,
    });
    expect(r.db.raw.prepare("SELECT count(*) AS c FROM upload").get()).toEqual({ c: 0 });
    expect(r.log.reserved).toEqual([]);
  });

  it("holds the session's caps: 3 open at once, then upload_busy", async () => {
    const r = rig();
    for (let i = 1; i <= GUEST_MAX_OPEN; i++) await created(r, DECK, `T${i}.pptx`, fp(i));
    const fourth = await createGuest(
      r.d,
      r.side(),
      { name: "T4.pptx", bytes: DECK.length, fingerprint: fp(4), idemKey: null },
      LIMITS,
    );
    expect(fourth).toMatchObject({ ok: false, error: "upload_busy" });
  });

  it("holds the session's caps: 12 files in all, then already_uploaded", async () => {
    const r = rig();
    for (let i = 1; i <= 12; i++) {
      const { row } = await created(r, DECK, `T${i}.pptx`, fp(i));
      await sendAll(r, row, DECK);
      expect((await completeGuest(r.d, r.side(), row)).ok).toBe(true);
    }
    const more = await createGuest(
      r.d,
      r.side(),
      { name: "T13.pptx", bytes: DECK.length, fingerprint: fp(13), idemKey: null },
      LIMITS,
    );
    expect(more).toMatchObject({ ok: false, error: "already_uploaded" });
  });

  it("a budget refusal closes the row it opened and calls R2 for nothing", async () => {
    const r = rig();
    r.outcome.reserve = "storage_full";
    const made = await createGuest(
      r.d,
      r.side(),
      { name: "T.pptx", bytes: DECK.length, fingerprint: fp(1), idemKey: null },
      LIMITS,
    );
    expect(made).toMatchObject({ ok: false, error: "storage_full" });
    expect(r.guestMp.calls).toEqual([]);
    expect(r.db.raw.prepare("SELECT count(*) AS c FROM upload WHERE aborted_at IS NULL").get()).toEqual({ c: 0 });
  });

  it("UP-05 a file whose bytes are not its name's type is refused: the row closes, the object and ledger go", async () => {
    const r = rig();
    const pdf = validPdf();
    const { row } = await created(r, pdf, "Talk.pptx");
    await sendAll(r, row, pdf);
    const out = await completeGuest(r.d, r.side(), row);
    expect(out).toEqual({
      ok: true,
      value: { state: "refused", file: { id: row.fileId, status: "refused", refusal: "bad_type" } },
    });
    expect(r.guestMp.objects.has(row.r2Key)).toBe(false);
    expect(r.log.forgot).toEqual([row.r2Key]);
    expect(r.log.settled).toEqual([]);
    expect((await store.get(r.db, row.id))?.abortedAt).not.toBeNull();
  });

  it("a file whose session ended before it settled is deleted, never offered", async () => {
    const r = rig();
    r.outcome.settle = false;
    const { row } = await created(r, DECK);
    await sendAll(r, row, DECK);
    expect(await completeGuest(r.d, r.side(), row)).toMatchObject({ ok: false, error: "upload_gone" });
    expect(r.guestMp.objects.has(row.r2Key)).toBe(false);
    expect(r.log.forgot).toEqual([row.r2Key]);
  });

  it("a cancel closes the row, aborts its multipart and forgets its ledger row; a repeat is a no-op", async () => {
    const r = rig();
    const { row } = await created(r, DECK);
    expect(await abortGuest(r.d, r.side(), row)).toEqual({ ok: true, value: null });
    expect(r.guestMp.calls).toContain(`abort ${row.r2UploadId}`);
    expect(r.log.forgot).toEqual([row.r2Key]);
    const closed = (await store.get(r.db, row.id)) as store.UploadRow;
    expect(await abortGuest(r.d, r.side(), closed)).toEqual({ ok: true, value: null });
    expect(r.log.forgot).toHaveLength(1);
  });
});

describe("UP-04 a session's end aborts its open uploads", () => {
  it("purge aborts every open multipart of the session, skips a live complete's claim, and leaves other sessions", async () => {
    const r = rig();
    const a = await created(r, DECK, "A.pptx", fp(1));
    const b = await created(r, DECK, "B.pptx", fp(2));
    const claimed = await created(r, DECK, "C.pptx", fp(3));
    const other = await created(r, DECK, "A.pptx", fp(1), "s2");
    await store.claim(r.db, claimed.row.id, r.clock.now);
    expect(await abortSession(r.d, "s1")).toBe(2);
    for (const row of [a.row, b.row]) {
      expect(r.guestMp.calls).toContain(`abort ${row.r2UploadId}`);
      expect((await store.get(r.db, row.id))?.abortedAt).not.toBeNull();
    }
    expect(r.guestMp.open.has(claimed.row.r2UploadId)).toBe(true);
    expect(r.guestMp.open.has(other.row.r2UploadId)).toBe(true);
    expect(r.mp.calls).toEqual([]);
    expect(await store.openOfSession(r.db, "s1")).toHaveLength(1);
  });
});

describe("the hourly sweep picks the bucket by the row", () => {
  it("releases an expired guest upload in the guest bucket, a library one in the library bucket", async () => {
    const r = rig();
    const g = await created(r, DECK);
    r.clock.now += LIMITS.expiryMs + 1;
    const report = await sweepUploads(r.d, 10);
    expect(report.released).toBe(1);
    expect(r.guestMp.calls).toContain(`abort ${g.row.r2UploadId}`);
    expect(r.guestMp.calls).toContain(`delete ${g.row.r2Key}`);
    expect(r.mp.calls).toEqual([]);
  });

  it("gives up a guest complete that died after its claim, in the guest bucket, and never settles it", async () => {
    const r = rig();
    const g = await created(r, DECK);
    await sendAll(r, g.row, DECK);
    await store.claim(r.db, g.row.id, r.clock.now);
    r.clock.now += store.CLAIM_MS + 1;
    const report = await sweepUploads(r.d, 10);
    expect(report).toMatchObject({ released: 1, finished: 0 });
    expect(r.guestMp.calls).toContain(`delete ${g.row.r2Key}`);
    expect(r.mp.calls).toEqual([]);
    // The stranded-key pass deletes it again, in its own bucket.
    r.guestMp.calls.length = 0;
    await sweepUploads(r.d, 10);
    expect(r.guestMp.calls).toContain(`delete ${g.row.r2Key}`);
    expect(r.mp.calls).toEqual([]);
  });
});

describe("DROP-05 R2 cap: a guest upload counts on the guest meter", () => {
  it("DROP-05 counts the create, each part, the join and the check's reads", async () => {
    const r = rig();
    const { row } = await created(r, DECK);
    await sendAll(r, row, DECK);
    expect(await completeGuest(r.d, r.side(), row)).toMatchObject({ ok: true, value: { state: "ready" } });
    expect(r.meter.counts).toEqual({ A: 1 + row.parts + 1, B: readBudget(DECK.length) });
  });

  it("DROP-05 a create past the class A cap is storage_full and leaves nothing open", async () => {
    const r = rig();
    r.meter.caps.A = 0;
    const made = await createGuest(
      r.d,
      r.side(),
      { name: "Talk.pptx", bytes: DECK.length, fingerprint: fp(1), idemKey: null },
      LIMITS,
    );
    expect(made).toEqual({ ok: false, error: "storage_full" });
    expect(await store.openOfSession(r.db, "s1")).toEqual([]);
    expect(r.guestMp.calls).toEqual([]);
    expect(r.log.forgot).toHaveLength(1);
  });

  it("DROP-05 a part past the cap cancels the upload: storage_full, its multipart aborted", async () => {
    const r = rig();
    const { row } = await created(r, DECK);
    r.meter.caps.A = r.meter.counts.A;
    const part = DECK.subarray(0, row.partBytes);
    expect(await putGuestPart(r.d, r.side(), row, 1, streamOf(part), part.length)).toEqual({
      ok: false,
      error: "storage_full",
    });
    expect(r.guestMp.calls).toContain(`abort ${row.r2UploadId}`);
    expect(r.guestMp.calls.filter((c) => c.startsWith("part"))).toEqual([]);
    expect(store.isOpen((await store.get(r.db, row.id)) as store.UploadRow)).toBe(false);
  });

  it("DROP-05 a check whose reads pass the class B cap is refused storage_full, and its object goes", async () => {
    const r = rig();
    const { row } = await created(r, DECK);
    await sendAll(r, row, DECK);
    r.meter.caps.B = readBudget(DECK.length) - 1;
    expect(await completeGuest(r.d, r.side(), row)).toEqual({
      ok: true,
      value: { state: "refused", file: { id: row.fileId, status: "refused", refusal: "storage_full" } },
    });
    expect(r.meter.counts.B).toBe(0);
    expect(r.guestMp.objects.has(row.r2Key)).toBe(false);
    expect(r.log.settled).toEqual([]);
  });
});
