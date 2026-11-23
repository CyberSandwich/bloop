// Phone sessions: an opaque random cookie value, stored only as its SHA-256 (AUTH-05). Valid for 30 days
// idle and 90 days absolute. Sign-in always issues a new value and deletes the one it replaces (rotation).
import { newRef, newSecret, sha256Hex } from "../ids.ts";
import type { Db } from "./db.ts";

const DAY_MS = 86_400_000;
export const IDLE_DAYS = 30;
export const ABSOLUTE_DAYS = 90;
export const SESSION_MAX_AGE_SECONDS = ABSOLUTE_DAYS * 86_400;
/** last_seen_at is rewritten at most this often. */
const TOUCH_MS = 3_600_000;

export interface Identity {
  tid: string;
  oid: string;
  email: string | null;
}

export class Sessions {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** The user for an (tid, oid) pair, created on first sight. Keyed by the pair, never by email. */
  async upsertUser(identity: Identity): Promise<string> {
    const now = this.now();
    await this.db
      .prepare(
        `INSERT INTO app_user (id, tid, oid, email, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (tid, oid) DO UPDATE SET email = excluded.email, last_seen_at = excluded.last_seen_at`,
      )
      .bind(newRef(), identity.tid, identity.oid, identity.email, now, now)
      .run();
    const row = await this.db
      .prepare("SELECT id FROM app_user WHERE tid = ? AND oid = ?")
      .bind(identity.tid, identity.oid)
      .first<{ id: string }>();
    if (!row) throw new Error("user row missing after upsert");
    return row.id;
  }

  /** Issues a session and deletes the one the browser presented, if any. Returns the cookie value. */
  async create(userId: string, replacing: string | null): Promise<string> {
    if (replacing) await this.destroy(replacing);
    const value = newSecret();
    const now = this.now();
    await this.db
      .prepare(
        "INSERT INTO phone_session (id_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(await sha256Hex(value), userId, now, now, now + ABSOLUTE_DAYS * DAY_MS)
      .run();
    return value;
  }

  /** The signed-in user, or null for an unknown, idle or expired session. */
  async resolve(value: string): Promise<string | null> {
    const hash = await sha256Hex(value);
    const row = await this.db
      .prepare("SELECT user_id, last_seen_at, expires_at FROM phone_session WHERE id_hash = ?")
      .bind(hash)
      .first<{ user_id: string; last_seen_at: number; expires_at: number }>();
    const now = this.now();
    if (!row || row.expires_at <= now || row.last_seen_at + IDLE_DAYS * DAY_MS <= now) return null;
    if (now - row.last_seen_at > TOUCH_MS) {
      await this.db.prepare("UPDATE phone_session SET last_seen_at = ? WHERE id_hash = ?").bind(now, hash).run();
    }
    return row.user_id;
  }

  async destroy(value: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM phone_session WHERE id_hash = ?")
      .bind(await sha256Hex(value))
      .run();
  }

  /** Disconnect: every session of the user goes with the grant. */
  async destroyAll(userId: string): Promise<void> {
    await this.db.prepare("DELETE FROM phone_session WHERE user_id = ?").bind(userId).run();
  }

  /** Erasure: the user row goes, and with it the grant, every phone session and any guest pass (ON DELETE CASCADE). */
  async deleteUser(userId: string): Promise<void> {
    await this.db.prepare("DELETE FROM app_user WHERE id = ?").bind(userId).run();
  }

  /** Daily cron. Returns how many rows were deleted. */
  async deleteExpired(): Promise<number> {
    const now = this.now();
    const res = await this.db
      .prepare("DELETE FROM phone_session WHERE expires_at <= ? OR last_seen_at <= ?")
      .bind(now, now - IDLE_DAYS * DAY_MS)
      .run();
    return res.meta.changes;
  }

  async email(userId: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT email FROM app_user WHERE id = ?")
      .bind(userId)
      .first<{ email: string | null }>();
    return row?.email ?? null;
  }
}
