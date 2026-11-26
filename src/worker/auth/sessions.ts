// Phone sessions: an opaque random cookie value, stored only as its SHA-256 (AUTH-05). Valid for 30 days
// idle and 90 days absolute. Every authentication issues a new value and deletes the one it replaces (AUTH-08).
import { newRef, newSecret, sha256Hex } from "../ids.ts";
import { BUMP_DEVICE_EPOCH, bumpDeviceEpochIf } from "./codes.ts";
import { type BatchDb, type Statement, USER_EXISTS } from "./db.ts";

const DAY_MS = 86_400_000;
export const IDLE_DAYS = 30;
export const ABSOLUTE_DAYS = 90;
export const SESSION_MAX_AGE_SECONDS = ABSOLUTE_DAYS * 86_400;
/** phone_session.last_seen_at is rewritten at most this often. */
const TOUCH_MS = 3_600_000;
/** app_user.last_seen_at, a member's inactivity clock (ADR 0013), at most this often. */
const USER_TOUCH_MS = DAY_MS;
/** The epoch bump while the user still has the session the change removes. Binds: user, user, public id. */
const BUMP_IF_SESSION = bumpDeviceEpochIf("SELECT 1 FROM phone_session WHERE user_id = ? AND public_id = ?");

/** phone_session.public_id as `create` writes it (newRef, 128 bits): what L's resolveMember and socket tags take. */
export const PUBLIC_ID = /^[A-Za-z0-9_-]{22}$/;

export interface Identity {
  tid: string;
  oid: string;
  email: string | null;
}

/**
 * How the session's latest proof was made: `code`, `entra`, or `passkey:<credentialId>`. The passkey form is written
 * only after an assertion whose UV flag the server checked, so it is what the admin step-up reads (member.ts).
 */
export type SessionMethod = "code" | "entra" | `passkey:${string}`;

export interface SessionOptions {
  method: SessionMethod;
  /** `deviceLabel` of the request; never the raw User-Agent. */
  label: string | null;
  /** A reauth carries the replaced session's id over (ADR 0014 amendment); a sign-in leaves it out and gets a new one. */
  publicId?: string;
  reauthAt: number | null;
}

/** A live session joined with its user: the one read every signed-in request makes. */
export interface SessionView {
  hash: string;
  publicId: string | null;
  method: string | null;
  reauthAt: number | null;
  userId: string;
  tid: string;
  email: string | null;
  emailNorm: string | null;
  status: string;
  suspendedAt: number | null;
  deleteAfter: number | null;
  userSeenAt: number;
}

export interface SessionEntry {
  id: string;
  label: string | null;
  method: "code" | "entra" | "passkey" | null;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
}

interface ViewRow {
  public_id: string | null;
  method: string | null;
  reauth_at: number | null;
  last_seen_at: number;
  expires_at: number;
  user_id: string;
  tid: string;
  email: string | null;
  email_norm: string | null;
  status: string;
  suspended_at: number | null;
  delete_after: number | null;
  user_seen: number;
}

export class Sessions {
  constructor(
    private readonly db: BatchDb,
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

  /**
   * The statements that delete the session the browser presented and issue the new one, for a batch, with the new
   * cookie value. The delete comes first, so a carried `publicId` passes the unique index. Both run only while the user
   * row exists, so a batch that may not create the user (an invite's acceptance) creates no session either.
   */
  async issue(
    userId: string,
    replacing: string | null,
    options: SessionOptions,
  ): Promise<{ value: string; statements: Statement[] }> {
    const value = newSecret();
    const now = this.now();
    const insert = this.db
      .prepare(
        `INSERT INTO phone_session (id_hash, user_id, created_at, last_seen_at, expires_at, public_id, method, label,
           reauth_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${USER_EXISTS}`,
      )
      .bind(
        await sha256Hex(value),
        userId,
        now,
        now,
        now + ABSOLUTE_DAYS * DAY_MS,
        options.publicId ?? newRef(),
        options.method,
        options.label,
        options.reauthAt,
        userId,
      );
    const drop = replacing
      ? [
          this.db
            .prepare(`DELETE FROM phone_session WHERE id_hash = ? AND ${USER_EXISTS}`)
            .bind(await sha256Hex(replacing), userId),
        ]
      : [];
    return { value, statements: [...drop, insert] };
  }

  /** `issue` as its own batch, so the presented value never outlives the new one. Returns the cookie value. */
  async create(userId: string, replacing: string | null, options: SessionOptions): Promise<string> {
    const { value, statements } = await this.issue(userId, replacing, options);
    const results = await this.db.batch(statements);
    if (results.at(-1)?.meta.changes !== 1) throw new Error("user row missing for the session");
    return value;
  }

  /** The live session and its user, or null for an unknown, idle or expired value. Touches the session hourly. */
  async lookup(value: string): Promise<SessionView | null> {
    const hash = await sha256Hex(value);
    const row = await this.db
      .prepare(
        `SELECT s.public_id, s.method, s.reauth_at, s.last_seen_at, s.expires_at, s.user_id, u.tid, u.email,
           u.email_norm, u.status, u.suspended_at, u.delete_after, u.last_seen_at AS user_seen
         FROM phone_session s JOIN app_user u ON u.id = s.user_id WHERE s.id_hash = ?`,
      )
      .bind(hash)
      .first<ViewRow>();
    const now = this.now();
    if (!row || row.expires_at <= now || row.last_seen_at + IDLE_DAYS * DAY_MS <= now) return null;
    if (now - row.last_seen_at > TOUCH_MS) {
      await this.db.prepare("UPDATE phone_session SET last_seen_at = ? WHERE id_hash = ?").bind(now, hash).run();
    }
    return {
      hash,
      publicId: row.public_id,
      method: row.method,
      reauthAt: row.reauth_at,
      userId: row.user_id,
      tid: row.tid,
      email: row.email,
      emailNorm: row.email_norm,
      status: row.status,
      suspendedAt: row.suspended_at,
      deleteAfter: row.delete_after,
      userSeenAt: row.user_seen,
    };
  }

  /** The signed-in user, or null for an unknown, idle or expired session. */
  async resolve(value: string): Promise<string | null> {
    return (await this.lookup(value))?.userId ?? null;
  }

  /** Moves a member's inactivity clock, at most daily (ADR 0013). */
  async touchUser(view: SessionView): Promise<void> {
    const now = this.now();
    if (now - view.userSeenAt <= USER_TOUCH_MS) return;
    await this.db.prepare("UPDATE app_user SET last_seen_at = ? WHERE id = ?").bind(now, view.userId).run();
  }

  /** The user's live sessions, most recently used first; `current` marks the one whose hash is given. */
  async list(userId: string, currentHash: string): Promise<SessionEntry[]> {
    const now = this.now();
    const { results } = await this.db
      .prepare(
        `SELECT id_hash, public_id, label, method, created_at, last_seen_at FROM phone_session
         WHERE user_id = ? AND public_id IS NOT NULL AND expires_at > ? AND last_seen_at > ? ORDER BY last_seen_at DESC`,
      )
      .bind(userId, now, now - IDLE_DAYS * DAY_MS)
      .all<{
        id_hash: string;
        public_id: string;
        label: string | null;
        method: string | null;
        created_at: number;
        last_seen_at: number;
      }>();
    return results.map((r) => ({
      id: r.public_id,
      label: r.label,
      // The credential id stays server-side: the list says only which kind of proof made the session.
      method: r.method?.startsWith("passkey:") ? "passkey" : (r.method as SessionEntry["method"]),
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      current: r.id_hash === currentHash,
    }));
  }

  async destroy(value: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM phone_session WHERE id_hash = ?")
      .bind(await sha256Hex(value))
      .run();
  }

  /**
   * Ends one of the user's sessions by its public id, and with it every known-device value (a revoked device loses
   * `known`); one batch, the bump guarded by the session's existence. False when the user has no such session.
   */
  async destroyPublic(userId: string, publicId: string): Promise<boolean> {
    const [, removed] = await this.db.batch([
      this.db.prepare(BUMP_IF_SESSION).bind(userId, userId, publicId),
      this.db.prepare("DELETE FROM phone_session WHERE user_id = ? AND public_id = ?").bind(userId, publicId),
    ]);
    return (removed?.meta.changes ?? 0) > 0;
  }

  /** Ends every session of the user but `keepHash`. Returns the public ids that ended. TRANSITIONAL(a-7): email change. */
  destroyOthers(userId: string, keepHash: string): Promise<string[]> {
    return this.publicIds("DELETE FROM phone_session WHERE user_id = ? AND id_hash != ? RETURNING public_id", [
      userId,
      keepHash,
    ]);
  }

  /**
   * Every session of the user (sign out everywhere, Entra disconnect) and every known-device value with them: the
   * epoch bump and the delete are one batch. The delete names the user, not the ids, so a session signed in between
   * still ends; the ids, read just before it, only drive the live-screen close notices (see `requestDeletion`).
   */
  async destroyAll(userId: string): Promise<string[]> {
    const ended = await this.publicIds("SELECT public_id FROM phone_session WHERE user_id = ?", [userId]);
    await this.db.batch([
      this.db.prepare(BUMP_DEVICE_EPOCH).bind(userId),
      this.db.prepare("DELETE FROM phone_session WHERE user_id = ?").bind(userId),
    ]);
    return ended;
  }

  /** The public ids a SELECT or a DELETE ... RETURNING names. */
  private async publicIds(sql: string, params: unknown[]): Promise<string[]> {
    const { results } = await this.db
      .prepare(sql)
      .bind(...params)
      .all<{ public_id: string | null }>();
    return results.flatMap((r) => (r.public_id ? [r.public_id] : []));
  }

  /**
   * Records a fresh proof on this session without rotating it (passkey registration, which is already C+R).
   * TRANSITIONAL(a-5): passkey registration calls it, and must record the method with the proof.
   */
  async stampReauth(hash: string): Promise<void> {
    await this.db.prepare("UPDATE phone_session SET reauth_at = ? WHERE id_hash = ?").bind(this.now(), hash).run();
  }

  /**
   * Erasure of an Entra user: the row goes, and with it the grant, every phone session and any guest pass (ON DELETE
   * CASCADE). An email user is never deleted here, since the cascade would drop their library rows and orphan their R2
   * objects: only the account purge removes one (ADR 0013), so the statement itself refuses the row.
   */
  async deleteUser(userId: string): Promise<void> {
    await this.db.prepare("DELETE FROM app_user WHERE id = ? AND tid != 'email'").bind(userId).run();
  }

  /**
   * Starts the deletion grace for an email member: the daily purge deletes them after `deleteAfter`, and every other
   * session ends now; the session `keepHash` asked for the deletion and stays to restore it (ADR 0014). Zero changes on
   * the row means the account was not active (already deleting or purging), which is fine to repeat. The status, the
   * device epoch and the session ends are one batch. `BatchDb` declares no rows for a batch (D1 returns them; the test
   * shim does not), so the ended ids are read just before it: a session signed in between the two is ended without its
   * id, and its library sockets close at their next cookie check.
   */
  async requestDeletion(userId: string, deleteAfter: number, keepHash: string): Promise<string[]> {
    const ended = await this.publicIds("SELECT public_id FROM phone_session WHERE user_id = ? AND id_hash != ?", [
      userId,
      keepHash,
    ]);
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE app_user SET status = 'deleting', delete_after = ? WHERE id = ? AND tid = 'email' AND status = 'active'",
        )
        .bind(deleteAfter, userId),
      this.db.prepare(BUMP_DEVICE_EPOCH).bind(userId),
      this.db.prepare("DELETE FROM phone_session WHERE user_id = ? AND id_hash != ?").bind(userId, keepHash),
    ]);
    return ended;
  }

  /** Cancels a requested deletion inside its grace (ADR 0013); false when it is too late or there was none. */
  async restore(userId: string): Promise<boolean> {
    const res = await this.db
      .prepare(
        "UPDATE app_user SET status = 'active', delete_after = NULL WHERE id = ? AND status = 'deleting' AND delete_after > ?",
      )
      .bind(userId, this.now())
      .run();
    return res.meta.changes === 1;
  }

  /** What GET /api/me shows beside the session: library use, the quota override, and the passkey count. */
  async summary(userId: string): Promise<{ usedBytes: number; quotaBytes: number | null; passkeys: number }> {
    const row = await this.db
      .prepare(
        `SELECT u.used_bytes, u.quota_bytes, (SELECT count(*) FROM passkey p WHERE p.user_id = u.id) AS passkeys
         FROM app_user u WHERE u.id = ?`,
      )
      .bind(userId)
      .first<{ used_bytes: number; quota_bytes: number | null; passkeys: number }>();
    return { usedBytes: row?.used_bytes ?? 0, quotaBytes: row?.quota_bytes ?? null, passkeys: row?.passkeys ?? 0 };
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
}

const BROWSERS: readonly [RegExp, string][] = [
  [/\bEdg(A|iOS)?\//, "Edge"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bOPR\//, "Opera"],
  [/\bChrome\/|\bCriOS\//, "Chrome"],
  [/\bSafari\//, "Safari"],
];
// iPhone and iPad UAs also say "Mac OS X", and Android's says "Linux": the specific entry comes first.
const DEVICES: readonly [RegExp, string][] = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMacintosh\b/, "Mac"],
  [/\bWindows\b/, "Windows"],
  [/\bLinux\b/, "Linux"],
];

/** A coarse "Browser on Device" for the devices list; the raw User-Agent is never stored. */
export function deviceLabel(userAgent: string | null): string {
  const ua = (userAgent ?? "").slice(0, 512);
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? "Browser";
  const device = DEVICES.find(([re]) => re.test(ua))?.[1];
  return device ? `${browser} on ${device}` : browser;
}
