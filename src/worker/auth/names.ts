// The one rule for a name a member types and others may see (a passkey's name; the library uses it for its own names).
// Letters, marks, digits, emoji, space, hyphen and apostrophe, at most 40 characters after trimming. Every other
// format character is refused, bidi controls and the zero-width space included; ZWJ alone stays, for emoji sequences.
// A URL cannot be written in it, so a name never reads as a link.
import { z } from "zod";

export const NAME_MAX_CHARS = 40;
const ALLOWED = /^(?:[\p{L}\p{M}\p{N}\p{Extended_Pictographic} '’-]|\u200D)+$/u;

/** True when the trimmed value is a valid display name. */
export function isDisplayName(value: string): boolean {
  const name = value.normalize("NFC").trim();
  return name.length > 0 && [...name].length <= NAME_MAX_CHARS && ALLOWED.test(name);
}

/** The schema form: trims and NFC-normalizes, then applies the rule. */
export const displayName = z
  .string()
  .transform((v) => v.normalize("NFC").trim())
  .refine(isDisplayName, { message: "invalid name" });
