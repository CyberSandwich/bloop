import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../src/worker/config.ts";
import { createLibrary, type Deps } from "../../src/worker/uploads/pipeline.ts";
import { settleLibrary } from "../../src/worker/uploads/quota.ts";
import * as store from "../../src/worker/uploads/store.ts";
import { reconcileQuotas, SWEEP_WALL_MS, sweepUploads } from "../../src/worker/uploads/sweep.ts";
import { PROD_VARS } from "../env-vars.ts";
import { validDeck } from "../zip-builder.ts";
import { addUser, testDb } from "./d1-shim.ts";
import { fakeMultipart } from "./fake-multipart.ts";
import { fakeSpend } from "./spend-helpers.ts";

const parsed = parseConfig({ ...PROD_VARS });
if (!parsed.ok) throw new Error(parsed.problems.join());
const baseConfig = parsed.config;
const DECK = validDeck();
const HOUR = 3_600_000;

function rig() {
  const db = testDb();
  addUser(db, "u1");
  const mp = fakeMultipart();
  const clock = { now: 1_000_000_000 };
  const config = { ...baseConfig, library: { ...baseConfig.library, partBytes: Math.ceil(DECK.length / 2) } };
  const d: Deps = { db, mp, spend: fakeSpend(), config, now: () => clock.now };
  const counters = () =>
    db.raw.prepare("SELECT used_bytes AS used, reserved_bytes AS reserved FROM app_user WHERE id = 'u1'").get() as {
      used: number;
      reserved: number;
    };
  const open = async (fingerprint: string) => {
    const made = await createLibrary(d, "u1", { name: "Deck.pptx", bytes: DECK.length, fingerprint, idemKey: null });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    return (await store.get(db, made.value.answer.uploadId)) as store.UploadRow;
  };
  return { db, mp, clock, d, counters, open };
}

describe("UP-04 abort: the hourly sweep", () => {
  it("UP-04 abort: an expired open upload is aborted in R2 and its reservation returns", async () => {
    const r = rig();
    const row = await open(r);
    expect(r.counters().reserved).toBe(DECK.length);
    r.clock.now = row.expiresAt + 1;
    const report = await sweepUploads(r.d, 50);
    expect(report.released).toBe(1);
    expect(r.counters()).toEqual({ used: 0, reserved: 0 });
    expect(r.mp.open.size).toBe(0);
  });

  it("UP-04 abort: an unexpired upload is left alone", async () => {
    const r = rig();
    await open(r);
    r.clock.now += HOUR;
    expect(await sweepUploads(r.d, 50)).toEqual({
      finished: 0,
      released: 0,
      deleted: 0,
      rechecked: 0,
      refused: 0,
      converted: 0,
      more: false,
    });
    expect(r.counters().reserved).toBe(DECK.length);
  });

  it("UP-04 abort: a complete that died before R2 joined the parts is released after its claim goes stale", async () => {
    const r = rig();
    const row = await open(r);
    await store.claim(r.db, row.id, r.clock.now);
    r.clock.now += store.CLAIM_MS - 1;
    expect(await sweepUploads(r.d, 50)).toMatchObject({ released: 0 });
    r.clock.now += 2;
    expect(await sweepUploads(r.d, 50)).toMatchObject({ released: 1 });
    expect(r.counters()).toEqual({ used: 0, reserved: 0 });
  });

  it("UP-04 abort: a complete that died after R2 joined the parts is settled and checked", async () => {
    const r = rig();
    const row = await open(r);
    r.mp.objects.set(row.r2Key, DECK);
    await store.claim(r.db, row.id, r.clock.now);
    r.clock.now += store.CLAIM_MS + 1;
    expect(await sweepUploads(r.d, 50)).toMatchObject({ finished: 1 });
    expect(r.counters()).toEqual({ used: DECK.length, reserved: 0 });
    expect(r.db.raw.prepare("SELECT status FROM library_file").get()).toEqual({ status: "ready" });
  });

  it("UP-04 abort: closed rows go after a day, with their parts", async () => {
    const r = rig();
    const row = await open(r);
    await store.recordPart(r.db, row.id, 1, "e", 1, r.clock.now);
    r.clock.now = row.expiresAt + 1;
    await sweepUploads(r.d, 50);
    expect(await store.get(r.db, row.id)).not.toBeNull();
    r.clock.now += 25 * HOUR;
    expect(await sweepUploads(r.d, 50)).toMatchObject({ deleted: 1 });
    expect(await store.get(r.db, row.id)).toBeNull();
    expect(r.db.raw.prepare("SELECT count(*) AS n FROM upload_part").get()).toEqual({ n: 0 });
  });
});

describe("LIB-02 race: the nightly reconcile heals drift", () => {
  it("LIB-02 race: counters that drifted are recomputed from the rows and reported", async () => {
    const r = rig();
    await open(r);
    r.db.raw.prepare("UPDATE app_user SET used_bytes = 999, reserved_bytes = 5 WHERE id = 'u1'").run();
    const out = await reconcileQuotas(r.db, 500);
    expect(out.more).toBe(false);
    expect(out.drifts).toEqual([
      { userId: "u1", before: { used: 999, reserved: 5 }, after: { used: 0, reserved: DECK.length } },
    ]);
    expect(r.counters()).toEqual({ used: 0, reserved: DECK.length });
    expect((await reconcileQuotas(r.db, 500)).drifts).toEqual([]);
  });

  it("LIB-02 race: the allotment bounds a run and says more is left", async () => {
    const r = rig();
    for (const id of ["u2", "u3", "u4"]) addUser(r.db, id);
    const out = await reconcileQuotas(r.db, 2);
    expect(out.more).toBe(true);
  });
});

const open = (r: ReturnType<typeof rig>) => r.open("c".repeat(64));

/** Stores the whole deck as a joined object and settles it under a claim, leaving the file `checking`. */
async function settledChecking(r: ReturnType<typeof rig>) {
  const row = await open(r);
  r.mp.objects.set(row.r2Key, DECK);
  await store.claim(r.db, row.id, r.clock.now);
  await settleLibrary(
    r.db,
    { id: row.id, userId: "u1", fileId: row.fileId, bytes: row.bytes },
    r.clock.now,
    r.clock.now,
  );
  return row;
}
const fileStatus = (r: ReturnType<typeof rig>) =>
  r.db.raw.prepare("SELECT status, refusal FROM library_file").get() as { status: string; refusal: string | null };

describe("UP-12 unsettled: the sweep settles a check left checking", () => {
  it("UP-12 unsettled: a file left checking past the claim window is checked again, even after its upload row is gone", async () => {
    const r = rig();
    await settledChecking(r);
    r.db.raw.prepare("DELETE FROM upload").run();
    r.clock.now += store.CLAIM_MS + 1;
    expect(await sweepUploads(r.d, 50)).toMatchObject({ rechecked: 1 });
    expect(fileStatus(r)).toEqual({ status: "ready", refusal: null });
    expect(r.counters()).toEqual({ used: DECK.length, reserved: 0 });
  });

  it("UP-12 unsettled: a fresh check is left alone", async () => {
    const r = rig();
    await settledChecking(r);
    r.clock.now += store.CLAIM_MS - 1;
    expect(await sweepUploads(r.d, 50)).toMatchObject({ rechecked: 0 });
    expect(fileStatus(r).status).toBe("checking");
  });

  it("UP-12 unsettled: a file still checking a day after it settled is refused, its quota returned and its object deleted", async () => {
    const r = rig();
    const row = await settledChecking(r);
    r.clock.now += 24 * HOUR + 1;
    expect(await sweepUploads(r.d, 50)).toMatchObject({ refused: 1 });
    expect(fileStatus(r)).toEqual({ status: "refused", refusal: "service_busy" });
    expect(r.counters()).toEqual({ used: 0, reserved: 0 });
    expect(r.mp.objects.has(row.r2Key)).toBe(false);
  });

  it("UP-12 unsettled: a refusal that loses to a check that just finished deletes nothing", async () => {
    const r = rig();
    const row = await settledChecking(r);
    r.clock.now += 24 * HOUR + 1;
    const original = r.d.db;
    r.d.db = {
      prepare: (sql) => original.prepare(sql),
      batch: async (statements) => {
        r.db.raw.prepare("UPDATE library_file SET status = 'ready'").run();
        return original.batch(statements);
      },
    };
    expect(await sweepUploads(r.d, 50)).toMatchObject({ refused: 0 });
    expect(r.mp.objects.has(row.r2Key)).toBe(true);
  });
});

describe("UP-04 abort: a suspended member's uploads", () => {
  it("UP-04 abort: the next sweep releases a suspended member's open upload and aborts its multipart", async () => {
    const r = rig();
    const row = await open(r);
    await store.recordPart(r.db, row.id, 1, "e", 1, r.clock.now);
    r.db.raw.prepare("UPDATE app_user SET suspended_at = 1 WHERE id = 'u1'").run();
    expect(await sweepUploads(r.d, 50)).toMatchObject({ released: 1 });
    expect(r.counters()).toEqual({ used: 0, reserved: 0 });
    expect(r.mp.open.size).toBe(0);
    expect((await store.get(r.db, row.id))?.abortedAt).not.toBeNull();
  });
});

describe("the sweep's bounds", () => {
  it("a row that throws is logged by id and skipped; the rest of the run goes on", async () => {
    const r = rig();
    const a = await r.open("1".repeat(64));
    const b = await r.open("2".repeat(64));
    r.clock.now = b.expiresAt + 1;
    const abort = r.mp.abort;
    r.mp.abort = async (key, id) => {
      if (id === a.r2UploadId) throw new Error(`secret ${key}`);
      return abort(key, id);
    };
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: string) => void logged.push(line));
    try {
      expect(await sweepUploads(r.d, 50)).toMatchObject({ released: 1, more: false });
    } finally {
      spy.mockRestore();
    }
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0] as string)).toEqual({ evt: "upload_sweep_failed", step: "expired", id: a.id });
    expect(logged[0]).not.toContain("secret");
    expect((await store.get(r.db, b.id))?.abortedAt).not.toBeNull();
  });

  it("stops at its wall-time budget and says more is left", async () => {
    const r = rig();
    const a = await r.open("1".repeat(64));
    await r.open("2".repeat(64));
    r.clock.now = a.expiresAt + 1;
    const abort = r.mp.abort;
    r.mp.abort = async (key, id) => {
      r.clock.now += SWEEP_WALL_MS;
      return abort(key, id);
    };
    expect(await sweepUploads(r.d, 50)).toMatchObject({ released: 1, more: true });
    expect(await sweepUploads(r.d, 50)).toMatchObject({ released: 1, more: false });
  });

  it("says more is left when the allotment filled", async () => {
    const r = rig();
    const a = await r.open("1".repeat(64));
    await r.open("2".repeat(64));
    r.clock.now = a.expiresAt + 1;
    expect(await sweepUploads(r.d, 1)).toMatchObject({ released: 1, more: true });
    expect(await sweepUploads(r.d, 1)).toMatchObject({ released: 1 });
  });
});
