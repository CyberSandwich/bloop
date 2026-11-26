import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/worker/config.ts";
import { createLibrary, type Deps } from "../../src/worker/uploads/pipeline.ts";
import { releaseLibrary } from "../../src/worker/uploads/quota.ts";
import * as store from "../../src/worker/uploads/store.ts";
import { sweepUploads } from "../../src/worker/uploads/sweep.ts";
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
  const d: Deps = { db, mp, spend: fakeSpend(), config: baseConfig, now: () => clock.now };
  return { db, mp, clock, d };
}

async function open(r: ReturnType<typeof rig>) {
  const made = await createLibrary(r.d, "u1", {
    name: "Deck.pptx",
    bytes: DECK.length,
    fingerprint: "d".repeat(64),
    idemKey: null,
  });
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  return (await store.get(r.db, made.value.answer.uploadId)) as store.UploadRow;
}

describe("UP-04 abort: an object a crash stranded after a won release", () => {
  it("UP-04 abort: a release that won and a worker that died before the delete leaves a key the sweep deletes", async () => {
    const r = rig();
    const row = await open(r);
    r.mp.objects.set(row.r2Key, DECK);
    await store.claim(r.db, row.id, r.clock.now);
    // The guarded move wins; the delete never runs.
    expect(await releaseLibrary(r.db, { id: row.id, userId: "u1", bytes: row.bytes }, r.clock.now, r.clock.now)).toBe(
      true,
    );
    expect(r.mp.objects.has(row.r2Key)).toBe(true);
    await sweepUploads(r.d, 50);
    expect(r.mp.objects.has(row.r2Key)).toBe(false);
  });

  it("UP-04 abort: a delete that threw once is tried again by the next sweep", async () => {
    const r = rig();
    const row = await open(r);
    r.mp.objects.set(row.r2Key, DECK);
    await store.claim(r.db, row.id, r.clock.now);
    await releaseLibrary(r.db, { id: row.id, userId: "u1", bytes: row.bytes }, r.clock.now, r.clock.now);
    r.mp.failNext("delete");
    await sweepUploads(r.d, 50);
    expect(r.mp.objects.has(row.r2Key)).toBe(true);
    r.clock.now += HOUR;
    await sweepUploads(r.d, 50);
    expect(r.mp.objects.has(row.r2Key)).toBe(false);
  });

  it("UP-04 abort: a stranded key is left once its row is older than the keep window", async () => {
    const r = rig();
    const row = await open(r);
    r.mp.objects.set(row.r2Key, DECK);
    await store.claim(r.db, row.id, r.clock.now);
    await releaseLibrary(r.db, { id: row.id, userId: "u1", bytes: row.bytes }, r.clock.now, r.clock.now);
    r.clock.now += 25 * HOUR;
    await sweepUploads(r.d, 50);
    expect(r.mp.objects.has(row.r2Key)).toBe(true);
  });
});
