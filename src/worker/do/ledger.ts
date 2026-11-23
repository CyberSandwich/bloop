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

export type Use = { ok: true; record: LinkRecord } | { ok: false; error: OpenError };

export class LinkLedger {
  constructor(private readonly kv: Kv) {}

  private all(): LinkRecord[] {
    return this.kv.get<LinkRecord[]>(KEY) ?? [];
  }

  add(record: LinkRecord): void {
    this.kv.put(KEY, [...this.all(), record]);
  }

  /**
   * Checks a link and, when it passes, counts the fetch in the same synchronous step: two requests cannot
   * both take the last allowed fetch.
   */
  use(tokenHash: string, now: number, limits: LinkConfig, binding: "link_binding_failed" | null): Use {
    const records = this.all();
    const found = findLink(records, tokenHash);
    if (!found) return { ok: false, error: "link_unknown" };
    const error = refusal(found, now, limits) ?? binding;
    if (error) return { ok: false, error };
    const counted: LinkRecord = { ...found, fetches: found.fetches + 1, firstFetchAt: found.firstFetchAt ?? now };
    this.kv.put(
      KEY,
      records.map((r) => (r === found ? counted : r)),
    );
    return { ok: true, record: counted };
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
