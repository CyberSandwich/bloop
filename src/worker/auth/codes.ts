// One-time email codes and the known-device value (ADR 0014). A code lives only in the mail: the row holds an HMAC
// bound to its id, purpose and both addresses, so neither a leaked row nor a moved MAC verifies anything.
import { base64url, hmacHex, newRef, randomBytes, randomInt, safeEqual } from "../ids.ts";
import type { BatchDb, Db } from "./db.ts";

export type CodePurpose = "signin" | "invite" | "reauth" | "email_change";

/** Guesses per code; the increment runs before the compare, so parallel guesses cannot pass it. */
export const MAX_ATTEMPTS = 5;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Codes per bucket per window (ADR 0014): with MAX_ATTEMPTS that caps a bucket at 50 guesses a day. */
const LIMITS: Record<CodePurpose, readonly { ms: number; max: number }[]> = {
  signin: [
    { ms: 15 * MINUTE_MS, max: 3 },
    { ms: DAY_MS, max: 10 },
  ],
  invite: [{ ms: DAY_MS, max: 5 }],
  reauth: [
    { ms: 15 * MINUTE_MS, max: 3 },
    { ms: DAY_MS, max: 10 },
  ],
  email_change: [
    { ms: 15 * MINUTE_MS, max: 3 },
    { ms: DAY_MS, max: 10 },
  ],
};

/** Six digits, each drawn without modulo bias; leading zeros are kept. */
export const drawEmailCode = (): string => Array.from({ length: 6 }, () => String(randomInt(10))).join("");

export interface MacInput {
  id: string;
  purpose: string;
  emailNorm: string;
  newEmailNorm: string | null;
  code: string;
}

/** Each field is length-prefixed, so no two field splits encode to the same input, whatever the fields contain. */
export const codeMac = (pepper: string, m: MacInput): Promise<string> =>
  hmacHex(
    pepper,
    [m.id, m.purpose, m.emailNorm, m.newEmailNorm ?? "", m.code].map((f) => `${f.length}:${f}`).join("|"),
  );

export interface IssueInput {
  purpose: CodePurpose;
  /** The row's address: the member's (or the asked-for one, for signin), the invite's, or the current one for email_change. */
  emailNorm: string;
  /** email_change only: the address the code is mailed to. */
  newEmailNorm?: string | null;
  /** Required for reauth and email_change. */
  userId?: string | null;
  /** Required for invite. */
  inviteId?: string | null;
  /** signin only: the request carried this member's known-device value. */
  known?: boolean;
}

export type Issued =
  | { limited: false; challengeId: string; code: string; expiresAt: number }
  | { limited: true; retryAfterSeconds: number };

/** The bucket a purpose limits and supersedes within, as a WHERE fragment and its parameters. */
function bucketOf(input: IssueInput): { where: string; params: unknown[] } {
  switch (input.purpose) {
    case "signin":
      return {
        where: "email_norm = ? AND purpose = ? AND known = ?",
        params: [input.emailNorm, "signin", input.known ? 1 : 0],
      };
    case "invite":
      if (!input.inviteId) throw new RangeError("invite codes need inviteId");
      return { where: "invite_id = ? AND purpose = ?", params: [input.inviteId, "invite"] };
    case "reauth":
    case "email_change":
      if (!input.userId) throw new RangeError(`${input.purpose} codes need userId`);
      return { where: "user_id = ? AND purpose = ?", params: [input.userId, input.purpose] };
  }
}

/**
 * Supersede and insert as one batch, both guarded by the bucket counts. D1 runs batches one at a time and the INSERT
 * carries its own count guard, so the check and the insert are atomic: a full bucket writes nothing and answers
 * `limited`, however many requests race.
 */
export async function issueCode(
  db: BatchDb,
  pepper: string,
  input: IssueInput,
  ttlSeconds: number,
  now: number = Date.now(),
): Promise<Issued> {
  return (await issue(db, pepper, input, ttlSeconds, now, null)) as Issued;
}

/**
 * An invite code, inserted only while the invite still holds `tokenHash`: a reissue between the accept's lookup and
 * this insert leaves no live code for the old link (the reissue's own supersede covers every later order). Null when
 * the invite no longer holds that hash.
 */
export async function issueInviteCode(
  db: BatchDb,
  pepper: string,
  input: { emailNorm: string; inviteId: string; tokenHash: string },
  ttlSeconds: number,
  now: number = Date.now(),
): Promise<Issued | null> {
  const guard = {
    sql: "EXISTS (SELECT 1 FROM invite WHERE id = ? AND token_hash = ?)",
    params: [input.inviteId, input.tokenHash],
  };
  return issue(
    db,
    pepper,
    { purpose: "invite", emailNorm: input.emailNorm, inviteId: input.inviteId },
    ttlSeconds,
    now,
    guard,
  );
}

async function issue(
  db: BatchDb,
  pepper: string,
  input: IssueInput,
  ttlSeconds: number,
  now: number,
  guard: { sql: string; params: unknown[] } | null,
): Promise<Issued | null> {
  const bucket = bucketOf(input);
  const windows = LIMITS[input.purpose];
  const below = windows
    .map((w) => `(SELECT count(*) FROM email_code WHERE ${bucket.where} AND created_at > ?) < ${w.max}`)
    .join(" AND ");
  const belowParams = windows.flatMap((w) => [...bucket.params, now - w.ms]);

  const id = newRef();
  const code = drawEmailCode();
  const newEmailNorm = input.newEmailNorm ?? null;
  const mac = await codeMac(pepper, { id, purpose: input.purpose, emailNorm: input.emailNorm, newEmailNorm, code });
  const expiresAt = now + ttlSeconds * 1000;
  const [, inserted] = await db.batch([
    db
      .prepare(
        `UPDATE email_code SET expires_at = ? WHERE ${bucket.where} AND used_at IS NULL AND expires_at > ? AND ${below}`,
      )
      .bind(now, ...bucket.params, now, ...belowParams),
    db
      .prepare(
        `INSERT INTO email_code (id, email_norm, purpose, known, user_id, invite_id, new_email_norm, code_mac, created_at,
           expires_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${below}${guard ? ` AND ${guard.sql}` : ""}`,
      )
      .bind(
        id,
        input.emailNorm,
        input.purpose,
        input.purpose === "signin" && input.known ? 1 : 0,
        input.userId ?? null,
        input.inviteId ?? null,
        newEmailNorm,
        mac,
        now,
        expiresAt,
        ...belowParams,
        ...(guard?.params ?? []),
      ),
  ]);
  if (inserted?.meta.changes === 1) return { limited: false, challengeId: id, code, expiresAt };
  if (
    guard &&
    !(
      await db
        .prepare(`SELECT ${guard.sql} AS held`)
        .bind(...guard.params)
        .first<{ held: number }>()
    )?.held
  )
    return null;
  return { limited: true, retryAfterSeconds: await retryAfter(db, bucket, windows, now) };
}

/**
 * When every window next has room: a full window frees up as its max-th newest row ages out. One read of the longest
 * window, which the limits keep to a few rows.
 */
async function retryAfter(
  db: Db,
  bucket: { where: string; params: unknown[] },
  windows: readonly { ms: number; max: number }[],
  now: number,
): Promise<number> {
  const longest = Math.max(...windows.map((w) => w.ms));
  const { results } = await db
    .prepare(`SELECT created_at FROM email_code WHERE ${bucket.where} AND created_at > ?`)
    .bind(...bucket.params, now - longest)
    .all<{ created_at: number }>();
  const newest = results.map((r) => r.created_at).sort((a, b) => b - a);
  let waitMs = 0;
  for (const w of windows) {
    const inWindow = newest.filter((at) => at > now - w.ms);
    const freedBy = inWindow[w.max - 1];
    if (freedBy !== undefined) waitMs = Math.max(waitMs, freedBy + w.ms - now);
  }
  return Math.max(1, Math.ceil(waitMs / 1000));
}

export interface CodeRow {
  id: string;
  purpose: CodePurpose;
  emailNorm: string;
  newEmailNorm: string | null;
  userId: string | null;
  inviteId: string | null;
  known: boolean;
}

/**
 * Spends one attempt (guarded, so the 6th guess never reaches the compare), then compares the MAC, then marks the code
 * used (guarded, so a code works once even when two right guesses race). Null for every failure, which the route answers
 * as `code_invalid` and nothing more. `userId` pins reauth and email_change codes to the session's user, and is
 * required for them: a call without it is a programming error and throws.
 */
export async function verifyCode(
  db: Db,
  pepper: string,
  input: { id: string; purpose: CodePurpose; code: string; userId?: string },
  now: number = Date.now(),
): Promise<CodeRow | null> {
  if ((input.purpose === "reauth" || input.purpose === "email_change") && input.userId === undefined) {
    throw new RangeError(`${input.purpose} verification needs userId`);
  }
  const pinned = input.userId === undefined ? "" : " AND user_id = ?";
  const row = await db
    .prepare(
      `UPDATE email_code SET attempts = attempts + 1
       WHERE id = ? AND purpose = ? AND used_at IS NULL AND expires_at > ? AND attempts < ${MAX_ATTEMPTS}${pinned}
       RETURNING email_norm, new_email_norm, user_id, invite_id, known, code_mac`,
    )
    .bind(input.id, input.purpose, now, ...(input.userId === undefined ? [] : [input.userId]))
    .first<{
      email_norm: string;
      new_email_norm: string | null;
      user_id: string | null;
      invite_id: string | null;
      known: number;
      code_mac: string;
    }>();
  if (!row) return null;
  const mac = await codeMac(pepper, {
    id: input.id,
    purpose: input.purpose,
    emailNorm: row.email_norm,
    newEmailNorm: row.new_email_norm,
    code: input.code,
  });
  if (!safeEqual(mac, row.code_mac)) return null;
  const used = await db
    .prepare("UPDATE email_code SET used_at = ? WHERE id = ? AND used_at IS NULL")
    .bind(now, input.id)
    .run();
  if (used.meta.changes !== 1) return null;
  return {
    id: input.id,
    purpose: input.purpose,
    emailNorm: row.email_norm,
    newEmailNorm: row.new_email_norm,
    userId: row.user_id,
    inviteId: row.invite_id,
    known: row.known === 1,
  };
}

/**
 * The member's device epoch (`app_user.device_epoch`) is in the MAC, so a bump refuses every device value issued
 * before it, on every device, not only on the one that cleared its cookie.
 */
const deviceMac = (pepper: string, userId: string, epoch: number, nonce: string): Promise<string> =>
  hmacHex(pepper, `dev|${userId}|${epoch}|${nonce}`);

/**
 * The bump, in one batch with the change that calls for it: sign out everywhere (sessions.ts `destroyAll`), ending one
 * session, a passkey removal and a deletion request. TRANSITIONAL(a-5): passkey registration batches it too.
 * TRANSITIONAL(a-7): so does an email change.
 */
export const BUMP_DEVICE_EPOCH = "UPDATE app_user SET device_epoch = device_epoch + 1 WHERE id = ?";

/** The bump only while `exists` (a SELECT) finds the row the change removes, so a refused id forgets no devices. */
export const bumpDeviceEpochIf = (exists: string): string => `${BUMP_DEVICE_EPOCH} AND EXISTS (${exists})`;

/**
 * The `__Host-bloop_dev` value: a fresh 128-bit nonce per device and its MAC for this member and epoch, so no table
 * is needed.
 */
export async function newDeviceValue(pepper: string, userId: string, epoch: number): Promise<string> {
  const nonce = base64url(randomBytes(16));
  return `${nonce}.${await deviceMac(pepper, userId, epoch, nonce)}`;
}

const DEVICE = /^([A-Za-z0-9_-]{22})\.([0-9a-f]{64})$/;
/** Not a `newRef` shape, so no user id equals it. */
const NO_USER = "-";

/**
 * Whether a known-device value was issued to this member at this epoch; false for a missing, malformed or forged one,
 * or one issued before the epoch moved. A well-formed value is MACed for a stranger too (against an id no user has),
 * so the code request takes the same work whether the address names a member (AUTH-10).
 */
export async function isKnown(
  value: string | null,
  pepper: string,
  userId: string | null,
  epoch: number,
): Promise<boolean> {
  const m = value ? DEVICE.exec(value) : null;
  if (!m) return false;
  const mac = await deviceMac(pepper, userId ?? NO_USER, epoch, m[1] as string);
  return userId !== null && safeEqual(mac, m[2] as string);
}
