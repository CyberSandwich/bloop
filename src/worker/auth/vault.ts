// Token vault (ADR 0004). Per-user AES-256-GCM data key (DEK), wrapped by a key-encryption key (KEK) chosen
// by `kid`. The refresh token and the cached access token are sealed under the DEK with AAD
// `user_id|version|field`, so a row moved to another user or version fails to open.
import type { SourceError } from "../../shared/protocol.ts";
import { randomBytes } from "../ids.ts";
import { blob, bytes, type Db } from "./db.ts";

const DAY_MS = 86_400_000;
/** An access token this close to expiry is refreshed instead of handed out. */
const SKEW_MS = 60_000;
/** A cache hit refreshes the grant's last-used time at most this often, to bound writes. */
const TOUCH_MS = DAY_MS;
/** Sign-in and refresh retry a lost compare-and-swap this many times. */
const CAS_ATTEMPTS = 3;

export interface Keks {
  /** kid to base64 of a 32-byte key. */
  keys: Readonly<Record<string, string>>;
  current: string;
}

export interface GrantInput {
  /** Null in session mode: no refresh token is held. */
  refreshToken: string | null;
  accessToken: string;
  accessExpiresAt: number;
  scope: string;
  folderId?: string | null;
}

export type RefreshResult =
  | { ok: true; accessToken: string; refreshToken: string | null; expiresAt: number; scope?: string }
  /** `revoked`: the token is dead for good (invalid_grant), so the grant is deleted. */
  | { ok: false; error: SourceError; revoked: boolean };
export type Refresh = (refreshToken: string) => Promise<RefreshResult>;

export type TokenResult = { ok: true; token: string } | { ok: false; error: SourceError };

interface GrantRow {
  user_id: string;
  kid: string;
  dek_wrapped: unknown;
  rt_ct: unknown;
  rt_iv: unknown;
  at_ct: unknown;
  at_iv: unknown;
  at_exp: number | null;
  scope: string;
  folder_id: string | null;
  version: number;
  updated_at: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

const aad = (userId: string, version: number, field: "rt" | "at"): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(encoder.encode(`${userId}|${version}|${field}`));

async function seal(dek: CryptoKey, additional: Uint8Array<ArrayBuffer>, plain: string) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additional },
    dek,
    encoder.encode(plain),
  );
  return { ct: new Uint8Array(ct), iv };
}

async function open(dek: CryptoKey, additional: Uint8Array<ArrayBuffer>, ct: unknown, iv: unknown): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes(iv), additionalData: additional },
    dek,
    bytes(ct),
  );
  return decoder.decode(plain);
}

export class Vault {
  private readonly kekCache = new Map<string, Promise<CryptoKey>>();

  constructor(
    private readonly db: Db,
    private readonly keks: Keks,
    private readonly now: () => number = Date.now,
  ) {}

  /** Creates or replaces the user's grant with a fresh data key (sign-in is authoritative). */
  async store(userId: string, input: GrantInput): Promise<void> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const existing = await this.db
        .prepare("SELECT version FROM token_grant WHERE user_id = ?")
        .bind(userId)
        .first<{ version: number }>();
      const version = (existing?.version ?? 0) + 1;
      const dek = (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
        "encrypt",
        "decrypt",
      ])) as CryptoKey;
      const wrapped = await this.wrap(dek, this.keks.current);
      const fields = await this.sealFields(dek, userId, version, input.refreshToken, input.accessToken);
      const args = [
        this.keks.current,
        blob(wrapped),
        fields.rtCt,
        fields.rtIv,
        fields.atCt,
        fields.atIv,
        input.accessExpiresAt,
        input.scope,
        input.folderId ?? null,
        version,
        this.now(),
      ];
      const changes = existing
        ? await this.run(
            `UPDATE token_grant SET kid = ?, dek_wrapped = ?, rt_ct = ?, rt_iv = ?, at_ct = ?, at_iv = ?, at_exp = ?,
               scope = ?, folder_id = ?, version = ?, updated_at = ? WHERE user_id = ? AND version = ?`,
            [...args, userId, existing.version],
          )
        : await this.run(
            `INSERT OR IGNORE INTO token_grant (kid, dek_wrapped, rt_ct, rt_iv, at_ct, at_iv, at_exp, scope, folder_id,
               version, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [...args, userId],
          );
      if (changes === 1) return;
    }
    throw new Error("token grant write lost the race repeatedly");
  }

  /**
   * A fresh access token. Serves the cached one while it is valid; otherwise refreshes with
   * compare-and-swap on `version` (AUTH-02): the loser of a race re-reads and uses the winner's token.
   */
  async accessToken(userId: string, refresh: Refresh): Promise<TokenResult> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const row = await this.read(userId);
      if (!row) return { ok: false, error: "auth_required" };
      const dek = await this.unwrap(row);
      await this.rewrap(row, dek);

      const cached = await this.cachedToken(row, dek);
      if (cached) return { ok: true, token: cached };
      if (row.rt_ct === null) return { ok: false, error: "auth_required" };

      const refreshToken = await open(dek, aad(userId, row.version, "rt"), row.rt_ct, row.rt_iv);
      const result = await refresh(refreshToken);
      if (!result.ok) {
        if (!result.revoked) return { ok: false, error: result.error };
        await this.delete(userId);
        return { ok: false, error: "auth_required" };
      }
      const version = row.version + 1;
      const fields = await this.sealFields(
        dek,
        userId,
        version,
        result.refreshToken ?? refreshToken,
        result.accessToken,
      );
      const changes = await this.run(
        `UPDATE token_grant SET rt_ct = ?, rt_iv = ?, at_ct = ?, at_iv = ?, at_exp = ?, scope = ?, version = ?,
           updated_at = ? WHERE user_id = ? AND version = ?`,
        [
          fields.rtCt,
          fields.rtIv,
          fields.atCt,
          fields.atIv,
          result.expiresAt,
          result.scope ?? row.scope,
          version,
          this.now(),
          userId,
          row.version,
        ],
      );
      if (changes === 1) return { ok: true, token: result.accessToken };
      // Lost the swap: the next pass reads the winner's row and serves its cached token.
    }
    return { ok: false, error: "source_unavailable" };
  }

  async folderId(userId: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT folder_id FROM token_grant WHERE user_id = ?")
      .bind(userId)
      .first<{ folder_id: string | null }>();
    return row?.folder_id ?? null;
  }

  async has(userId: string): Promise<boolean> {
    return (await this.db.prepare("SELECT 1 AS x FROM token_grant WHERE user_id = ?").bind(userId).first()) !== null;
  }

  /** Disconnect and erasure: the grant goes at once. */
  async delete(userId: string): Promise<void> {
    await this.db.prepare("DELETE FROM token_grant WHERE user_id = ?").bind(userId).run();
  }

  /** Deletes grants unused for `idleDays`; returns the users they belonged to. */
  async deleteIdle(idleDays: number): Promise<string[]> {
    const cutoff = this.now() - idleDays * DAY_MS;
    const { results } = await this.db
      .prepare("SELECT user_id FROM token_grant WHERE updated_at < ?")
      .bind(cutoff)
      .all<{ user_id: string }>();
    await this.run("DELETE FROM token_grant WHERE updated_at < ?", [cutoff]);
    return results.map((row) => row.user_id);
  }

  /** Daily cron: re-wraps up to `limit` data keys still under an old KEK. Returns how many remain stale. */
  async rewrapStale(limit: number): Promise<number> {
    const { results } = await this.db
      .prepare("SELECT * FROM token_grant WHERE kid != ? LIMIT ?")
      .bind(this.keks.current, limit)
      .all<GrantRow>();
    for (const row of results) await this.rewrap(row, await this.unwrap(row));
    return this.staleCount();
  }

  /** Rotation step 3 (ADR 0004): when this is 0 the old key can be deleted. */
  async staleCount(): Promise<number> {
    const row = await this.db
      .prepare("SELECT count(*) AS n FROM token_grant WHERE kid != ?")
      .bind(this.keks.current)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  // ---- internals ----------------------------------------------------------------------------

  private async run(sql: string, args: unknown[]): Promise<number> {
    return (
      await this.db
        .prepare(sql)
        .bind(...args)
        .run()
    ).meta.changes;
  }

  private read(userId: string): Promise<GrantRow | null> {
    return this.db.prepare("SELECT * FROM token_grant WHERE user_id = ?").bind(userId).first<GrantRow>();
  }

  private kek(kid: string): Promise<CryptoKey> {
    let key = this.kekCache.get(kid);
    if (!key) {
      const raw = this.keks.keys[kid];
      if (raw === undefined) return Promise.reject(new Error(`unknown KEK ${kid}`));
      key = crypto.subtle.importKey("raw", fromBase64(raw), "AES-KW", false, ["wrapKey", "unwrapKey"]);
      this.kekCache.set(kid, key);
    }
    return key;
  }

  private async wrap(dek: CryptoKey, kid: string): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.wrapKey("raw", dek, await this.kek(kid), "AES-KW"));
  }

  private async unwrap(row: GrantRow): Promise<CryptoKey> {
    return crypto.subtle.unwrapKey(
      "raw",
      bytes(row.dek_wrapped),
      await this.kek(row.kid),
      "AES-KW",
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
  }

  /** Moves the data key under the current KEK. Guarded by the old kid, so a concurrent re-wrap is harmless. */
  private async rewrap(row: GrantRow, dek: CryptoKey): Promise<void> {
    if (row.kid === this.keks.current) return;
    const wrapped = await this.wrap(dek, this.keks.current);
    await this.run("UPDATE token_grant SET kid = ?, dek_wrapped = ? WHERE user_id = ? AND kid = ?", [
      this.keks.current,
      blob(wrapped),
      row.user_id,
      row.kid,
    ]);
  }

  private async sealFields(dek: CryptoKey, userId: string, version: number, rt: string | null, at: string) {
    const refresh = rt === null ? null : await seal(dek, aad(userId, version, "rt"), rt);
    const access = await seal(dek, aad(userId, version, "at"), at);
    return {
      rtCt: refresh && blob(refresh.ct),
      rtIv: refresh && blob(refresh.iv),
      atCt: blob(access.ct),
      atIv: blob(access.iv),
    };
  }

  /** The cached access token while it is valid. Also records use, at most once a day. */
  private async cachedToken(row: GrantRow, dek: CryptoKey): Promise<string | null> {
    if (row.at_ct === null || row.at_exp === null || row.at_exp - SKEW_MS <= this.now()) return null;
    const token = await open(dek, aad(row.user_id, row.version, "at"), row.at_ct, row.at_iv);
    if (this.now() - row.updated_at > TOUCH_MS) {
      await this.run("UPDATE token_grant SET updated_at = ? WHERE user_id = ? AND version = ?", [
        this.now(),
        row.user_id,
        row.version,
      ]);
    }
    return token;
  }
}
