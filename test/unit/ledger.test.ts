import { describe, expect, it } from "vitest";
import { type Kv, LinkLedger } from "../../src/worker/do/ledger.ts";
import { type LinkRecord, MAX_AUDITED_IPS } from "../../src/worker/seams/open-path/links.ts";

const LIMITS = { firstFetchSeconds: 600, fetchWindowSeconds: 120, maxFetches: 10 } as Parameters<
  LinkLedger["check"]
>[2];

function memoryKv(): Kv & { size(): number } {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string) => m.get(k) as T | undefined,
    put: (k, v) => void m.set(k, JSON.parse(JSON.stringify(v))),
    size: () => JSON.stringify([...m.values()]).length,
  };
}

const record = (tokenHash: string): LinkRecord => ({
  tokenHash,
  purpose: "view",
  item: 0,
  mintedAt: 1,
  firstFetchAt: 2,
  fetches: 3,
  revoked: false,
  ips: Array.from({ length: MAX_AUDITED_IPS }, (_, i) => `ip-${tokenHash}-${i}`),
  refused: true,
});

/** One session: a few links minted, ranges read, then the session ends and every link is revoked. */
function session(ledger: LinkLedger, n: number): string[] {
  const hashes = [0, 1, 2].map((i) => `s${String(n).padStart(3, "0")}-link${i}`);
  for (const h of hashes) ledger.add(record(h));
  for (const h of hashes) ledger.use(h, 10, LIMITS, null);
  ledger.revokeAll();
  return hashes;
}

describe("OPEN-01 ledger bounded across sessions", () => {
  it("OPEN-01 ledger bounded: after many sessions the stored records stay at one session's worth", () => {
    const kv = memoryKv();
    const ledger = new LinkLedger(kv);
    session(ledger, 0);
    const afterOne = kv.size();
    for (let n = 1; n <= 50; n++) session(ledger, n);
    expect(kv.size()).toBe(afterOne);
  });

  it("OPEN-01 ledger bounded: an earlier session's token is refused as unknown, and the last one is still gone", () => {
    const ledger = new LinkLedger(memoryKv());
    const first = session(ledger, 0);
    const second = session(ledger, 1);
    for (const h of first) {
      expect(ledger.check(h, 20, LIMITS, null)).toEqual({ ok: false, error: "link_unknown", record: null });
      expect(ledger.use(h, 20, LIMITS, null).ok).toBe(false);
    }
    for (const h of second)
      expect(ledger.check(h, 20, LIMITS, null)).toMatchObject({ ok: false, error: "link_revoked" });
  });

  it("OPEN-01 ledger bounded: a live link of the new session is not touched by the sweep", () => {
    const ledger = new LinkLedger(memoryKv());
    session(ledger, 0);
    ledger.add(record("live-a"));
    ledger.add(record("live-b"));
    expect(ledger.check("live-a", 20, LIMITS, null).ok).toBe(true);
    expect(ledger.check("live-b", 20, LIMITS, null).ok).toBe(true);
    expect(ledger.revokeAll()).toBe(2);
  });
});
