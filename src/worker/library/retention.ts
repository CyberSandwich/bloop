// The library's clocks, run from the cron (docs/library.md section 7): due trash, account deletion, the second prefix
// delete, the inactivity warning, orphaned prefixes and released holds. Each job has its own allotment of R2 rounds
// and rows, so one backlog never starves the rest; a job that finds more says so and the next tick continues.
import { dbOf, type Statement } from "../auth/db.ts";
import { type AccountPurgeDeps, dueUsers, purgeUser, resweepTombstones, sweepOrphans } from "./account-purge.ts";
import { releaseHolds, settleHolds } from "./hold.ts";
import { purgeDueFiles } from "./purge.ts";
import type { LibDb } from "./store.ts";

const DAY_MS = 86_400_000;
const ROUNDS_PER_JOB = 20;
const USERS_PER_RUN = 5;
const WARNINGS_PER_RUN = 50;
const EMAILS_PER_QUERY = 90;

export interface RetentionDeps extends AccountPurgeDeps {
  /**
   * A's inactivity email. True only when it was sent: nobody is deleted for inactivity without a sent warning, so a
   * failed send changes nothing and the next run tries again.
   */
  warn(user: { id: string; emailNorm: string }): Promise<boolean>;
  /** While the preview lockout is set, the only members who could have signed in; null when there is no lockout. */
  lockoutMembers: readonly string[] | null;
}

export interface RetentionReport {
  trashPurged: number;
  accountsPurged: number;
  accountsPending: number;
  resweeps: number;
  warned: number;
  orphans: number;
  holdsReleased: number;
  holdsSettled: number;
  more: boolean;
}

/** `daily` adds the scans that need no more than a day's cadence: the warning and the orphan prefixes. */
export async function runLibraryRetention(
  env: { DB: unknown; LIBRARY: unknown; GUEST_FILES: unknown },
  config: { inactiveDays: number; inactiveGraceDays: number },
  deps: RetentionDeps,
  options: { daily: boolean },
): Promise<RetentionReport> {
  const now = deps.now();
  const budget = () => ({ rounds: ROUNDS_PER_JOB });
  // Pending holds settle first: a file's purge and an owner's deletion wait on them.
  const settledHolds = await settleHolds(env, now);
  const files = await purgeDueFiles(env, { budget: budget() }, deps);

  let accountsPurged = 0;
  let accountsPending = 0;
  const users = await dueUsers(env, now, USERS_PER_RUN);
  for (const id of users) {
    const outcome = await purgeUser(env, id, budget(), deps);
    if (outcome === "purged") accountsPurged++;
    if (outcome === "more") accountsPending++;
  }

  const swept = await resweepTombstones(env, budget(), now);
  const holds = await releaseHolds(env, now);
  let warned = 0;
  let orphans = 0;
  let orphansMore = false;
  if (options.daily) {
    warned = await warnInactive(env, config, deps, now);
    const found = await sweepOrphans(env, budget(), now);
    orphans = found.orphans;
    orphansMore = found.more;
  }
  return {
    trashPurged: files.purged,
    accountsPurged,
    accountsPending,
    resweeps: swept.swept,
    warned,
    orphans,
    holdsReleased: holds.released,
    holdsSettled: settledHolds.settled,
    more:
      settledHolds.more ||
      files.more ||
      users.length === USERS_PER_RUN ||
      accountsPending > 0 ||
      swept.more ||
      holds.more ||
      orphansMore,
  };
}

/**
 * Unsuspending gives back the time spent suspended: every clock of the user moves later by it (moderation: suspension
 * pauses trash, inactivity and requested deletion). The statements join the caller's unsuspend batch, which clears
 * `suspended_at`; `last_seen_at` never passes `now`. A file already due when the suspension began (Delete Now) keeps its
 * time: shifting it would reopen its restore.
 */
export function resumeClocks(db: LibDb, userId: string, now: number): Statement[] {
  // The pause is read from the row itself and only while it is still suspended, so a retried or concurrent unsuspend
  // shifts the clocks once. These statements must run before the one that clears `suspended_at`.
  const paused = "MAX(?2 - suspended_at, 0)";
  return [
    db
      .prepare(
        `UPDATE library_file SET purge_after = purge_after + (SELECT ${paused} FROM app_user WHERE id = ?1)
         WHERE user_id = ?1 AND purge_after IS NOT NULL AND status != 'purged'
           AND purge_after > (SELECT suspended_at FROM app_user WHERE id = ?1)`,
      )
      .bind(userId, now),
    db
      .prepare(
        `UPDATE app_user SET delete_after = CASE WHEN delete_after IS NULL THEN NULL ELSE delete_after + ${paused} END,
           inactive_warned_at = CASE WHEN inactive_warned_at IS NULL THEN NULL ELSE inactive_warned_at + ${paused} END,
           last_seen_at = MIN(last_seen_at + ${paused}, ?2)
         WHERE id = ?1 AND suspended_at IS NOT NULL`,
      )
      .bind(userId, now),
  ];
}

/**
 * Email members unused for `inactiveDays` get the warning, and only after it was sent does one guarded update set the
 * mark and the deletion time, so a sign-in in between wins. In the preview lockout only the members who could have
 * signed in are considered, chosen in the query so the rest can never fill the page.
 */
export async function warnInactive(
  env: { DB: unknown },
  config: { inactiveDays: number; inactiveGraceDays: number },
  deps: Pick<RetentionDeps, "warn" | "lockoutMembers">,
  now: number,
): Promise<number> {
  const db = dbOf(env.DB);
  const cutoff = now - config.inactiveDays * DAY_MS;
  const only = deps.lockoutMembers;
  if (only !== null && only.length === 0) return 0;
  // D1 allows 100 bound values a statement, so a long address list is asked in groups.
  const groups: (readonly string[] | null)[] = [];
  if (only === null) groups.push(null);
  else for (let i = 0; i < only.length; i += EMAILS_PER_QUERY) groups.push(only.slice(i, i + EMAILS_PER_QUERY));
  const results: { id: string; email_norm: string }[] = [];
  for (const group of groups) {
    const { results: found } = await db
      .prepare(
        `SELECT id, email_norm FROM app_user
         WHERE email_norm IS NOT NULL AND tid = 'email' AND status = 'active' AND suspended_at IS NULL
           AND inactive_warned_at IS NULL AND last_seen_at < ?1
           ${group === null ? "" : `AND email_norm IN (${group.map((_, i) => `?${i + 3}`).join(", ")})`}
         ORDER BY last_seen_at LIMIT ?2`,
      )
      .bind(cutoff, WARNINGS_PER_RUN - results.length, ...(group ?? []))
      .all<{ id: string; email_norm: string }>();
    results.push(...found);
    if (results.length >= WARNINGS_PER_RUN) break;
  }
  let warned = 0;
  for (const user of results) {
    if (!(await deps.warn({ id: user.id, emailNorm: user.email_norm }))) continue;
    const marked = await db
      .prepare(
        `UPDATE app_user SET inactive_warned_at = ?2, delete_after = ?3
         WHERE id = ?1 AND status = 'active' AND inactive_warned_at IS NULL AND last_seen_at < ?4`,
      )
      .bind(user.id, now, now + config.inactiveGraceDays * DAY_MS, cutoff)
      .run();
    warned += marked.meta.changes;
  }
  return warned;
}
