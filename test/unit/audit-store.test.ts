import { describe, expect, it } from "vitest";
import { type AuditEvent, type SessionContext, userScope } from "../../src/worker/audit.ts";
import { D1AuditLog } from "../../src/worker/audit-d1.ts";
import { addUser, testDb } from "./d1-shim.ts";

const T0 = Date.parse("2026-03-01T10:00:00Z");
const DAY = 86_400_000;
const ctx = (over: Partial<SessionContext> = {}): SessionContext => ({
  screenRef: "ref1",
  roomId: null,
  mode: "live",
  kind: "owner",
  userId: null,
  ...over,
});
const ev = (type: AuditEvent["type"], at: number, over: Partial<AuditEvent> = {}): AuditEvent => ({
  sessionId: "s1",
  at,
  actor: "phone",
  type,
  detail: {},
  ...over,
});

function setup() {
  const db = testDb();
  addUser(db, "u1");
  db.raw.prepare("UPDATE app_user SET email = 'ada@example.test' WHERE id = 'u1'").run();
  return { db, log: new D1AuditLog(db) };
}

async function fullSession(log: D1AuditLog, id: string, at: number, over: Partial<SessionContext> = {}) {
  const base = { sessionId: id, session: ctx(over) };
  await log.record(ev("claimed", at, base));
  await log.record(
    ev("approved", at + 1000, { ...base, detail: { fileName: "Plan.pptx", source: "graph" }, actor: "phone" }),
  );
  await log.record(ev("link.fetched", at + 2000, { sessionId: id, actor: "system", detail: { purpose: "protocol" } }));
  await log.record(ev("ended", at + 3000, { ...base, detail: { reason: "phone" } }));
}

describe("audit store: one row per event", () => {
  it("records the whole session and mirrors it into the session row", async () => {
    const { db, log } = setup();
    await fullSession(log, "s1", T0, { userId: "u1", roomId: null });
    const events = db.raw.prepare("SELECT type, actor FROM audit_event ORDER BY id").all();
    expect(events.map((e) => e.type)).toEqual(["claimed", "approved", "link.fetched", "ended"]);
    expect(db.raw.prepare("SELECT * FROM session WHERE id = 's1'").get()).toMatchObject({
      mode: "live",
      kind: "owner",
      user_id: "u1",
      claimed_at: T0,
      approved_at: T0 + 1000,
      first_open_at: T0 + 2000,
      open_mode: "protocol",
      ended_at: T0 + 3000,
      end_reason: "phone",
      file_name: "Plan.pptx",
      source: "graph",
    });
  });

  it("keeps the first open time when links are fetched again", async () => {
    const { db, log } = setup();
    await fullSession(log, "s1", T0);
    await log.record(ev("link.fetched", T0 + 9000, { actor: "system", detail: { purpose: "protocol", count: 2 } }));
    expect(db.raw.prepare("SELECT first_open_at FROM session").get()).toEqual({ first_open_at: T0 + 2000 });
  });

  it("DATA-04 content: drops any key outside the allowed set, so a token or URL cannot be stored", async () => {
    const { db, log } = setup();
    const detail = {
      fileName: "a.pptx",
      token: "SECRET-TOKEN",
      url: "https://x.example/f/abc",
      ip: "203.0.113.9",
    } as unknown as AuditEvent["detail"];
    await log.record(ev("approved", T0, { session: ctx(), detail }));
    const stored = String(db.raw.prepare("SELECT detail FROM audit_event").get()?.detail);
    expect(JSON.parse(stored)).toEqual({ fileName: "a.pptx" });
    expect(stored).not.toMatch(/SECRET|https|203\.0/);
  });

  it("a demo session keeps no account even when one is passed", async () => {
    const { db, log } = setup();
    await log.record(ev("claimed", T0, { session: ctx({ mode: "demo", userId: "u1" }) }));
    expect(db.raw.prepare("SELECT user_id FROM session").get()).toEqual({ user_id: null });
  });

  it("stores the event even when the user id is unknown, instead of failing the foreign key", async () => {
    const { db, log } = setup();
    await log.record(ev("claimed", T0, { session: ctx({ userId: "ghost" }) }));
    expect(db.raw.prepare("SELECT user_id FROM session").get()).toEqual({ user_id: null });
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM audit_event").get()).toEqual({ n: 1 });
  });

  it("a guest upload records the guest source and the refusal cause", async () => {
    const { db, log } = setup();
    await log.record(ev("claimed", T0, { session: ctx({ kind: "guest" }) }));
    await log.record(ev("guest.refused", T0 + 1, { detail: { cause: "bad_structure" } }));
    await log.record(ev("guest.uploaded", T0 + 2, { detail: { fileName: "Talk.pdf", source: "guest" } }));
    expect(db.raw.prepare("SELECT source, file_name FROM session").get()).toEqual({
      source: "guest",
      file_name: "Talk.pdf",
    });
    expect(db.raw.prepare("SELECT detail FROM audit_event WHERE type = 'guest.refused'").get()).toEqual({
      detail: '{"cause":"bad_structure"}',
    });
  });

  it("a cancel ends the session row with its reason", async () => {
    const { db, log } = setup();
    await log.record(ev("claimed", T0, { session: ctx() }));
    await log.record(ev("canceled", T0 + 5, { detail: { reason: "canceled" } }));
    expect(db.raw.prepare("SELECT ended_at, end_reason FROM session").get()).toEqual({
      ended_at: T0 + 5,
      end_reason: "canceled",
    });
  });
});

describe("DATA-05 dsar: a user reads their own rows", () => {
  it("returns only that user's events, newest first, with a cursor", async () => {
    const { log } = setup();
    await fullSession(log, "s1", T0, { userId: "u1" });
    await fullSession(log, "s2", T0 + DAY, { userId: null });
    const rows = await log.forUser("u1", 3);
    expect(rows.map((r) => r.type)).toEqual(["ended", "link.fetched", "approved"]);
    expect(rows[0]).toMatchObject({ userEmail: "ada@example.test", mode: "live", kind: "owner" });
    const older = await log.forUser("u1", 10, rows[2]?.at);
    expect(older.map((r) => r.type)).toEqual(["claimed"]);
  });
});

describe("F12 DATA-05 dsar: account events belong to the user, not to a session", () => {
  it("DATA-05 dsar: a user reads their grant rows with their session rows, and never another user's", async () => {
    const { db, log } = setup();
    addUser(db, "u2");
    await fullSession(log, "s1", T0, { userId: "u1" });
    await log.record(ev("grant.created", T0 - 1000, { sessionId: userScope("u1") }));
    await log.record(ev("grant.created", T0 - 500, { sessionId: userScope("u2") }));
    const types = (await log.forUser("u1", 10)).map((r) => r.type);
    expect(types).toEqual(["ended", "link.fetched", "approved", "claimed", "grant.created"]);
    expect((await log.forUser("u2", 10)).map((r) => r.type)).toEqual(["grant.created"]);
  });

  it("DATA-04 erase: erasure detaches the grant rows from the user id, so nothing links them back", async () => {
    const { db, log } = setup();
    await log.record(ev("grant.created", T0, { sessionId: userScope("u1") }));
    await log.record(ev("grant.deleted", T0 + 1, { sessionId: userScope("u1") }));
    await log.anonymizeUser("u1");
    expect(await log.forUser("u1", 10)).toEqual([]);
    const ids = db.raw.prepare("SELECT DISTINCT session_id FROM audit_event").all();
    expect(ids).toEqual([{ session_id: "erased" }]);
  });
});

describe("DATA-04 erase: erasure keeps the session and drops the person and the file name", () => {
  it("clears user id and file name in the session and the audit detail, and leaves other users alone", async () => {
    const { db, log } = setup();
    addUser(db, "u2");
    await fullSession(log, "s1", T0, { userId: "u1" });
    await fullSession(log, "s2", T0, { userId: "u2" });
    expect(await log.anonymizeUser("u1")).toBe(1);
    expect(db.raw.prepare("SELECT user_id, file_name, approved_at FROM session WHERE id = 's1'").get()).toEqual({
      user_id: null,
      file_name: null,
      approved_at: T0 + 1000,
    });
    const s1 = db.raw.prepare("SELECT detail FROM audit_event WHERE session_id = 's1' AND type = 'approved'").get();
    expect(s1).toEqual({ detail: '{"source":"graph"}' });
    expect(db.raw.prepare("SELECT file_name FROM session WHERE id = 's2'").get()).toEqual({ file_name: "Plan.pptx" });
    expect(await log.forUser("u1", 10)).toEqual([]);
    expect(await log.anonymizeUser("u1")).toBe(0);
  });
});

describe("DATA-02 retention: audit purge", () => {
  it("deletes live rows past the live period and demo rows past the demo period, session rows with them", async () => {
    const { db, log } = setup();
    await fullSession(log, "old-live", T0 - 200 * DAY);
    await fullSession(log, "new-live", T0 - 100 * DAY);
    await fullSession(log, "old-demo", T0 - 10 * DAY, { mode: "demo" });
    await fullSession(log, "new-demo", T0 - 2 * DAY, { mode: "demo" });
    const deleted = await log.purge(T0, { liveDays: 180, demoDays: 7 });
    expect(deleted).toBe(10); // two sessions of four events and one session row
    const left = db.raw
      .prepare("SELECT id FROM session ORDER BY id")
      .all()
      .map((r) => r.id);
    expect(left).toEqual(["new-demo", "new-live"]);
    const events = db.raw
      .prepare("SELECT DISTINCT session_id FROM audit_event ORDER BY 1")
      .all()
      .map((r) => r.session_id);
    expect(events).toEqual(["new-demo", "new-live"]);
  });

  it("is idempotent", async () => {
    const { log } = setup();
    await fullSession(log, "old", T0 - 200 * DAY);
    expect(await log.purge(T0, { liveDays: 180, demoDays: 7 })).toBeGreaterThan(0);
    expect(await log.purge(T0, { liveDays: 180, demoDays: 7 })).toBe(0);
  });
});

describe("export stream", () => {
  async function read(stream: ReadableStream<Uint8Array>): Promise<string> {
    return new Response(stream).text();
  }

  it("streams every page of JSON as one valid array, bounded by the range", async () => {
    const { log } = setup();
    for (let i = 0; i < 620; i++) await log.record(ev("link.fetched", T0 + i, { sessionId: `x${i}` }));
    await log.record(ev("link.fetched", T0 + DAY, { sessionId: "out" }));
    const parsed = JSON.parse(await read(await log.export({ orgId: null, from: T0, to: T0 + 1000, format: "json" })));
    expect(parsed).toHaveLength(620);
    expect(parsed[0]).toMatchObject({ type: "link.fetched", time: new Date(T0).toISOString() });
  });

  it("gives an empty array and a header-only CSV for an empty range", async () => {
    const { log } = setup();
    expect(await read(await log.export({ orgId: null, from: 0, to: 1, format: "json" }))).toBe("[]");
    const csv = await read(await log.export({ orgId: null, from: 0, to: 1, format: "csv" }));
    expect(csv.split("\r\n")).toHaveLength(2);
    expect(csv.startsWith("id,time,session,room")).toBe(true);
  });

  it("filters by organization through the room", async () => {
    const { db, log } = setup();
    db.raw.prepare("INSERT INTO org (id, name, created_at) VALUES ('o1', 'Org', 0), ('o2', 'Other', 0)").run();
    const rooms: [string, string][] = [
      ["r1", "o1"],
      ["r2", "o2"],
    ];
    for (const [id, org] of rooms) {
      db.raw
        .prepare(
          "INSERT INTO room (id, org_id, name, screen_ref, key_hash, key_kid, key_rotated_at, created_at) VALUES (?, ?, ?, ?, 'h', 1, 0, 0)",
        )
        .run(id, org, `Room ${id}`, `ref-${id}`);
    }
    await log.record(ev("claimed", T0, { sessionId: "a", session: ctx({ roomId: "r1" }) }));
    await log.record(ev("claimed", T0, { sessionId: "b", session: ctx({ roomId: "r2" }) }));
    const rows = JSON.parse(await read(await log.export({ orgId: "o1", from: 0, to: T0 + 1, format: "json" })));
    expect(rows.map((r: { room: string }) => r.room)).toEqual(["Room r1"]);
  });
});
