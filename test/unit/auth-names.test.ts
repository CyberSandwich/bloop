import { describe, expect, it } from "vitest";
import { displayName, isDisplayName, NAME_MAX_CHARS } from "../../src/worker/auth/names.ts";

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
