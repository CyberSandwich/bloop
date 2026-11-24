import { describe, expect, it } from "vitest";
import { type Config, parseConfig } from "../../src/worker/config.ts";
import { closeStaleSessions, runRetention } from "../../src/worker/retention.ts";
import { PROD_VARS } from "../env-vars.ts";
import { addUser, testDb } from "./d1-shim.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-01T03:30:00Z");

function config(over: Record<string, string> = {}): Config {
  const r = parseConfig({ ...PROD_VARS, ...over });
  if (!r.ok) throw new Error(r.problems.join());
  return r.config;
}

/** One of everything, aged by `age` days. */
function seed(db: ReturnType<typeof testDb>, tag: string, age: number, mode: "live" | "demo" = "live") {
  const at = NOW - age * DAY;
  db.raw
    .prepare("INSERT INTO session (id, screen_ref, mode, kind, claimed_at, ended_at) VALUES (?, 'r', ?, 'owner', ?, ?)")
    .run(`s-${tag}`, mode, at, at + 1000);
  db.raw
    .prepare("INSERT INTO audit_event (session_id, at, actor, type) VALUES (?, ?, 'phone', 'claimed')")
    .run(`s-${tag}`, at);
  db.raw
    .prepare("INSERT INTO metric_event (at, mode, kind, name, ms) VALUES (?, ?, 'owner', 'scan_to_open_ms', 100)")
    .run(at, mode);
  db.raw
    .prepare(
      "INSERT INTO guest_file (session_id, r2_key, bytes, type, sha256, name, created_at, deleted_at) VALUES (?, 'k', 1, 'pdf', 'h', 'n', ?, ?)",
    )
    .run(`s-${tag}`, at, at + 1000);
}

const count = (db: ReturnType<typeof testDb>, table: string) =>
  (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("DATA-02 retention: the daily job moves past each period", () => {
  it("deletes audit, sessions, metrics, guest rows and passes only past their own period", async () => {
    const db = testDb();
    addUser(db, "host");
    db.raw.prepare("UPDATE app_user SET last_seen_at = ?").run(NOW);
    seed(db, "audit-old", 181);
    seed(db, "audit-ok", 179);
    seed(db, "demo-old", 8, "demo");
    seed(db, "demo-ok", 6, "demo");
    db.raw
      .prepare(
        "INSERT INTO guest_pass (id_hash, host_user_id, expires_at) VALUES ('old', 'host', ?), ('new', 'host', ?)",
      )
      .run(NOW - 1, NOW + DAY);
    const report = await runRetention({ DB: db }, config(), NOW);
    const ids = db.raw
      .prepare("SELECT id FROM session ORDER BY id")
      .all()
      .map((r) => r.id);
    expect(ids).toEqual(["s-audit-ok", "s-demo-ok"]);
    expect(count(db, "audit_event")).toBe(2);
    // Metrics keep 90 days and guest rows 30 days after deletion: the 181 and 179 day seeds are past both.
    expect(count(db, "metric_event")).toBe(2);
    expect(count(db, "metric_daily")).toBe(2);
    expect(count(db, "guest_file")).toBe(2);
    expect(db.raw.prepare("SELECT id_hash FROM guest_pass").all()).toEqual([{ id_hash: "new" }]);
    expect(report.guestPasses).toBe(1);
  });

  it("honors the configured periods", async () => {
    const db = testDb();
    seed(db, "a", 40);
    seed(db, "b", 5);
    await runRetention({ DB: db }, config({ AUDIT_RETENTION_DAYS: "30", METRICS_RETENTION_DAYS: "3" }), NOW);
    expect(db.raw.prepare("SELECT id FROM session").all()).toEqual([{ id: "s-b" }]);
    expect(count(db, "metric_event")).toBe(0);
    expect(count(db, "metric_daily")).toBe(2);
  });

  it("calls the auth maintenance: idle grants and expired phone sessions go, user rows follow", async () => {
    const db = testDb();
    addUser(db, "idle");
    addUser(db, "active");
    db.raw.prepare("UPDATE app_user SET last_seen_at = ?").run(NOW - 60 * DAY);
    db.raw
      .prepare(
        "INSERT INTO token_grant (user_id, kid, dek_wrapped, scope, version, updated_at) VALUES ('idle', 'k1', x'00', 's', 1, ?), ('active', 'k1', x'00', 's', 1, ?)",
      )
      .run(NOW - 31 * DAY, NOW - DAY);
    db.raw
      .prepare(
        "INSERT INTO phone_session (id_hash, user_id, created_at, last_seen_at, expires_at) VALUES ('p', 'idle', 0, 0, ?)",
      )
      .run(NOW - 1);
    const report = await runRetention({ DB: db }, config(), NOW);
    expect(report.auth).toMatchObject({ idleGrants: 1, expiredSessions: 1 });
    // The idle user has no grant or session now and was last seen 60 days ago; the active one keeps its grant.
    expect(db.raw.prepare("SELECT id FROM app_user").all()).toEqual([{ id: "active" }]);
    expect(report.userRows).toBe(1);
  });

  it("is idempotent: a second run at the same instant changes nothing", async () => {
    const db = testDb();
    seed(db, "old", 400);
    seed(db, "new", 1);
    await runRetention({ DB: db }, config(), NOW);
    const second = await runRetention({ DB: db }, config(), NOW);
    expect(second).toEqual({
      auditRows: 0,
      metricEvents: 0,
      guestFileRows: 0,
      guestPasses: 0,
      r2OpRows: 0,
      userRows: 0,
      auth: { idleGrants: 0, expiredSessions: 0, staleKeys: 0 },
    });
  });
});

describe("DATA-02 retention: the hourly closer", () => {
  it("ends rows still open 95 minutes after approval or claim, and leaves live and ended rows", async () => {
    const db = testDb();
    const ins = db.raw.prepare(
      "INSERT INTO session (id, screen_ref, mode, kind, claimed_at, approved_at, ended_at) VALUES (?, 'r', 'live', 'owner', ?, ?, ?)",
    );
    const min = 60_000;
    ins.run("stale-approved", NOW - 300 * min, NOW - 100 * min, null);
    ins.run("stale-claimed", NOW - 100 * min, null, null);
    ins.run("running", NOW - 100 * min, NOW - 20 * min, null);
    ins.run("done", NOW - 300 * min, NOW - 290 * min, NOW - 280 * min);
    expect(await closeStaleSessions({ DB: db }, NOW)).toBe(2);
    expect(await closeStaleSessions({ DB: db }, NOW)).toBe(0);
    const rows = db.raw.prepare("SELECT id, ended_at, end_reason FROM session ORDER BY id").all();
    expect(rows).toEqual([
      { id: "done", ended_at: NOW - 280 * min, end_reason: null },
      { id: "running", ended_at: null, end_reason: null },
      { id: "stale-approved", ended_at: NOW, end_reason: "auto" },
      { id: "stale-claimed", ended_at: NOW, end_reason: "auto" },
    ]);
  });
});

describe("R2 cap: retention of the operation counters", () => {
  it("keeps 13 months and drops older ones", async () => {
    const db = testDb();
    for (const month of ["2025-04", "2025-05", "2026-06"]) {
      db.raw.prepare("INSERT INTO r2_ops (month, class, n) VALUES (?, 'A', 1)").run(month);
    }
    const report = await runRetention({ DB: db }, config(), NOW);
    expect(report.r2OpRows).toBe(1);
    expect(db.raw.prepare("SELECT month FROM r2_ops ORDER BY month").all()).toEqual([
      { month: "2025-05" },
      { month: "2026-06" },
    ]);
  });

  it("defaults the caps to 50% of the free tier and reads them from the variables", () => {
    expect(config()).toMatchObject({ r2ClassAMonthlyCap: 500_000, r2ClassBMonthlyCap: 5_000_000 });
    expect(config({ R2_CLASS_A_MONTHLY_CAP: "7", R2_CLASS_B_MONTHLY_CAP: "9" })).toMatchObject({
      r2ClassAMonthlyCap: 7,
      r2ClassBMonthlyCap: 9,
    });
  });
});
