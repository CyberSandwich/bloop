// The cron jobs (threat-model section 10, DATA-02). Plain functions over a D1 slice and a clock, so a test
// moves time instead of waiting. Every statement is a bounded delete or a conditional update: a second run
// at the same instant changes nothing.
import { D1AuditLog } from "./audit-d1.ts";
import { type Db, dbOf } from "./auth/db.ts";
import { authMaintenance, type MaintenanceReport } from "./auth/services.ts";
import type { Config } from "./config.ts";
import { D1Metrics } from "./metrics-d1.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** A session row still open this long after approval (or claim) lost its end event; the object's own limit is 90 min. */
const STALE_SESSION_MS = 95 * MINUTE_MS;
const GUEST_ROW_DAYS = 30;
const USER_ROW_DAYS = 30;

export interface RetentionReport {
  auditRows: number;
  metricEvents: number;
  guestFileRows: number;
  guestPasses: number;
  userRows: number;
  auth: MaintenanceReport;
}

const changes = async (db: Db, sql: string, ...values: unknown[]): Promise<number> =>
  (
    await db
      .prepare(sql)
      .bind(...values)
      .run()
  ).meta.changes;

/** Hourly: ends session rows whose end event never arrived (a crashed Screen object). */
export const closeStaleSessions = (env: { DB: unknown }, now: number): Promise<number> =>
  changes(
    dbOf(env.DB),
    `UPDATE session SET ended_at = ?1, end_reason = 'auto'
     WHERE ended_at IS NULL AND COALESCE(approved_at, claimed_at) < ?2`,
    now,
    now - STALE_SESSION_MS,
  );

/** Daily: every period in section 10, then the auth maintenance (idle grants, expired phone sessions, KEK re-wrap). */
export async function runRetention(
  env: { DB: unknown },
  config: Config,
  now: number = Date.now(),
): Promise<RetentionReport> {
  const db = dbOf(env.DB);
  const auditRows = await new D1AuditLog(db).purge(now, {
    liveDays: config.auditRetentionDays,
    demoDays: config.demoRetentionDays,
  });
  const metricEvents = await new D1Metrics(db, null).purge(now, config.metricsRetentionDays);
  const guestFileRows = await changes(
    db,
    "DELETE FROM guest_file WHERE deleted_at IS NOT NULL AND deleted_at < ?",
    now - GUEST_ROW_DAYS * DAY_MS,
  );
  const guestPasses = await changes(db, "DELETE FROM guest_pass WHERE expires_at < ?", now);
  const auth = await authMaintenance(env, config, () => now);
  // After the auth jobs: a user row goes 30 days after its last grant or session is gone.
  const userRows = await changes(
    db,
    `DELETE FROM app_user WHERE last_seen_at < ?
       AND NOT EXISTS (SELECT 1 FROM token_grant g WHERE g.user_id = app_user.id)
       AND NOT EXISTS (SELECT 1 FROM phone_session p WHERE p.user_id = app_user.id)`,
    now - USER_ROW_DAYS * DAY_MS,
  );
  return { auditRows, metricEvents, guestFileRows, guestPasses, userRows, auth };
}
