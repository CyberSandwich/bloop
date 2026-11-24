// The per-screen record of minted links (architecture section 8.2, `links`). It holds hashes and counters,
// never a token or a URL, and survives `end` as revoked tombstones until the object closes: a holder of a
// real token then gets "gone" (410) while a guess gets "unknown" (404), and a guesser cannot tell them apart.

import type { OpenError } from "../../shared/protocol.ts";
import type { LinkConfig } from "../config.ts";
import { findLink, type LinkRecord, refusal } from "../seams/open-path/links.ts";

/** The slice of Durable Object KV storage the ledger needs. */
export interface Kv {
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
}

const KEY = "links";

/** A refusal carries the record it found (null for an unknown hash), so the caller can audit a view link once. */
export type Use = { ok: true; record: LinkRecord } | { ok: false; error: OpenError; record: LinkRecord | null };

export class LinkLedger {
  constructor(private readonly kv: Kv) {}

  private all(): LinkRecord[] {
    return this.kv.get<LinkRecord[]>(KEY) ?? [];
  }

  add(record: LinkRecord): void {
    this.kv.put(KEY, [...this.all(), record]);
  }

  /** The link rules alone: counts nothing. */
  check(tokenHash: string, now: number, limits: LinkConfig, binding: "link_binding_failed" | null): Use {
    const found = findLink(this.all(), tokenHash);
    if (!found) return { ok: false, error: "link_unknown", record: null };
    const error = refusal(found, now, limits) ?? binding;
    return error ? { ok: false, error, record: found } : { ok: true, record: found };
  }

  /**
   * Checks a link and, when it passes, counts the fetch in the same synchronous step: two requests cannot
   * both take the last allowed fetch.
   */
  use(tokenHash: string, now: number, limits: LinkConfig, binding: "link_binding_failed" | null): Use {
    const checked = this.check(tokenHash, now, limits, binding);
    if (!checked.ok) return checked;
    const { record } = checked;
    const counted = this.update(record, { fetches: record.fetches + 1, firstFetchAt: record.firstFetchAt ?? now });
    return { ok: true, record: counted };
  }

  /** Writes `change` onto the stored record with `record`'s hash; call in the same synchronous step as the read. */
  update(record: LinkRecord, change: Partial<LinkRecord>): LinkRecord {
    const next: LinkRecord = { ...record, ...change };
    this.kv.put(
      KEY,
      this.all().map((r) => (r.tokenHash === record.tokenHash ? next : r)),
    );
    return next;
  }

  revokeAll(): number {
    const records = this.all();
    this.kv.put(
      KEY,
      records.map((r) => ({ ...r, revoked: true })),
    );
    return records.filter((r) => !r.revoked).length;
  }
}
