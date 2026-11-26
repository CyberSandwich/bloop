// The one rule for a name a member types and others may see (a passkey's name; the library uses it for its own names).
// Letters, marks, digits, space, hyphen, apostrophe and whole emoji (ZWJ sequences, skin tones, flags, tag
// sequences), at most 40 code points after NFC and trimming. Every other format character is refused, bidi controls
// and the zero-width space included: ZWJ stands only inside an emoji sequence and ZWNJ only between letters (Persian).
// A URL cannot be written in it, so a name never reads as a link.
import { z } from "zod";

export const NAME_MAX_CHARS = 40;

/** One emoji: a pictograph with its skin tone, presentation selector or tag sequence (the subdivision flags). */
const PICTO = String.raw`\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F|[\u{E0020}-\u{E007E}]+\u{E007F})*`;
const ALLOWED = new RegExp(
  String.raw`^(?:[\p{L}\p{M}\p{N} '’-]|(?<=\p{L}\p{M}*)\u200C(?=\p{L})|\p{Regional_Indicator}{2}|${PICTO}(?:\u200D${PICTO})*)+$`,
  "u",
);
/** Letters that render as nothing (the Hangul fillers), refused anywhere: they would pad or blank a name. */
const FILLERS = /[\u115F\u1160\u3164\uFFA0]/u;
/** Something a reader sees: what keeps a name of spaces, marks and joiners alone out. */
const VISIBLE = /[\p{L}\p{N}\p{Extended_Pictographic}\p{Regional_Indicator}]/u;

/** True when the NFC-normalized, trimmed value is a valid display name. A lone surrogate matches no class above. */
export function isDisplayName(value: string): boolean {
  const name = value.normalize("NFC").trim();
  return [...name].length <= NAME_MAX_CHARS && ALLOWED.test(name) && !FILLERS.test(name) && VISIBLE.test(name);
}

/** The schema form: trims and NFC-normalizes, then applies the rule. */
export const displayName = z
  .string()
  .transform((v) => v.normalize("NFC").trim())
  .refine(isDisplayName, { message: "invalid name" });
