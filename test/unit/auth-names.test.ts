import { describe, expect, it } from "vitest";
import { displayName, isDisplayName, NAME_MAX_CHARS, NAME_PIECES } from "../../src/worker/auth/names.ts";

const ZWJ = "\u200D";
const ZWNJ = "\u200C";

const ACCEPTED: [string, string][] = [
  ["plain letters and digits", "MacBook Pro 2024"],
  ["apostrophes and hyphen", "Duke's iPhone and Duke’s-iPad"],
  ["umlaut, precomposed", "Büro"],
  ["umlaut, decomposed (NFC joins it)", "Bu\u0308ro"],
  ["CJK", "仕事のパソコン"],
  ["Arabic", "هاتفي"],
  ["Persian with ZWNJ between letters", `می${ZWNJ}خواهم`],
  ["emoji", "🔑 key"],
  ["ZWJ sequence", `👩${ZWJ}💻 work`],
  ["skin tone", "👍\u{1F3FD}"],
  ["skin tone inside a ZWJ sequence", `👩\u{1F3FD}${ZWJ}💻`],
  ["presentation selector and ZWJ", `🏳\uFE0F${ZWJ}🌈`],
  ["flag", "🇩🇪 laptop"],
  ["subdivision flag (tag sequence)", "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"],
  ["keycap", "1\uFE0F\u20E3"],
  ["surrounding spaces are trimmed", "  MacBook  "],
  ["exactly the limit", "x".repeat(NAME_MAX_CHARS)],
];

const REFUSED: [string, string][] = [
  ["empty", ""],
  ["spaces only", "   "],
  ["over the limit", "x".repeat(NAME_MAX_CHARS + 1)],
  ["right-to-left override", "evil\u202Egnp.exe"],
  ["bidi isolates", "\u2066x\u2069"],
  ["left-to-right mark", "a\u200Eb"],
  ["zero-width space", "a\u200Bb"],
  ["byte order mark inside (trim drops one at an end)", "na\uFEFFme"],
  ["ZWJ between letters", `a${ZWJ}b`],
  ["lone ZWJ", ZWJ],
  ["ZWNJ outside letters", `${ZWNJ}a`],
  ["ZWNJ before an emoji", `a${ZWNJ}🔑`],
  ["skin tone with no emoji", "\u{1F3FD}"],
  ["one regional indicator", "\u{1F1E9}"],
  ["tags with no emoji", "a\u{E0067}\u{E007F}"],
  ["Hangul filler alone", "\u3164"],
  ["Hangul filler padding", "a\u3164\u3164b"],
  ["halfwidth Hangul filler", "\uFFA0"],
  ["Hangul choseong filler", "\u115F"],
  ["combining marks alone", "\u0301\u0301"],
  ["lone high surrogate", "a\uD800b"],
  ["lone low surrogate", "\uDC00"],
  ["URL", "https://evil.example"],
  ["host with a path", "bloop.here/signin"],
  ["newline", "line\nbreak"],
  ["tab", "a\tb"],
  ["no-break space", "a\u00A0b"],
  ["angle brackets", "<b>x</b>"],
  ["tags after an emoji that is not the black flag", "\u{1F511}\u{E0067}\u{E0062}\u{E007F}"],
  ["tags with no cancel tag", "\u{1F3F4}\u{E0067}\u{E0062}"],
  ["a presentation selector after a letter", "a\uFE0F"],
  ["a keycap with no presentation selector on a symbol", "#\u20E3"],
];

/** Letters and marks that pass for the characters a URL needs; each is refused inside an otherwise good name. */
const CONFUSABLES: [string, string][] = [
  ["Lisu tone mya ti (.)", "\uA4F8"],
  ["Lisu tone na po (,)", "\uA4F9"],
  ["Lisu tone mya cya (..)", "\uA4FA"],
  ["Lisu tone mya bo (.,)", "\uA4FB"],
  ["Lisu tone mya na (;)", "\uA4FC"],
  ["Lisu tone mya jeu (:)", "\uA4FD"],
  ["Canadian syllabics final acute (/)", "\u141F"],
  ["Canadian syllabics final grave (\\)", "\u1420"],
  ["Canadian syllabics final middle dot (.)", "\u1427"],
  ["modifier triangular colon (:)", "\u02D0"],
  ["modifier half triangular colon", "\u02D1"],
  ["combining short solidus overlay (/)", "\u0337"],
  ["combining long solidus overlay (/)", "\u0338"],
];

describe("display names: the one rule (passkeys, library names)", () => {
  it.each(ACCEPTED)("accepts %s", (_label, value) => {
    expect(isDisplayName(value)).toBe(true);
    expect(displayName.safeParse(value).success).toBe(true);
  });

  it.each(REFUSED)("refuses %s", (_label, value) => {
    expect(isDisplayName(value)).toBe(false);
    expect(displayName.safeParse(value).success).toBe(false);
  });

  it.each(CONFUSABLES)("refuses the lookalike %s", (_label, char) => {
    expect(isDisplayName(`bloop${char}here${char}signin`)).toBe(false);
    expect(isDisplayName(char)).toBe(false);
  });

  /**
   * A regression must fail here, not hang the run: a synchronous regex cannot be interrupted, so the names stay near
   * 20 code points, where an exponential blowup is still slow enough to see, and the bound is the fastest of 5 runs.
   */
  const decidedFast = (name: string, label: string) => {
    expect([...name].length, label).toBeLessThanOrEqual(21);
    const times = Array.from({ length: 5 }, () => {
      const start = performance.now();
      expect(isDisplayName(name), label).toBe(false);
      return performance.now() - start;
    });
    expect(Math.min(...times), label).toBeLessThan(50);
  };
  /** `unit` repeated to 20 code points, then a refused tail. */
  const filled = (unit: string) => `${unit.repeat(Math.floor(20 / [...unit].length))}!`;

  it.each([
    "\u{1F600}\uFE0F\uFE0F",
    "\u{1F600}\u{1F3FD}\uFE0F",
    "a\u0301",
    "1\u20E3",
    "\u{1F469}\u200D",
    "\u{1F1E9}",
    "a\u200C",
    "ℹ",
    "ℹ\uFE0F",
  ])("a worst-case name built from %j is refused fast", (unit) => decidedFast(filled(unit), unit));

  it("each top-level piece, repeated with a refused tail, is refused fast", () => {
    const samples = ["1\uFE0F\u20E3", "a", "\u0301", "a\u200Ca", "\u{1F1E9}\u{1F1EA}", "\u{1F469}\u200D\u{1F469}"];
    expect(samples).toHaveLength(NAME_PIECES.length);
    NAME_PIECES.forEach((piece, i) => {
      const sample = samples[i] ?? "";
      expect(new RegExp(piece, "u").test(sample), piece).toBe(true);
      decidedFast(filled(sample), piece);
    });
  });

  /**
   * The invariant: no string splits into top-level pieces two ways. So no code point may start two pieces, checked
   * with a sticky match just after a letter and before the tails a piece can take (a letter, a keycap tail, a
   * subdivision flag's tags), except a digit, which starts both a keycap and a word: harmless, since the keycap's
   * FE0F starts no piece, so the word reading dead-ends. The characters that only continue a piece start none.
   */
  it("no string splits two ways: no code point starts two top-level pieces, and continuations start none", () => {
    const pieces = NAME_PIECES.map((p) => new RegExp(p, "uy"));
    const starts = (char: string) => {
      const found = new Set<number>();
      for (const s of [`a${char}a`, `a${char}\uFE0F\u20E3`, `a${char}\u{E0067}\u{E0062}\u{E007F}`])
        pieces.forEach((re, i) => {
          re.lastIndex = 1;
          if (re.test(s)) found.add(i);
        });
      return [...found].sort();
    };
    const [KEYCAP, WORD, , ZWNJ] = [0, 1, 2, 3];
    const overlaps: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const char = String.fromCodePoint(cp);
      const found = starts(char);
      const digit = /^[0-9]$/.test(char) && found.join() === [KEYCAP, WORD].join();
      if (found.length > 1 && !digit) overlaps.push(cp.toString(16));
    }
    expect(overlaps).toEqual([]);
    const continuations = ["\u200D", "\uFE0F", "\u{1F3FB}", "\u{1F3FF}"];
    for (let cp = 0xe0030; cp <= 0xe007f; cp++) continuations.push(String.fromCodePoint(cp));
    for (const char of continuations) expect(starts(char), char.codePointAt(0)?.toString(16)).toEqual([]);
    expect(starts("\u200C")).toEqual([ZWNJ]);
  });

  it("the schema stores the NFC, trimmed form", () => {
    expect(displayName.parse("  Bu\u0308ro ")).toBe("Büro");
  });

  it("the limit counts code points, so a long ZWJ family still fits", () => {
    const family = `👩${ZWJ}👩${ZWJ}👧${ZWJ}👦`;
    expect([...family].length).toBe(7);
    expect(isDisplayName(family.repeat(5))).toBe(true);
    expect(isDisplayName(family.repeat(6))).toBe(false);
  });
});
