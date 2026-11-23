// GuestDrop over an R2 bucket (private, `eu`) and the D1 `guest_file` ledger (ADR 0005). Objects live at
// `g/<128-bit random>`: the key is the capability, and it is only ever handed to /f/ through the session.
import type { Db } from "../../auth/db.ts";
import { newRef } from "../../ids.ts";
import {
  type Accepted,
  type GuestDrop,
  QuotaExhausted,
  type RangeReader,
  type Reservation,
  type Upload,
} from "./index.ts";
import { DEFAULT_OP_CAPS, type OpCaps, R2Meter } from "./meter.ts";
import { validate } from "./validate.ts";

/** The slice of an R2 bucket this file uses; the platform binding satisfies it (see `bucketOf`). */
export interface Bucket {
  put(
    key: string,
    value: ReadableStream<Uint8Array>,
    options?: { customMetadata?: Record<string, string> },
  ): Promise<{ size: number }>;
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

// Declared here because the Node tsconfig (tests) has no Workers types; undefined outside the Workers runtime.
declare const FixedLengthStream: (new (length: number) => TransformStream<Uint8Array, Uint8Array>) | undefined;
declare const crypto: Crypto & {
  DigestStream?: new (algorithm: string) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> };
};

const PREFIX = "g/";
const MAX_SWEEP_PAGES = 20;
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

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

  async reserve(sessionId: string, bytes: number, name: string, type: "pptx" | "pdf"): Promise<Reservation> {
    if (!(await this.meter.hasRoom())) return { ok: false, error: "storage_full" };
    const r2Key = `${PREFIX}${newRef()}`;
    // One statement, so concurrent drops cannot both pass the budget check.
    const res = await this.db
      .prepare(
        `INSERT OR REPLACE INTO guest_file (session_id, r2_key, bytes, type, sha256, name, created_at, deleted_at)
         SELECT ?1, ?2, ?3, ?4, '', ?5, ?6, NULL
         WHERE (SELECT COALESCE(SUM(bytes), 0) FROM guest_file WHERE deleted_at IS NULL AND session_id != ?1) + ?3 <= ?7`,
      )
      .bind(sessionId, r2Key, bytes, type, name, this.now(), this.budgetBytes)
      .run();
    return res.meta.changes === 0 ? { ok: false, error: "storage_full" } : { ok: true, r2Key };
  }

  async accept(u: Upload, maxBytes: number): Promise<Accepted> {
    if (u.length > maxBytes) return { ok: false, error: "too_large" };
    let stored: { size: number; sha256: string } | null;
    let checked: Awaited<ReturnType<typeof validate>> | null = null;
    try {
      stored = await this.store(u);
      if (stored) checked = await validate(this.ranges(u.r2Key, stored.size), u.declaredType);
    } catch (e) {
      if (!(e instanceof QuotaExhausted)) throw e;
      await this.delete(u.r2Key);
      return { ok: false, error: "storage_full" };
    }
    if (!stored || !checked) {
      await this.delete(u.r2Key);
      return { ok: false, error: "upload_aborted" };
    }
    if (!checked.ok) {
      await this.delete(u.r2Key);
      return checked;
    }
    await this.db
      .prepare("UPDATE guest_file SET bytes = ?, sha256 = ? WHERE session_id = ? AND r2_key = ?")
      .bind(stored.size, stored.sha256, u.sessionKey, u.r2Key)
      .run();
    return {
      ok: true,
      file: { r2Key: u.r2Key, name: u.name, type: checked.type, bytes: stored.size, sha256: stored.sha256 },
    };
  }

  /**
   * Streams the body into the bucket through a fixed-length stream (the declared length is the cap: a longer or
   * shorter body errors) and a digest. Null when the body did not match or the bucket refused it.
   */
  private async store(u: Upload): Promise<{ size: number; sha256: string } | null> {
    if (typeof FixedLengthStream === "undefined" || !crypto.DigestStream) throw new Error("needs the Workers runtime");
    if (!(await this.meter.charge("A"))) throw new QuotaExhausted();
    const fixed = new FixedLengthStream(u.length);
    const digest = new crypto.DigestStream("SHA-256");
    const hasher = digest.getWriter();
    const tap = new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        await hasher.write(chunk);
        controller.enqueue(chunk);
      },
      flush: () => hasher.close(),
    });
    const piped = u.body.pipeThrough(tap).pipeTo(fixed.writable);
    const put = this.bucket.put(u.r2Key, fixed.readable, { customMetadata: { session: u.sessionKey } });
    const [pipe, object] = await Promise.allSettled([piped, put]);
    if (pipe.status === "rejected" || object.status === "rejected") return null;
    return { size: object.value.size, sha256: hex(await digest.digest) };
  }

  private ranges(key: string, size: number): RangeReader {
    return {
      size,
      read: async (offset, length) => {
        if (length <= 0 || offset >= size) return new Uint8Array();
        const part = await this.metered("B", () => this.bucket.get(key, { range: { offset, length } }));
        return part ? new Uint8Array(await part.arrayBuffer()) : new Uint8Array();
      },
    };
  }

  async read(r2Key: string) {
    const object = await this.metered("B", () => this.bucket.get(r2Key));
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
    if (keys.length > 0) await this.bucket.delete(keys);
    // Marked only after the delete returned: a failed delete leaves the row for the sweep (DROP-07).
    if (sessionId) {
      await this.db
        .prepare("UPDATE guest_file SET deleted_at = ? WHERE session_id = ? AND deleted_at IS NULL")
        .bind(this.now(), sessionId)
        .run();
    }
    return found || row !== null;
  }

  async sweep(olderThanMs: number): Promise<number> {
    const cutoff = this.now() - olderThanMs;
    let cursor: string | undefined;
    let deleted = 0;
    for (let page = 0; page < MAX_SWEEP_PAGES; page++) {
      // Past the cap the sweep stops and leaves its rows open: the 1-day lifecycle rule still deletes the objects.
      if (!(await this.meter.charge("A"))) return deleted;
      const listed = await this.bucket.list({ prefix: PREFIX, ...(cursor ? { cursor } : {}) });
      const old = listed.objects.filter((o) => o.uploaded.getTime() < cutoff).map((o) => o.key);
      if (old.length > 0) {
        await this.bucket.delete(old);
        deleted += old.length;
      }
      if (!listed.truncated) break;
      cursor = listed.cursor;
    }
    // Rows of the same age are done too, including a reservation whose upload never landed.
    await this.db
      .prepare("UPDATE guest_file SET deleted_at = ? WHERE deleted_at IS NULL AND created_at < ?")
      .bind(this.now(), cutoff)
      .run();
    return deleted;
  }
}
