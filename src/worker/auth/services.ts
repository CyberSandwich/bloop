// The auth objects a request needs, built from the environment, and the daily maintenance job.
import { accountEvent } from "../audit.ts";
import { D1AuditLog } from "../audit-d1.ts";
import type { Config } from "../config.ts";
import { readCookie, SESSION_COOKIE } from "./cookies.ts";
import { dbOf } from "./db.ts";
import { Sessions } from "./sessions.ts";
import { Vault } from "./vault.ts";

/** The only binding auth needs; keeps this module free of Cloudflare types so Node tests can import it. */
type DbEnv = { DB: unknown };

export interface AuthServices {
  sessions: Sessions;
  vault: Vault;
}

/** Without Graph there are no keys, so the vault can delete grants but never open one. */
export function servicesFor(env: DbEnv, config: Config, now: () => number = Date.now): AuthServices {
  const db = dbOf(env.DB);
  return {
    sessions: new Sessions(db, now),
    vault: new Vault(db, config.graph?.keks ?? { keys: {}, current: "" }, now),
  };
}

/** The signed-in user behind the phone's session cookie, or null. Never called for a demo screen. */
export async function phoneUser(request: Request, services: AuthServices): Promise<string | null> {
  const cookie = readCookie(request, SESSION_COOKIE);
  return cookie ? services.sessions.resolve(cookie) : null;
}

const REWRAP_BATCH = 200;

export interface MaintenanceReport {
  idleGrants: number;
  expiredSessions: number;
  /** Data keys still under an old KEK; 0 means the old KEK can be deleted (ADR 0004). */
  staleKeys: number;
}

/** Daily cron (module g calls this): idle-grant deletion, expired sessions, KEK re-wrap. */
export async function authMaintenance(
  env: DbEnv,
  config: Config,
  now: () => number = Date.now,
): Promise<MaintenanceReport> {
  const { sessions, vault } = servicesFor(env, config, now);
  const idle = await vault.deleteIdle(config.grantIdleDays);
  const audit = new D1AuditLog(dbOf(env.DB));
  for (const userId of idle) {
    // Best effort: the grant is already gone, and one failed row must not stop the rest of the job.
    await audit
      .record(accountEvent("grant.deleted", userId, now(), "system"))
      .catch(() => console.error("record_failed"));
  }
  const idleGrants = idle.length;
  const expiredSessions = await sessions.deleteExpired();
  const staleKeys = config.graph ? await vault.rewrapStale(REWRAP_BATCH) : 0;
  return { idleGrants, expiredSessions, staleKeys };
}
