// GuestDrop over an R2 bucket (private, `eu`) and the D1 `guest_file` ledger (ADR 0005). Objects live at
// `g/<128-bit random>`: the key is the capability, and it is only ever handed to /f/ through the session. The bytes
// arrive through the multipart pipeline (src/worker/uploads/guest.ts); this file holds the budget, reads and deletes.
import type { DropError, FileType } from "../../../shared/protocol.ts";
import type { Db } from "../../auth/db.ts";
import type { ByteRange } from "../open-path/range.ts";
import { type GuestDrop, QuotaExhausted, type SettledFile } from "./index.ts";
import { DEFAULT_OP_CAPS, type OpCaps, type OpClass, R2Meter } from "./meter.ts";

/** The slice of an R2 bucket this file uses; the platform binding satisfies it (see `bucketOf`). */
export interface Bucket {
  get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<{ body: ReadableStream<Uint8Array>; size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  head(key: string): Promise<{ size: number } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: {
    prefix?: string;
    cursor?: string;
  }): Promise<{ objects: { key: string; uploaded: Date }[]; truncated: boolean; cursor?: string }>;
}

/** The one cast from the platform binding to the slice above. */
export const bucketOf = (binding: unknown): Bucket => binding as Bucket;

const PREFIX = "g/";
const MAX_SWEEP_PAGES = 20;

export class R2GuestDrop implements GuestDrop {
  constructor(
    private readonly bucket: Bucket,
    private readonly db: Db,
    private readonly budgetBytes: number,
    private readonly now: () => number = Date.now,
    caps: OpCaps = DEFAULT_OP_CAPS,
  ) {
    this.meter = new R2Meter(db, caps, now);
  }

  private readonly meter: R2Meter;

  /** Counts one billed operation before it runs (meter.ts); refuses it at the cap, and when the count cannot be written. */
  private async metered<T>(cls: "A" | "B", op: () => Promise<T>): Promise<T> {
    if (!(await this.meter.charge(cls))) throw new QuotaExhausted();
    return op();
  }

  charge(cls: OpClass, n: number): Promise<boolean> {
    return this.meter.charge(cls, n).catch(() => false);
  }

  async reserve(
    sessionId: string,
    r2Key: string,
    bytes: number,
    name: string,
    type: FileType,
  ): Promise<DropError | null> {
    if (!(await this.meter.hasRoom())) return "storage_full";
    // One statement, so concurrent drops cannot both pass the budget check. Only a closed row is replaced: a live
    // row may own an object, and overwriting it would leave that object untracked by the budget.
    const res = await this.db
      .prepare(
        `INSERT INTO guest_file (session_id, r2_key, bytes, type, sha256, name, created_at, deleted_at)
         SELECT ?1, ?2, ?3, ?4, '', ?5, ?6, NULL
         WHERE (SELECT COALESCE(SUM(bytes), 0) FROM guest_file WHERE deleted_at IS NULL) + ?3 <= ?7
         ON CONFLICT (session_id) DO UPDATE SET r2_key = excluded.r2_key, bytes = excluded.bytes, type = excluded.type,
           sha256 = excluded.sha256, name = excluded.name, created_at = excluded.created_at, deleted_at = NULL
           WHERE guest_file.deleted_at IS NOT NULL`,
      )
      .bind(sessionId, r2Key, bytes, type, name, this.now(), this.budgetBytes)
      .run();
    if (res.meta.changes > 0) return null;
    const live = await this.db
      .prepare("SELECT 1 AS one FROM guest_file WHERE session_id = ? AND deleted_at IS NULL")
      .bind(sessionId)
      .first();
    return live ? "already_uploaded" : "storage_full";
  }

  async settle(sessionId: string, file: SettledFile): Promise<boolean> {
    const res = await this.db
      .prepare(
        "UPDATE guest_file SET bytes = ?3, sha256 = ?4, type = ?5 WHERE session_id = ?1 AND r2_key = ?2 AND deleted_at IS NULL",
      )
      .bind(sessionId, file.r2Key, file.size, file.sha256, file.kind)
      .run();
    return res.meta.changes > 0;
  }

  async read(r2Key: string, range?: ByteRange) {
    const object = await this.metered("B", () => this.bucket.get(r2Key, range ? { range } : undefined));
    return object ? { body: object.body, size: object.size } : null;
  }

  async delete(r2Key: string): Promise<void> {
    await this.bucket.delete(r2Key);
  }

  async purge(sessionId: string | null, r2Key: string | null): Promise<boolean> {
    const row = sessionId
      ? await this.db
          .prepare("SELECT r2_key FROM guest_file WHERE session_id = ? AND deleted_at IS NULL")
          .bind(sessionId)
          .first<{ r2_key: string }>()
      : null;
    const keys = [...new Set([r2Key, row?.r2_key].filter((k): k is string => !!k))];
    // The existence check only feeds the audit: past the cap, or when the count fails, the (free) delete still runs.
    const heads = await Promise.all(
      keys.map(async (k) => (await this.meter.charge("B").catch(() => false)) && (await this.bucket.head(k)) !== null),
    );
    const found = heads.some(Boolean);
    // One DeleteObject each: only that call is documented as free, the bulk DeleteObjects is not.
    for (const k of keys) {
      await this.bucket.delete(k);
      await this.deleteConverted(k);
    }
    // Marked only after the delete returned: a failed delete leaves the row for the sweep (DROP-07).
    if (sessionId) {
      await this.db
        .prepare("UPDATE guest_file SET deleted_at = ? WHERE session_id = ? AND deleted_at IS NULL")
        .bind(this.now(), sessionId)
        .run();
    }
    return found || row !== null;
  }

  /** The converter's outputs sit under `<key>/` (d/, n/); a list past the op cap leaves them to the lifecycle rule. */
  private async deleteConverted(key: string): Promise<void> {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_SWEEP_PAGES; page++) {
      if (!(await this.meter.charge("A").catch(() => false))) return;
      const listed = await this.bucket.list({ prefix: `${key}/`, ...(cursor ? { cursor } : {}) });
      for (const o of listed.objects) await this.bucket.delete(o.key);
      if (!listed.truncated) return;
      cursor = listed.cursor;
    }
  }

  async sweep(olderThanMs: number): Promise<number> {
    const cutoff = this.now() - olderThanMs;
    let cursor: string | undefined;
    let deleted = 0;
    let listedAll = false;
    for (let page = 0; page < MAX_SWEEP_PAGES; page++) {
      // Past the cap the sweep stops and leaves the remaining rows open: the 1-day lifecycle rule still deletes the objects.
      if (!(await this.meter.charge("A"))) return deleted;
      const listed = await this.bucket.list({ prefix: PREFIX, ...(cursor ? { cursor } : {}) });
      const old = listed.objects.filter((o) => o.uploaded.getTime() < cutoff).map((o) => o.key);
      if (old.length > 0) {
        // The bulk delete is not documented as free, so it is counted as one class A operation.
        if (!(await this.meter.charge("A"))) return deleted;
        await this.bucket.delete(old);
        deleted += old.length;
        await this.db
          .prepare(
            "UPDATE guest_file SET deleted_at = ? WHERE deleted_at IS NULL AND r2_key IN (SELECT value FROM json_each(?))",
          )
          .bind(this.now(), JSON.stringify(old))
          .run();
      }
      if (!listed.truncated) {
        listedAll = true;
        break;
      }
      cursor = listed.cursor;
    }
    // Only a complete listing proves the rest are gone: rows of the same age are then done too, including a
    // reservation whose upload never landed. A cut-off listing leaves them for the next run.
    if (listedAll) {
      await this.db
        .prepare("UPDATE guest_file SET deleted_at = ? WHERE deleted_at IS NULL AND created_at < ?")
        .bind(this.now(), cutoff)
        .run();
    }
    return deleted;
  }
}
