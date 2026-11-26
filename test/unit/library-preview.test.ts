import { describe, expect, it } from "vitest";
import {
  type Claims,
  keyId,
  mintPreview,
  PREVIEW_TTL_MS,
  previewKeys,
  verifyPreview,
} from "../../src/worker/library/preview.ts";

const KEY = "k".repeat(32);
const OLD = "o".repeat(32);
const NOW = 1_700_000_000_000;
const claims = { f: "file1", v: 1, a: "bundle" } as const;

const mint = async (key = KEY, now = NOW) => (await mintPreview(key, claims, now)).token;
/** Replaces one dot-separated part of a token. */
const swap = (token: string, part: number, value: string) =>
  token
    .split(".")
    .map((p, i) => (i === part ? value : p))
    .join(".");

describe("LIB-04 hmac", () => {
  it("round-trips the claims", async () => {
    const got = await verifyPreview([KEY], await mint(), NOW + 1000);
    expect(got).toEqual({ ...claims, exp: NOW + PREVIEW_TTL_MS } satisfies Claims);
  });

  it("refuses a flipped byte in the claims, the mac or the key id", async () => {
    const token = await mint();
    const flip = (s: string) => `${s.slice(0, -1)}${s.endsWith("A") ? "B" : "A"}`;
    for (const part of [1, 2, 3]) {
      expect(await verifyPreview([KEY], swap(token, part, flip(token.split(".")[part] as string)), NOW)).toBeNull();
    }
  });

  it("refuses a wrong key and a swapped payload", async () => {
    expect(await verifyPreview(["x".repeat(32)], await mint(), NOW)).toBeNull();
    const other = (await mintPreview(KEY, { ...claims, f: "file2" }, NOW)).token;
    expect(await verifyPreview([KEY], swap(await mint(), 2, other.split(".")[2] as string), NOW)).toBeNull();
  });

  it("refuses a malformed token and another version prefix", async () => {
    const token = await mint();
    for (const bad of ["", "p1", "a.b.c", `${token}.x`, swap(token, 0, "p2")]) {
      expect(await verifyPreview([KEY], bad, NOW)).toBeNull();
    }
  });

  it("refuses claims of the wrong shape even when signed", async () => {
    const forged = await mintPreview(KEY, { f: "x", v: 1.5, a: "weird" } as never, NOW);
    expect(await verifyPreview([KEY], forged.token, NOW)).toBeNull();
  });
});

describe("LIB-04 version: the claim names the version", () => {
  it("carries the version so the handler can compare it with the row's", async () => {
    const t = (await mintPreview(KEY, { ...claims, v: 3 }, NOW)).token;
    expect((await verifyPreview([KEY], t, NOW))?.v).toBe(3);
  });
});

describe("LIB-04 expiry", () => {
  it("lives at most 300 s, however long a caller asks", async () => {
    const t = await mintPreview(KEY, claims, NOW, 3_600_000);
    expect(t.exp).toBe(NOW + PREVIEW_TTL_MS);
    expect(await verifyPreview([KEY], t.token, NOW + PREVIEW_TTL_MS - 1)).not.toBeNull();
    expect(await verifyPreview([KEY], t.token, NOW + PREVIEW_TTL_MS)).toBeNull();
  });

  it("refuses an exp further out than the ceiling", async () => {
    expect(await verifyPreview([KEY], await mint(), NOW - 1)).toBeNull();
  });
});

describe("LIB-04 rotation", () => {
  it("accepts a token of the previous key until its own expiry, then not", async () => {
    const old = await mint(OLD);
    const keys = [KEY, OLD];
    expect(await verifyPreview(keys, old, NOW + 10_000)).not.toBeNull();
    expect(await verifyPreview(keys, old, NOW + PREVIEW_TTL_MS + 1)).toBeNull();
    expect(await verifyPreview([KEY], old, NOW + 10_000)).toBeNull();
  });

  it("verifies under the configured current and previous keys, and under neither of an unrelated key", async () => {
    const keys = previewKeys({ fileTokenKey: KEY, fileTokenKeyPrevious: OLD });
    expect(await verifyPreview(keys, await mint(OLD), NOW + 1)).not.toBeNull();
    expect(await verifyPreview(keys, await mint(KEY), NOW + 1)).not.toBeNull();
    expect(await verifyPreview(keys, await mint("z".repeat(32)), NOW + 1)).toBeNull();
  });

  it("without a previous key only the current verifies; without a current key nothing does", async () => {
    expect(previewKeys({ fileTokenKey: KEY, fileTokenKeyPrevious: null })).toEqual([KEY]);
    expect(
      await verifyPreview(previewKeys({ fileTokenKey: KEY, fileTokenKeyPrevious: null }), await mint(OLD), NOW),
    ).toBeNull();
    expect(previewKeys({ fileTokenKey: null, fileTokenKeyPrevious: OLD })).toEqual([]);
  });

  it("names its key by a short hash, not the key", async () => {
    const id = await keyId(KEY);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect((await mint()).includes(KEY)).toBe(false);
  });
});
