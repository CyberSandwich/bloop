import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ALPHABET, format, normalize } from "../../public/js/shared/codes.js";
import {
  base64url,
  drawCode,
  drawMatch,
  hmacHex,
  newRef,
  newSecret,
  parseCredential,
  randomInt,
  SECRET_SHAPE,
  safeEqual,
  sha256Hex,
} from "../../src/worker/ids.ts";

describe("PAIR-08 ids: handle format, length and entropy source", () => {
  it("a ref is 128 bits and a secret 256 bits, base64url, never repeated", () => {
    const refs = new Set(Array.from({ length: 200 }, newRef));
    expect(refs.size).toBe(200);
    for (const r of refs) expect(r).toMatch(/^[A-Za-z0-9_-]{22}$/);
    for (const s of [newSecret(), newSecret()]) expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The page gate drops any session cookie off this shape, so a change to newSecret must change it too.
    for (let i = 0; i < 200; i++) expect(SECRET_SHAPE.test(newSecret())).toBe(true);
  });

  it("parseCredential accepts ref.secret and nothing else", () => {
    const cred = `${newRef()}.${newSecret()}`;
    const parsed = parseCredential(cred);
    expect(`${parsed?.ref}.${parsed?.secret}`).toBe(cred);
    for (const bad of ["", "a.b", `${newRef()}`, `${cred}x`, `${cred}.y`, ` ${cred}`, `${newRef()}.${newSecret()}\n`]) {
      expect(parseCredential(bad), bad).toBeNull();
    }
  });

  it("stores only a SHA-256 hash, which differs from the secret and is stable", async () => {
    const secret = newSecret();
    const hash = await sha256Hex(secret);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(secret);
    expect(await sha256Hex(secret)).toBe(hash);
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("base64url encodes without padding or url-unsafe characters", () => {
    expect(base64url(new Uint8Array([251, 255, 254]))).toBe("-__-");
    expect(base64url(new Uint8Array([1]))).toBe("AQ");
  });

  it("hmacHex depends on the key and the text", async () => {
    const a = await hmacHex("key-one", "1.2.3.4");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hmacHex("key-two", "1.2.3.4")).not.toBe(a);
    expect(await hmacHex("key-one", "1.2.3.5")).not.toBe(a);
  });
});

describe("safeEqual", () => {
  it("agrees with ===", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(safeEqual(a, b)).toBe(a === b);
      }),
    );
    fc.assert(
      fc.property(fc.string(), (a) => {
        expect(safeEqual(a, a)).toBe(true);
      }),
    );
  });
});

describe("randomInt", () => {
  it("stays in range for every max", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 256 }), (max) => {
        for (let i = 0; i < 20; i++) {
          const n = randomInt(max);
          expect(n).toBeGreaterThanOrEqual(0);
          expect(n).toBeLessThan(max);
        }
      }),
    );
  });

  it("refuses a max it cannot sample without bias", () => {
    expect(() => randomInt(0)).toThrow(RangeError);
    expect(() => randomInt(257)).toThrow(RangeError);
  });
});

describe("PAIR-04 match: two digits, uniform over 00 to 99, fresh per draw", () => {
  it("only ever returns 00 to 99 and covers all 100 values", () => {
    const seen = new Map<string, number>();
    const draws = 100_000;
    for (let i = 0; i < draws; i++) {
      const m = drawMatch();
      expect(m).toMatch(/^\d{2}$/);
      seen.set(m, (seen.get(m) ?? 0) + 1);
    }
    expect(seen.size).toBe(100);
    // Expected 1,000 each, sd about 31. Six sigma either side.
    for (const n of seen.values()) {
      expect(n).toBeGreaterThan(810);
      expect(n).toBeLessThan(1190);
    }
  });
});

describe("drawCode", () => {
  it("draws only from the 30-symbol alphabet at the requested length, and the result normalizes", () => {
    for (const length of [6, 7]) {
      for (let i = 0; i < 200; i++) {
        const code = drawCode(length);
        expect(code).toHaveLength(length);
        for (const ch of code) expect(ALPHABET).toContain(ch);
        expect(normalize(code)).toBe(code);
      }
    }
  });

  it("uses every symbol about equally often", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 10_000; i++) for (const ch of drawCode(6)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(30);
    // Expected 2,000 each, sd about 44. Six sigma either side.
    for (const n of counts.values()) {
      expect(n).toBeGreaterThan(1730);
      expect(n).toBeLessThan(2270);
    }
  });
});

describe("codes.js", () => {
  it("normalizes case, spaces and dashes, and rejects excluded symbols and bad lengths", () => {
    expect(normalize("k7m q9x")).toBe("K7MQ9X");
    expect(normalize(" K7M-Q9X ")).toBe("K7MQ9X");
    expect(normalize("K7MQ9XA")).toBe("K7MQ9XA");
    for (const bad of ["", "K7MQ9", "K7MQ9XAB", "K7MQ90", "K7MQ9O", "K7MQ91", "K7MQ9I", "K7MQ9L", "K7MQ9U", "K7M!9X"]) {
      expect(normalize(bad), bad).toBeNull();
    }
  });

  it("formats as two groups of three", () => {
    expect(format("K7MQ9X")).toBe("K7M Q9X");
  });
});
