import { describe, expect, it } from "vitest";
import {
  claimCheck,
  markReady,
  reconcileUser,
  refuseLibrary,
  releaseLibrary,
  reserveLibrary,
  settleLibrary,
} from "../../src/worker/uploads/quota.ts";
import {
  CLAIM_MS,
  chargeMints,
  claim,
  closeGuest,
  completeGuest,
  deleteClosed,
  doneParts,
  expiredOpen,
  findByIdem,
  findOpen,
  get,
  insertGuest,
  listOpen,
  type NewUpload,
  recordPart,
  staleCompletes,
} from "../../src/worker/uploads/store.ts";
import { addUser, type TestDb, testDb } from "./d1-shim.ts";

const GIB = 1024 ** 3;
const LIMITS = { quotaBytes: 5 * GIB, maxFiles: 3 };
const NOW = 1_000_000_000;

let counter = 0;
const upload = (userId: string, over: Partial<NewUpload> = {}): NewUpload => {
  counter++;
  return {
    id: `up${counter}`,
    owner: { kind: "library", userId },
    fileId: `file${counter}`,
    r2Key: `u/${userId}/file${counter}/v1/orig`,
    r2UploadId: `r2-${counter}`,
    name: `Deck ${counter}.pptx`,
    ext: "pptx",
    bytes: GIB,
    partBytes: 16 * 1024 * 1024,
    parts: 64,
    fingerprint: counter.toString(16).padStart(64, "0"),
    createdAt: NOW,
    expiresAt: NOW + 20 * 3600_000,
    idemKey: null,
    ...over,
  };
};

function setup() {
  const db = testDb();
  addUser(db, "u1");
  return db;
}

const counters = (db: TestDb, id = "u1") =>
  db.raw.prepare("SELECT used_bytes AS used, reserved_bytes AS reserved FROM app_user WHERE id = ?").get(id) as {
    used: number;
    reserved: number;
  };

describe("LIB-02 reserve: every guard in the one batch", () => {
  it("reserves bytes and inserts the row together", async () => {
    const db = setup();
    const n = upload("u1");
    expect(await reserveLibrary(db, n, LIMITS)).toBeNull();
    expect(counters(db)).toEqual({ used: 0, reserved: GIB });
    expect(await get(db, n.id)).toMatchObject({ id: n.id, userId: "u1", bytes: GIB, mints: 0, completedAt: null });
  });

  it("LIB-02 reserve: refuses what does not fit, and changes nothing", async () => {
    const db = setup();
    expect(await reserveLibrary(db, upload("u1", { bytes: 5 * GIB }), LIMITS)).toBeNull();
    const over = upload("u1", { bytes: 1 });
    expect(await reserveLibrary(db, over, LIMITS)).toBe("quota_exceeded");
    expect(counters(db).reserved).toBe(5 * GIB);
    expect(await get(db, over.id)).toBeNull();
  });

  it("LIB-02 reserve: an admin override replaces the default quota", async () => {
    const db = setup();
    db.raw.prepare("UPDATE app_user SET quota_bytes = ? WHERE id = 'u1'").run(2 * GIB);
    expect(await reserveLibrary(db, upload("u1", { bytes: 3 * GIB }), LIMITS)).toBe("quota_exceeded");
    expect(await reserveLibrary(db, upload("u1", { bytes: 2 * GIB }), LIMITS)).toBeNull();
  });

  it("LIB-02 reserve: counts used bytes and refuses a suspended or deleting owner", async () => {
    const db = setup();
    db.raw.prepare("UPDATE app_user SET used_bytes = ? WHERE id = 'u1'").run(5 * GIB - 10);
    expect(await reserveLibrary(db, upload("u1", { bytes: 11 }), LIMITS)).toBe("quota_exceeded");
    expect(await reserveLibrary(db, upload("u1", { bytes: 10 }), LIMITS)).toBeNull();
    db.raw.prepare("UPDATE app_user SET suspended_at = 1 WHERE id = 'u1'").run();
    expect(await reserveLibrary(db, upload("u1", { bytes: 1 }), LIMITS)).toBe("upload_gone");
    db.raw.prepare("UPDATE app_user SET suspended_at = NULL, status = 'deleting' WHERE id = 'u1'").run();
    expect(await reserveLibrary(db, upload("u1", { bytes: 1 }), LIMITS)).toBe("upload_gone");
    expect(await reserveLibrary(db, upload("nobody", { bytes: 1 }), LIMITS)).toBe("upload_gone");
  });

  it("LIB-02 reserve: the file cap counts files and open uploads", async () => {
    const db = setup();
    db.raw
      .prepare(
        "INSERT INTO library_file (id, user_id, name, ext, bytes, r2_key, status, created_at, updated_at) VALUES ('f0', 'u1', 'a', 'pdf', 1, 'k0', 'ready', 0, 0)",
      )
      .run();
    expect(await reserveLibrary(db, upload("u1", { bytes: 1 }), LIMITS)).toBeNull();
    expect(await reserveLibrary(db, upload("u1", { bytes: 1 }), LIMITS)).toBeNull();
    expect(await reserveLibrary(db, upload("u1", { bytes: 1 }), LIMITS)).toBe("library_full");
  });

  it("LIB-02 reserve: a second open upload of the same file is a twin, not a second reservation", async () => {
    const db = setup();
    const a = upload("u1");
    expect(await reserveLibrary(db, a, LIMITS)).toBeNull();
    const b = upload("u1", { fingerprint: a.fingerprint });
    expect(await reserveLibrary(db, b, LIMITS)).toBe("twin");
    expect(counters(db).reserved).toBe(GIB);
  });

  it("LIB-02 reserve: an expired upload is no twin and takes no file slot, as resume already holds", async () => {
    const db = setup();
    const old = upload("u1", { bytes: 1, expiresAt: NOW });
    expect(await reserveLibrary(db, old, LIMITS)).toBeNull();
    expect(await findOpen(db, { kind: "library", userId: "u1" }, old.fingerprint, NOW)).toBeNull();
    expect(await reserveLibrary(db, upload("u1", { bytes: 1, fingerprint: old.fingerprint }), LIMITS)).toBeNull();
    expect(await reserveLibrary(db, upload("u1", { bytes: 1 }), { ...LIMITS, maxFiles: 2 })).toBeNull();
  });

  it("LIB-02 reserve: a refused file takes no file slot", async () => {
    const db = setup();
    for (const [id, status] of [
      ["f1", "refused"],
      ["f2", "refused"],
      ["f3", "ready"],
    ]) {
      db.raw
        .prepare(
          "INSERT INTO library_file (id, user_id, name, ext, bytes, r2_key, status, created_at, updated_at) VALUES (?, 'u1', 'a', 'pdf', 1, ?, ?, 0, 0)",
        )
        .run(id as string, `k-${id}`, status as string);
    }
    expect(await reserveLibrary(db, upload("u1", { bytes: 1 }), LIMITS)).toBeNull();
    expect(await reserveLibrary(db, upload("u1", { bytes: 1 }), LIMITS)).toBeNull();
    expect(await reserveLibrary(db, upload("u1", { bytes: 1 }), LIMITS)).toBe("library_full");
  });

  it("LIB-02 reserve: a refusal whose cause is gone when it is read is retried, never guessed", async () => {
    const db = setup();
    const full = upload("u1", { bytes: 5 * GIB });
    expect(await reserveLibrary(db, full, LIMITS)).toBeNull();
    let first = true;
    const racing = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async (statements: Parameters<typeof db.batch>[0]) => {
        const out = await db.batch(statements);
        if (first) {
          first = false;
          await releaseLibrary(db, { id: full.id, userId: "u1", bytes: full.bytes }, NOW);
        }
        return out;
      },
    };
    const next = upload("u1", { bytes: GIB });
    expect(await reserveLibrary(racing, next, LIMITS)).toBeNull();
    expect(counters(db).reserved).toBe(GIB);
  });

  it("LIB-02 race: concurrent reserves of 1 GiB against 5 GiB admit exactly five", async () => {
    const db = setup();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => reserveLibrary(db, upload("u1"), { ...LIMITS, maxFiles: 100 })),
    );
    expect(results.filter((r) => r === null)).toHaveLength(5);
    expect(counters(db).reserved).toBe(5 * GIB);
    const sum = db.raw.prepare("SELECT SUM(bytes) AS s FROM upload WHERE user_id = 'u1'").get() as { s: number };
    expect(sum.s).toBe(5 * GIB);
  });
});

describe("LIB-02 settle, release, refuse and reconcile", () => {
  async function reserved(db: TestDb, over: Partial<NewUpload> = {}) {
    const n = upload("u1", over);
    expect(await reserveLibrary(db, n, LIMITS)).toBeNull();
    return n;
  }
  const ref = (n: NewUpload) => ({ id: n.id, userId: "u1", fileId: n.fileId, bytes: n.bytes });

  it("settles under its claim: reserved becomes used, the file is checking, the row closes", async () => {
    const db = setup();
    const n = await reserved(db);
    expect(await claim(db, n.id, NOW)).toBe(true);
    expect(await settleLibrary(db, ref(n), NOW, NOW + 5)).toBe(true);
    expect(counters(db)).toEqual({ used: GIB, reserved: 0 });
    expect(db.raw.prepare("SELECT status, r2_key AS k, bytes FROM library_file WHERE id = ?").get(n.fileId)).toEqual({
      status: "checking",
      k: n.r2Key,
      bytes: GIB,
    });
    expect((await get(db, n.id))?.completedAt).toBe(NOW + 5);
  });

  it("LIB-02 settle: a repeat settles nothing twice", async () => {
    const db = setup();
    const n = await reserved(db);
    await claim(db, n.id, NOW);
    expect(await settleLibrary(db, ref(n), NOW, NOW)).toBe(true);
    expect(await settleLibrary(db, ref(n), NOW, NOW)).toBe(false);
    expect(counters(db)).toEqual({ used: GIB, reserved: 0 });
  });

  it("LIB-02 settle: a stale or foreign claim settles nothing", async () => {
    const db = setup();
    const n = await reserved(db);
    await claim(db, n.id, NOW);
    expect(await settleLibrary(db, ref(n), NOW + 1, NOW)).toBe(false);
    expect(counters(db)).toEqual({ used: 0, reserved: GIB });
    expect(db.raw.prepare("SELECT count(*) AS c FROM library_file").get()).toEqual({ c: 0 });
  });

  it("LIB-02 settle: an owner the purge took meanwhile gets no file", async () => {
    const db = setup();
    const n = await reserved(db);
    await claim(db, n.id, NOW);
    db.raw.prepare("UPDATE app_user SET status = 'purging' WHERE id = 'u1'").run();
    expect(await settleLibrary(db, ref(n), NOW, NOW)).toBe(false);
    expect(db.raw.prepare("SELECT count(*) AS c FROM library_file").get()).toEqual({ c: 0 });
    expect(counters(db).used).toBe(0);
    expect((await get(db, n.id))?.completedAt).toBeNull();
  });

  it("releases an unclaimed upload: the reservation returns and the row closes, once", async () => {
    const db = setup();
    const n = await reserved(db);
    expect(await releaseLibrary(db, ref(n), NOW)).toBe(true);
    expect(counters(db)).toEqual({ used: 0, reserved: 0 });
    expect(await releaseLibrary(db, ref(n), NOW)).toBe(false);
    expect(counters(db).reserved).toBe(0);
  });

  it("LIB-02 release: a fresh claim blocks it, a stale one or its own does not", async () => {
    const db = setup();
    const n = await reserved(db);
    await claim(db, n.id, NOW);
    expect(await releaseLibrary(db, ref(n), NOW + 1000)).toBe(false);
    expect(counters(db).reserved).toBe(GIB);
    expect(await releaseLibrary(db, ref(n), NOW + CLAIM_MS + 1)).toBe(true);
    expect(counters(db).reserved).toBe(0);

    const m = await reserved(db);
    await claim(db, m.id, NOW);
    expect(await releaseLibrary(db, ref(m), NOW + 1000, NOW)).toBe(true);
    expect(counters(db).reserved).toBe(0);
  });

  it("LIB-02 refusal: a refused file returns its bytes once and becomes refused", async () => {
    const db = setup();
    const n = await reserved(db);
    await claim(db, n.id, NOW);
    await settleLibrary(db, ref(n), NOW, NOW);
    const file = { id: n.fileId, userId: "u1", bytes: n.bytes };
    expect(await refuseLibrary(db, file, "macro_content", NOW + 9)).toBe(true);
    expect(await refuseLibrary(db, file, "macro_content", NOW + 9)).toBe(false);
    expect(counters(db)).toEqual({ used: 0, reserved: 0 });
    expect(db.raw.prepare("SELECT status, refusal FROM library_file WHERE id = ?").get(n.fileId)).toEqual({
      status: "refused",
      refusal: "macro_content",
    });
  });

  it("marks a checking file ready with its digests and the validated type, once", async () => {
    const db = setup();
    const n = await reserved(db);
    await claim(db, n.id, NOW);
    await settleLibrary(db, ref(n), NOW, NOW);
    const file = { id: n.fileId, userId: "u1" };
    expect(await markReady(db, file, { sha256: "ab".repeat(32), crc32: 4_000_000_000, ext: "pptx" }, NOW + 1)).toBe(
      true,
    );
    expect(await markReady(db, file, { sha256: "cd".repeat(32), crc32: 1, ext: "pptx" }, NOW + 2)).toBe(false);
    expect(db.raw.prepare("SELECT status, sha256, crc32 FROM library_file WHERE id = ?").get(n.fileId)).toEqual({
      status: "ready",
      sha256: "ab".repeat(32),
      crc32: 4_000_000_000,
    });
  });

  it("re-runs a stuck check only after the claim window", async () => {
    const db = setup();
    const n = await reserved(db);
    await claim(db, n.id, NOW);
    await settleLibrary(db, ref(n), NOW, NOW);
    const file = { id: n.fileId, userId: "u1" };
    expect(await claimCheck(db, file, NOW + 1000)).toBe(false);
    expect(await claimCheck(db, file, NOW + CLAIM_MS + 1)).toBe(true);
    expect(await claimCheck(db, file, NOW + CLAIM_MS + 2)).toBe(false);
  });

  it("LIB-02 reconcile: heals drift from the rows and reports it, and reports none when clean", async () => {
    const db = setup();
    const n = await reserved(db);
    expect(await reconcileUser(db, "u1")).toBeNull();
    db.raw.prepare("UPDATE app_user SET reserved_bytes = 7, used_bytes = 9 WHERE id = 'u1'").run();
    expect(await reconcileUser(db, "u1")).toEqual({
      userId: "u1",
      before: { used: 9, reserved: 7 },
      after: { used: 0, reserved: n.bytes },
    });
    expect(counters(db)).toEqual({ used: 0, reserved: GIB });
    expect(await reconcileUser(db, "ghost")).toBeNull();
  });

  it("LIB-02 reconcile: after every upload is released both counters are zero", async () => {
    const db = setup();
    const all = await Promise.all([reserved(db), reserved(db), reserved(db)]);
    for (const n of all) await releaseLibrary(db, ref(n), NOW);
    expect(counters(db)).toEqual({ used: 0, reserved: 0 });
    expect(await reconcileUser(db, "u1")).toBeNull();
  });
});

describe("UP-02 mints, UP-08 parts, claims and sweeps (store statements)", () => {
  async function open(db: TestDb, over: Partial<NewUpload> = {}) {
    const n = upload("u1", { bytes: 40, parts: 2, ...over });
    expect(await reserveLibrary(db, n, LIMITS)).toBeNull();
    return n;
  }

  it("UP-02 mints: three URLs per part, a batch more per URL lifetime, and none once closed", async () => {
    const db = setup();
    const n = await open(db);
    const budget = { ttlMs: 300_000, refill: 8 };
    expect(await chargeMints(db, n.id, 6, NOW, budget)).toBe(true);
    expect(await chargeMints(db, n.id, 1, NOW + 299_999, budget)).toBe(false);
    expect((await get(db, n.id))?.mints).toBe(6);
    expect(await chargeMints(db, n.id, 8, NOW + 300_000, budget)).toBe(true);
    expect(await chargeMints(db, n.id, 1, NOW + 300_000, budget)).toBe(false);
    await releaseLibrary(db, { id: n.id, userId: "u1", bytes: n.bytes }, NOW);
    expect(await chargeMints(db, n.id, 0, NOW + 10 * 300_000, budget)).toBe(false);
  });

  it("UP-08 resume: a part is recorded once per number, a repeat replaces it, a closed upload takes none", async () => {
    const db = setup();
    const n = await open(db);
    expect(await recordPart(db, n.id, 1, '"aa"', 20, NOW)).toBe(true);
    expect(await recordPart(db, n.id, 1, '"bb"', 20, NOW + 1)).toBe(true);
    expect(await recordPart(db, n.id, 2, '"cc"', 20, NOW + 2)).toBe(true);
    expect(await doneParts(db, n.id)).toEqual([
      { n: 1, etag: '"bb"', bytes: 20 },
      { n: 2, etag: '"cc"', bytes: 20 },
    ]);
    await releaseLibrary(db, { id: n.id, userId: "u1", bytes: n.bytes }, NOW);
    expect(await recordPart(db, n.id, 2, '"dd"', 20, NOW)).toBe(false);
    expect(await recordPart(db, "ghost", 1, '"aa"', 20, NOW)).toBe(false);
  });

  it("claims once per window and again when it has gone stale", async () => {
    const db = setup();
    const n = await open(db);
    expect(await claim(db, n.id, NOW)).toBe(true);
    expect(await claim(db, n.id, NOW + 1)).toBe(false);
    expect(await claim(db, n.id, NOW + CLAIM_MS + 1)).toBe(true);
  });

  it("finds the open upload of a fingerprint, unexpired, for the owner only", async () => {
    const db = setup();
    addUser(db, "u2");
    const n = await open(db);
    expect((await findOpen(db, { kind: "library", userId: "u1" }, n.fingerprint, NOW))?.id).toBe(n.id);
    expect(await findOpen(db, { kind: "library", userId: "u2" }, n.fingerprint, NOW)).toBeNull();
    expect(await findOpen(db, { kind: "library", userId: "u1" }, n.fingerprint, n.expiresAt + 1)).toBeNull();
  });

  it("lists a user's open uploads with how many parts are done", async () => {
    const db = setup();
    const n = await open(db);
    await recordPart(db, n.id, 1, '"aa"', 20, NOW);
    expect(await listOpen(db, { kind: "library", userId: "u1" }, NOW)).toEqual([
      { id: n.id, name: n.name, bytes: 40, parts: 2, done: 1, createdAt: NOW },
    ]);
  });

  it("finds an upload by the hash of its Idempotency-Key within the window", async () => {
    const db = setup();
    const n = await open(db, { idemKey: "hash1" });
    expect((await findByIdem(db, "u1", "hash1", NOW - 1))?.id).toBe(n.id);
    expect(await findByIdem(db, "u1", "hash1", NOW + 1)).toBeNull();
    expect(await findByIdem(db, "u2", "hash1", NOW - 1)).toBeNull();
  });

  it("the sweeps find stale completes and expired opens, and skip a fresh claim", async () => {
    const db = setup();
    const stale = await open(db);
    const fresh = await open(db);
    const expired = await open(db, { expiresAt: NOW - 1 });
    await claim(db, stale.id, NOW - CLAIM_MS - 5);
    await claim(db, fresh.id, NOW);
    expect((await staleCompletes(db, NOW, 10)).map((u) => u.id)).toEqual([stale.id]);
    expect((await expiredOpen(db, NOW, 10)).map((u) => u.id)).toEqual([expired.id]);
  });

  it("deletes closed uploads and their parts after the retention, bounded per call", async () => {
    const db = setup();
    const a = await open(db);
    const b = await open(db);
    await recordPart(db, a.id, 1, '"aa"', 20, NOW);
    await releaseLibrary(db, { id: a.id, userId: "u1", bytes: a.bytes }, NOW);
    await releaseLibrary(db, { id: b.id, userId: "u1", bytes: b.bytes }, NOW);
    expect(await deleteClosed(db, NOW, 10)).toBe(0);
    expect(await deleteClosed(db, NOW + 1, 1)).toBe(1);
    expect(await deleteClosed(db, NOW + 1, 10)).toBe(1);
    expect(db.raw.prepare("SELECT count(*) AS c FROM upload_part").get()).toEqual({ c: 0 });
  });
});

describe("a guest upload shares the table under the session's caps", () => {
  const CAPS = { maxFiles: 12, maxOpen: 3 };
  const guest = (sessionId: string, over: Partial<NewUpload> = {}): NewUpload => ({
    ...upload("x"),
    owner: { kind: "guest", sessionId, screenRef: "screen1" },
    r2Key: "g/abc",
    ...over,
  });

  it("inserts a guest row with the session and screen and no user, in the guest bucket", async () => {
    const db = setup();
    const a = guest("s1");
    expect(await insertGuest(db, a, CAPS)).toBeNull();
    expect(await get(db, a.id)).toMatchObject({
      ownerKind: "guest",
      userId: null,
      sessionId: "s1",
      screenRef: "screen1",
      bucket: "guest",
    });
  });

  it("holds 3 open at once per session, and takes another once one closes; another session has its own", async () => {
    const db = setup();
    const open = [guest("s1"), guest("s1"), guest("s1")];
    for (const g of open) expect(await insertGuest(db, g, CAPS)).toBeNull();
    expect(await insertGuest(db, guest("s1"), CAPS)).toBe("upload_busy");
    expect(await insertGuest(db, guest("s2"), CAPS)).toBeNull();
    await claim(db, open[0]?.id ?? "", NOW);
    expect(await completeGuest(db, open[0]?.id ?? "", NOW, NOW)).toBe(true);
    expect(await insertGuest(db, guest("s1"), CAPS)).toBeNull();
  });

  it("an expired open upload no longer holds an open slot", async () => {
    const db = setup();
    for (let i = 0; i < 3; i++) expect(await insertGuest(db, guest("s1", { expiresAt: NOW - 1 }), CAPS)).toBeNull();
    expect(await insertGuest(db, guest("s1"), CAPS)).toBeNull();
  });

  it("holds 12 files in all per session: a completed one counts, an aborted one gives its slot back", async () => {
    const db = setup();
    const rows: NewUpload[] = [];
    for (let i = 0; i < 12; i++) {
      const g = guest("s1");
      expect(await insertGuest(db, g, CAPS)).toBeNull();
      await claim(db, g.id, NOW);
      expect(await completeGuest(db, g.id, NOW, NOW)).toBe(true);
      rows.push(g);
    }
    expect(await insertGuest(db, guest("s1"), CAPS)).toBe("already_uploaded");
    expect(await closeGuest(db, rows[0]?.id ?? "", NOW)).toBe(false);
    db.raw.prepare("UPDATE upload SET completed_at = NULL, completing_at = NULL WHERE id = ?").run(rows[0]?.id ?? "");
    expect(await closeGuest(db, rows[0]?.id ?? "", NOW)).toBe(true);
    expect(await insertGuest(db, guest("s1"), CAPS)).toBeNull();
  });

  it("UP-09 a second insert of the same file while one is live is the twin, never a second row", async () => {
    const db = setup();
    const a = guest("s1");
    expect(await insertGuest(db, a, CAPS)).toBeNull();
    expect(await insertGuest(db, guest("s1", { fingerprint: a.fingerprint }), CAPS)).toBe("twin");
    expect(db.raw.prepare("SELECT count(*) AS c FROM upload WHERE session_id = 's1'").get()).toEqual({ c: 1 });
  });

  it("lists a session's live uploads and none of another owner", async () => {
    const db = setup();
    const a = guest("s1");
    await insertGuest(db, a, CAPS);
    await insertGuest(db, guest("s2"), CAPS);
    expect(
      (await listOpen(db, { kind: "guest", sessionId: "s1", screenRef: "screen1" }, NOW)).map((u) => u.id),
    ).toEqual([a.id]);
    expect(await listOpen(db, { kind: "library", userId: "u1" }, NOW)).toEqual([]);
  });
});
