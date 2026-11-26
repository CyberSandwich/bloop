// Invites (ADR 0014): a 256-bit token that lives only in the link's fragment, stored as its SHA-256. Opening the link
// (peek) reads; only a verified code spends the invite, in the one acceptance batch that creates the user.
import { newSecret, sha256Hex } from "../ids.ts";
import { type BatchDb, type Db, type Statement, USER_EXISTS } from "./db.ts";

/** The Terms the acceptance page names; written beside `terms_accepted_at`, so a later Terms change can ask again. */
export const TERMS_VERSION = "1";

export const newInviteToken = (): string => newSecret();
export const inviteHash = (token: string): Promise<string> => sha256Hex(token);

/** Revoked and unknown read the same; the page only needs to say used or expired. */
export type InviteState = "open" | "used" | "expired" | "invalid";

export interface InviteRow {
  id: string;
  email: string;
  emailNorm: string;
  expiresAt: number;
}

/**
 * Reads only (INV-03): opening a link, by a person or a mail scanner, changes nothing. The row comes back in every
 * state but unknown, so the caller can apply the mode gate to a dead invite too.
 */
export async function peekInvite(
  db: Db,
  hash: string,
  now: number,
): Promise<{ state: InviteState; row: InviteRow | null }> {
  const r = await db
    .prepare("SELECT id, email, email_norm, expires_at, accepted_at, revoked_at FROM invite WHERE token_hash = ?")
    .bind(hash)
    .first<{
      id: string;
      email: string;
      email_norm: string;
      expires_at: number;
      accepted_at: number | null;
      revoked_at: number | null;
    }>();
  if (!r) return { state: "invalid", row: null };
  const row = { id: r.id, email: r.email, emailNorm: r.email_norm, expiresAt: r.expires_at };
  const state =
    r.revoked_at !== null ? "invalid" : r.accepted_at !== null ? "used" : r.expires_at <= now ? "expired" : "open";
  return { state, row };
}

/** `y**@domain`: enough for the invitee to recognize the address, too little to learn it. */
export const maskEmail = (email: string): string => {
  const at = email.lastIndexOf("@");
  return `${email.slice(0, 1)}**${email.slice(at)}`;
};

/**
 * Create and reissue in one statement (ADR 0014): an address with an open row (expired or not) gets that row's id
 * back with a new hash, expiry and send count, so the old link dies at once (INV-05). A replay of the same hash
 * changes nothing and returns no row. tools/invite.mjs prints it, after SUPERSEDE_INVITE_CODES, with the values
 * inlined. Binds: id, token_hash,
 * email_norm, email, note, created_by, waitlist_id, created_at, expires_at, last_sent_at.
 */
export const UPSERT_INVITE = `INSERT INTO invite (id, token_hash, email_norm, email, note, created_by, waitlist_id, created_at, expires_at, last_sent_at, sends) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT (email_norm) WHERE accepted_at IS NULL AND revoked_at IS NULL DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at, last_sent_at = excluded.last_sent_at, sends = invite.sends + 1 WHERE invite.token_hash != excluded.token_hash RETURNING id`;

/**
 * Runs just before UPSERT_INVITE, in its batch: when the upsert is about to reissue an open row (another hash for the
 * same address), the codes already mailed for the old link die with it (INV-05). A replayed hash matches nothing.
 * Binds: now, now, email_norm, token_hash (the new one).
 */
export const SUPERSEDE_INVITE_CODES = `UPDATE email_code SET expires_at = ? WHERE used_at IS NULL AND expires_at > ? AND invite_id = (SELECT id FROM invite WHERE email_norm = ? AND accepted_at IS NULL AND revoked_at IS NULL AND token_hash != ?)`;

export interface InviteInput {
  id: string;
  tokenHash: string;
  emailNorm: string;
  email: string;
  note: string | null;
  createdBy: string | null;
  waitlistId: string | null;
  now: number;
  expiresAt: number;
}

/**
 * TRANSITIONAL(a-8): invite create and resend call it. The supersede and the upsert in one batch; the row's id, or null
 * for a replayed hash (or a hash another reissue replaced before the read, whose link is dead too).
 */
export async function upsertInvite(db: BatchDb, i: InviteInput): Promise<string | null> {
  const [, upserted] = await db.batch([
    db.prepare(SUPERSEDE_INVITE_CODES).bind(i.now, i.now, i.emailNorm, i.tokenHash),
    db
      .prepare(UPSERT_INVITE)
      .bind(i.id, i.tokenHash, i.emailNorm, i.email, i.note, i.createdBy, i.waitlistId, i.now, i.expiresAt, i.now),
  ]);
  if (upserted?.meta.changes !== 1) return null;
  const row = await db.prepare("SELECT id FROM invite WHERE token_hash = ?").bind(i.tokenHash).first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * The code spends the invite: the user, the acceptance and the session (Sessions.issue, guarded on the user row) in
 * one batch, each guarded so an invite that died since the code was sent creates nothing. False for that, and for an
 * address that already has an account (the unique email_norm index refuses the insert and the batch rolls back).
 */
export async function acceptBatch(
  db: BatchDb,
  a: { inviteId: string; userId: string; session: readonly Statement[]; now: number },
): Promise<boolean> {
  try {
    const [created] = await db.batch([
      db
        .prepare(
          `INSERT INTO app_user (id, tid, oid, email, email_norm, created_at, last_seen_at, terms_version,
             terms_accepted_at) SELECT ?, 'email', ?, email, email_norm, ?, ?, ?, ? FROM invite
           WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
        )
        .bind(a.userId, a.userId, a.now, a.now, TERMS_VERSION, a.now, a.inviteId, a.now),
      db
        .prepare(
          `UPDATE invite SET accepted_at = ?, user_id = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL
           AND ${USER_EXISTS}`,
        )
        .bind(a.now, a.userId, a.inviteId, a.userId),
      ...a.session,
    ]);
    return created?.meta.changes === 1;
  } catch (e) {
    if (String(e).includes("UNIQUE constraint failed: app_user.email_norm")) return false;
    throw e;
  }
}
