import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/worker/config.ts";
import { createLibrary, type Deps } from "../../src/worker/uploads/pipeline.ts";
import * as store from "../../src/worker/uploads/store.ts";
import { reconcileQuotas, sweepUploads } from "../../src/worker/uploads/sweep.ts";
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
    expect(await sweepUploads(r.d, 50)).toEqual({ finished: 0, released: 0, deleted: 0 });
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
