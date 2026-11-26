// The signed-in member behind a library request: a live session of an active, unsuspended email member the launch lockout
// admits (label C, ADR 0014). Every refusal that is not "deleting" answers as a signed-out request, so a suspended or
// locked-out member learns nothing from it. The accounts change replaces this with its own resolver.
import { readCookie, SESSION_COOKIE } from "../auth/cookies.ts";
import { type Db, dbOf } from "../auth/db.ts";
import { Sessions } from "../auth/sessions.ts";
import type { Config } from "../config.ts";
import { fail } from "../http.ts";
import { sha256Hex } from "../ids.ts";
import { admitted, launchState } from "../mode.ts";

const DAY_MS = 86_400_000;

export interface Member {
  userId: string;
  /** The phone session's public id: the only session name that leaves D1. */
  sessionPublicId: string;
}

interface Row {
  user_id: string;
  public_id: string | null;
  email_norm: string | null;
  status: string;
  suspended_at: number | null;
  delete_after: number | null;
  last_seen_at: number;
}

export type Resolved = { ok: true; member: Member } | { ok: false; response: Response };

/** A `deleting` member gets the card's data, never the library (library.md section 5). */
const deleting = async (deleteAfter: number | null): Promise<Response> => {
  const base = fail("account_deleting");
  if (deleteAfter === null) return base;
  return new Response(JSON.stringify({ ...((await base.json()) as object), deleteAfter }), base);
};

export async function resolveMember(
  request: Request,
  env: { DB: unknown },
  config: Pick<Config, "account">,
  now: number,
): Promise<Resolved> {
  const cookie = readCookie(request, SESSION_COOKIE);
  const refused = { ok: false as const, response: fail("auth_required") };
  if (!cookie) return refused;
  const db: Db = dbOf(env.DB);
  if (!(await new Sessions(db, () => now).resolve(cookie))) return refused;
  const row = await db
    .prepare(
      `SELECT s.user_id, s.public_id, u.email_norm, u.status, u.suspended_at, u.delete_after, u.last_seen_at
       FROM phone_session s JOIN app_user u ON u.id = s.user_id WHERE s.id_hash = ?1`,
    )
    .bind(await sha256Hex(cookie))
    .first<Row>();
  if (!row || row.public_id === null || row.email_norm === null || row.suspended_at !== null) return refused;
  if (!admitted(await launchState(env), config.account, row.email_norm)) return refused;
  if (row.status === "deleting") return { ok: false, response: await deleting(row.delete_after) };
  if (row.status !== "active") return refused;
  // Use clears an inactivity warning, once a day, and never touches a requested deletion (ADR 0013).
  if (now - row.last_seen_at > DAY_MS) {
    await db
      .prepare(
        "UPDATE app_user SET last_seen_at = ?2, inactive_warned_at = NULL, delete_after = NULL WHERE id = ?1 AND status = 'active'",
      )
      .bind(row.user_id, now)
      .run();
  }
  return { ok: true, member: { userId: row.user_id, sessionPublicId: row.public_id } };
}
