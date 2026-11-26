// Who a request is, for every member route (the ADR 0014 labels): C, C(d), C+R, A and A+R. One JOIN read of session and
// user, then the gates; a refused session is treated exactly as signed out.
import type { Config } from "../config.ts";
import { fail } from "../http.ts";
import { admitted, launchState } from "../mode.ts";
import { readCookie, SESSION_COOKIE } from "./cookies.ts";
import type { Db } from "./db.ts";
import { passkeyCreatedAt } from "./passkeys.ts";
import { servicesFor } from "./services.ts";
import type { Sessions, SessionView } from "./sessions.ts";

/** A+R: the proving passkey must be this old, so one added from a hijacked session cannot unlock admin for a day. */
export const STEP_UP_PASSKEY_AGE_MS = 86_400_000;

export interface Member {
  userId: string;
  email: string | null;
  emailNorm: string;
  status: "active" | "deleting";
  deleteAfter: number | null;
  /** From ADMIN_EMAILS on every request; nothing stored grants it. */
  admin: boolean;
  session: { hash: string; publicId: string | null; reauthAt: number | null; method: string | null };
}

export type Resolved = { ok: true; member: Member } | { ok: false; response: Response };

export interface MemberOptions {
  /** C(d): a member in the deletion grace passes too (GET /api/me, restore). */
  allowDeleting?: boolean;
  /** Read the mode uncached, for a step that creates state. */
  fresh?: boolean;
  /** False for a read that must write nothing (the invite peek): the activity clock is left as it is. */
  touch?: boolean;
}

const signedOut = (): Resolved => ({ ok: false, response: fail("auth_required") });

/**
 * C over a session already looked up: an email member, active (or deleting when allowed), not suspended, and admitted
 * by the lockout. Touches the member's activity clock at most daily.
 */
export async function memberOf(
  view: SessionView,
  env: { DB: unknown },
  config: Config,
  sessions: Sessions,
  options: MemberOptions = {},
): Promise<Resolved> {
  const { emailNorm } = view;
  const statusOk = view.status === "active" || (options.allowDeleting === true && view.status === "deleting");
  if (view.tid !== "email" || emailNorm === null || !statusOk || view.suspendedAt !== null) return signedOut();
  if (!admitted(await launchState(env, { fresh: options.fresh === true }), config.account, emailNorm))
    return signedOut();
  if (options.touch !== false) await sessions.touchUser(view);
  return {
    ok: true,
    member: {
      userId: view.userId,
      email: view.email,
      emailNorm,
      status: view.status as Member["status"],
      deleteAfter: view.deleteAfter,
      admin: config.account.adminEmails.has(emailNorm),
      session: { hash: view.hash, publicId: view.publicId, reauthAt: view.reauthAt, method: view.method },
    },
  };
}

/** The member behind the session cookie, or the `auth_required` answer. */
export async function resolveMember(
  request: Request,
  env: { DB: unknown },
  config: Config,
  options: MemberOptions = {},
): Promise<Resolved> {
  const cookie = readCookie(request, SESSION_COOKIE);
  const { sessions } = servicesFor(env, config);
  const view = cookie ? await sessions.lookup(cookie) : null;
  return view ? memberOf(view, env, config, sessions, options) : signedOut();
}

/** C+R: the session's own proof is within REAUTH_SECONDS, else `reauth_required`. */
export function requireFresh(member: Member, config: Config, now: number = Date.now()): Response | null {
  const at = member.session.reauthAt;
  return at !== null && now - at <= config.account.reauthSeconds * 1000 ? null : fail("reauth_required");
}

/** A: anyone else gets `not_found`, so the admin surface looks like a missing path. */
export const requireAdmin = (member: Member): Response | null => (member.admin ? null : fail("not_found"));

/**
 * A+R in one call: admin, a fresh proof, and that proof a passkey assertion (`passkey:<credentialId>`, written only
 * after a UV-checked assertion) by a passkey of this member registered at least a day ago. An email code never
 * counts (NIST 800-63B-4 3.1.3.1). TRANSITIONAL(a-8): the admin A+R routes are the first callers.
 */
export async function requireStepUp(
  member: Member,
  db: Db,
  config: Config,
  now: number = Date.now(),
): Promise<Response | null> {
  const refused = requireAdmin(member) ?? requireFresh(member, config, now);
  if (refused) return refused;
  const method = member.session.method ?? "";
  const credentialId = method.startsWith("passkey:") ? method.slice("passkey:".length) : "";
  const createdAt = credentialId ? await passkeyCreatedAt(db, member.userId, credentialId) : null;
  return createdAt !== null && now - createdAt >= STEP_UP_PASSKEY_AGE_MS ? null : fail("reauth_required");
}
