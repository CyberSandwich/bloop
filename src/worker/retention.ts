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
/** Past the longest a session can last, the hourly job's own lag. */
const STALE_SLACK_MS = 5 * MINUTE_MS;
const GUEST_ROW_DAYS = 30;
const USER_ROW_DAYS = 30;
const R2_OPS_MONTHS = 13;

/** The 'YYYY-MM' that is `n` calendar months before `now` (UTC); r2_ops rows older than it are dropped. */
const monthsBefore = (now: number, n: number): string => {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1)).toISOString().slice(0, 7);
};

export interface RetentionReport {
  auditRows: number;
  metricEvents: number;
  guestFileRows: number;
  guestPasses: number;
  r2OpRows: number;
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

/**
 * Hourly: ends session rows whose end event never arrived (a crashed Screen object). A row is stale only once it is
 * older than the longest session (`longestSessionMs`), so a session the phone made longer is never marked ended.
 */
export const closeStaleSessions = (
  env: { DB: unknown },
  config: Pick<Config, "longestSessionMs">,
  now: number,
): Promise<number> =>
  changes(
    dbOf(env.DB),
    `UPDATE session SET ended_at = ?1, end_reason = 'auto'
     WHERE ended_at IS NULL AND COALESCE(approved_at, claimed_at) < ?2`,
    now,
    now - config.longestSessionMs - STALE_SLACK_MS,
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
  const r2OpRows = await changes(db, "DELETE FROM r2_ops WHERE month < ?", monthsBefore(now, R2_OPS_MONTHS));
  const auth = await authMaintenance(env, config, () => now);
  // After the auth jobs: an Entra user row goes 30 days after its last grant or session is gone. An email member never
  // does: they hold library rows and R2 objects, and leave only through the account purge (ADR 0013).
  const userRows = await changes(
    db,
    `DELETE FROM app_user WHERE last_seen_at < ? AND tid != 'email'
       AND NOT EXISTS (SELECT 1 FROM token_grant g WHERE g.user_id = app_user.id)
       AND NOT EXISTS (SELECT 1 FROM phone_session p WHERE p.user_id = app_user.id)`,
    now - USER_ROW_DAYS * DAY_MS,
  );
  return { auditRows, metricEvents, guestFileRows, guestPasses, r2OpRows, userRows, auth };
}
