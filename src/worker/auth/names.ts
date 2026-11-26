// The one rule for a name a member types and others may see (ADR 0014): a passkey's name today. TRANSITIONAL(L): the
// library's own names take `displayName` too. Letters, marks, digits, space, hyphen, apostrophe and whole emoji (ZWJ
// sequences, skin tones, keycaps, flags, subdivision flags), at most 40 code points after NFC and trimming. Every
// other format character is refused, bidi controls and the zero-width space included: ZWJ stands only inside an emoji
// sequence and ZWNJ only between letters (Persian). No ASCII punctuation but the apostrophe and hyphen, nor the
// lookalike letters below, so the plain forms of a URL are refused; a confusable this list lacks is not, so the rule
// does not promise that no name can look like a link.
import { z } from "zod";

export const NAME_MAX_CHARS = 40;

/**
 * Trap: each piece below can match a character in one way only. FE0F is a mark, so the top-level mark excludes it and
 * only an emoji or a keycap takes it; were both allowed, a long refused name would backtrack exponentially. The same
 * holds for a letter that is also pictographic (U+2139), so WORD excludes those.
 */
const MARK = String.raw`(?!\uFE0F)\p{M}`;
const PICTO = String.raw`\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F)*`;
/** A subdivision flag (England, Scotland, Wales): the black flag, its tag letters and digits, the cancel tag. */
const SUBFLAG = String.raw`\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{2,6}\u{E007F}`;
const EMOJI = `(?:${SUBFLAG}|${PICTO})`;
const KEYCAP = String.raw`[0-9#*]\uFE0F\u20E3`;
const WORD = String.raw`(?!\p{Extended_Pictographic})[\p{L}\p{N}]|[ '’-]`;
/** The top-level alternatives, exported so a test can prove no code point alone matches two of them. */
export const NAME_PIECES = [
  KEYCAP,
  WORD,
  MARK,
  String.raw`(?<=\p{L}\p{M}*)\u200C(?=\p{L})`,
  String.raw`\p{Regional_Indicator}{2}`,
  String.raw`${EMOJI}(?:\u200D${EMOJI})*`,
] as const;
const ALLOWED = new RegExp(`^(?:${NAME_PIECES.join("|")})+$`, "u");
/**
 * Letters and marks refused anywhere: the Hangul fillers, which render as nothing and would pad or blank a name, and
 * the ones that pass for ".", ":" or "/" (Lisu tone letters, Canadian syllabics finals, the modifier colons, the
 * combining solidus overlays).
 */
const REFUSED = /[\u115F\u1160\u3164\uFFA0\uA4F8-\uA4FD\u141F\u1420\u1427\u02D0\u02D1]|\u0337|\u0338/u;
/** Something a reader sees: what keeps a name of spaces, marks and joiners alone out. */
const VISIBLE = /[\p{L}\p{N}\p{Extended_Pictographic}\p{Regional_Indicator}]/u;

/** True when the NFC-normalized, trimmed value is a valid display name. A lone surrogate matches no class above. */
export function isDisplayName(value: string): boolean {
  const name = value.normalize("NFC").trim();
  return [...name].length <= NAME_MAX_CHARS && ALLOWED.test(name) && !REFUSED.test(name) && VISIBLE.test(name);
}

/** The schema form: trims and NFC-normalizes, then applies the rule. */
export const displayName = z
  .string()
  .transform((v) => v.normalize("NFC").trim())
  .refine(isDisplayName, { message: "invalid name" });
