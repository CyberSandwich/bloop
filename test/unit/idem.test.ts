import { describe, expect, it } from "vitest";
import { bodyDigest, IDEM_WINDOW_MS, type IdemStore, idempotency } from "../../src/worker/idem.ts";

const KEY = "3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c";
const NOW = 1_800_000_000_000;
const request = (key?: string) =>
  new Request("https://bloop.example/api/uploads", {
    method: "POST",
    headers: key === undefined ? {} : { "Idempotency-Key": key },
  });

/** An in-memory adapter: it keeps the first request per (owner, key hash) with the time it was stored. */
function memory() {
  const rows = new Map<string, { at: number; bodyHash: string; stored: string }>();
  const store: IdemStore<string> = {
    async find(owner, keyHash, since) {
      const row = rows.get(`${owner}|${keyHash}`);
      return row && row.at >= since ? row : null;
    },
  };
  return { rows, store };
}

describe("REL-14 idem: the Idempotency-Key contract", () => {
  it("REL-14 idem: no header is off, and a header that is not a UUID is bad", async () => {
    const { store } = memory();
    expect(await idempotency(request(), "{}", "u1", store, NOW)).toEqual({ kind: "off" });
    for (const bad of ["", "abc", `${KEY}x`, KEY.replaceAll("-", ""), "3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6g"]) {
      expect(await idempotency(request(bad), "{}", "u1", store, NOW), bad).toEqual({ kind: "bad" });
    }
  });

  it("REL-14 idem: a new key is fresh and carries the hashes to store, never the key itself", async () => {
    const { store } = memory();
    const result = await idempotency(request(KEY), '{"a":1}', "u1", store, NOW);
    expect(result.kind).toBe("fresh");
    if (result.kind !== "fresh") return;
    expect(result.bodyHash).toBe(await bodyDigest('{"a":1}'));
    expect(result.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("REL-14 idem: the same key and body inside the window replays the stored answer", async () => {
    const { store, rows } = memory();
    const first = await idempotency(request(KEY), '{"a":1}', "u1", store, NOW);
    if (first.kind !== "fresh") throw new Error("expected fresh");
    rows.set(`u1|${first.keyHash}`, { at: NOW, bodyHash: first.bodyHash, stored: "answer" });
    expect(await idempotency(request(KEY.toUpperCase()), '{"a":1}', "u1", store, NOW + 1000)).toEqual({
      kind: "replay",
      stored: "answer",
    });
  });

  it("REL-14 idem: the same key with another body is a conflict, and another owner's key is separate", async () => {
    const { store, rows } = memory();
    const first = await idempotency(request(KEY), '{"a":1}', "u1", store, NOW);
    if (first.kind !== "fresh") throw new Error("expected fresh");
    rows.set(`u1|${first.keyHash}`, { at: NOW, bodyHash: first.bodyHash, stored: "answer" });
    expect(await idempotency(request(KEY), '{"a":2}', "u1", store, NOW)).toEqual({ kind: "conflict" });
    expect((await idempotency(request(KEY), '{"a":1}', "u2", store, NOW)).kind).toBe("fresh");
  });

  it("REL-14 idem: after 24 hours the key is fresh again", async () => {
    const { store, rows } = memory();
    const first = await idempotency(request(KEY), "{}", "u1", store, NOW);
    if (first.kind !== "fresh") throw new Error("expected fresh");
    rows.set(`u1|${first.keyHash}`, { at: NOW, bodyHash: first.bodyHash, stored: "answer" });
    expect((await idempotency(request(KEY), "{}", "u1", store, NOW + IDEM_WINDOW_MS)).kind).toBe("replay");
    expect((await idempotency(request(KEY), "{}", "u1", store, NOW + IDEM_WINDOW_MS + 1)).kind).toBe("fresh");
  });
});
