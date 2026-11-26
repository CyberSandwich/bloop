// The pairing objects' Idempotency-Key adapter over KV (seams/pairing/idem.ts), driven through idem.ts's contract.
import { describe, expect, it } from "vitest";
import { IDEM_WINDOW_MS, idempotency } from "../../src/worker/idem.ts";
import { idemRepair, idemSave, idemStore, MAX_IDEM_ROWS } from "../../src/worker/seams/pairing/idem.ts";
import { memKv } from "./sqlite.ts";

const KEY = "3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c";
const NOW = 1_800_000_000_000;
const request = (key = KEY) => new Request("https://bloop.example/api/claim", { headers: { "Idempotency-Key": key } });

async function fresh(kv: ReturnType<typeof memKv>, body: string, owner = "ip-1", key = KEY, now = NOW) {
  const verdict = await idempotency(request(key), body, owner, idemStore<string>(kv), now);
  if (verdict.kind !== "fresh") throw new Error(`expected fresh, got ${verdict.kind}`);
  return verdict;
}

describe("REL-14 pairing idem adapter", () => {
  it("REL-14 adapter: a replay of the same key and body answers the first answer; another body is a conflict", async () => {
    const kv = memKv();
    const first = await fresh(kv, '{"code":"ABCDEF"}');
    idemSave(kv, "ip-1", first, "pid-1", NOW);
    const store = idemStore<string>(kv);
    expect(await idempotency(request(), '{"code":"ABCDEF"}', "ip-1", store, NOW + 5)).toEqual({
      kind: "replay",
      stored: "pid-1",
    });
    expect((await idempotency(request(), '{"code":"ZZZZZZ"}', "ip-1", store, NOW + 5)).kind).toBe("conflict");
    // Another owner's same key is its own.
    expect((await idempotency(request(), '{"code":"ABCDEF"}', "ip-2", store, NOW + 5)).kind).toBe("fresh");
  });

  it("REL-14 adapter: a key past the window is fresh again, and saving drops rows past it", async () => {
    const kv = memKv();
    const first = await fresh(kv, "{}");
    idemSave(kv, "ip-1", first, "old", NOW);
    const later = NOW + IDEM_WINDOW_MS + 1;
    const again = await fresh(kv, "{}", "ip-1", KEY, later);
    idemSave(kv, "ip-1", again, "new", later);
    expect((kv.data.get("idem") as unknown[]).length).toBe(1);
    expect(await idemStore<string>(kv).find("ip-1", again.keyHash, later - IDEM_WINDOW_MS)).toMatchObject({
      stored: "new",
    });
  });

  it("REL-14 adapter: the rows stay bounded, the oldest going first, and never hold the raw key", async () => {
    const kv = memKv();
    for (let n = 0; n < MAX_IDEM_ROWS + 5; n++) {
      const key = `3f2b8c1e-6a4d-4e0b-9c7a-${String(n).padStart(12, "0")}`;
      idemSave(kv, "ip-1", await fresh(kv, "{}", "ip-1", key), n, NOW + n);
    }
    const rows = kv.data.get("idem") as { stored: number }[];
    expect(rows).toHaveLength(MAX_IDEM_ROWS);
    expect(rows[0]?.stored).toBe(5);
    expect(JSON.stringify(rows)).not.toContain("3f2b8c1e");
  });

  it("REL-14 adapter: the wake check keeps valid rows, drops malformed ones, and leaves a clean store unwritten", () => {
    const hash = "b".repeat(64);
    const good = { owner: "o", keyHash: hash, bodyHash: hash, at: NOW, stored: 1 };
    const kv = memKv({ idem: [good, { owner: "o" }, 7] });
    idemRepair(kv);
    expect(kv.data.get("idem")).toEqual([good]);
    const writes: string[] = [];
    idemRepair({ get: kv.get, put: (k) => void writes.push(k) });
    idemRepair({ get: memKv().get, put: (k) => void writes.push(k) });
    expect(writes).toEqual([]);
  });
});
