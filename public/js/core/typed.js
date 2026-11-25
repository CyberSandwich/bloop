// Typed code entry helpers, apart from format.js so /code loads no icon table.
import { normalize } from "../shared/codes.js";

/**
 * What a person typed, as it should read in the field: upper case, two groups ("K7M Q9X").
 * @param {string} raw
 */
export function typedCode(raw) {
  const s = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 7);
  return s.length > 3 ? `${s.slice(0, 3)} ${s.slice(3)}` : s;
}

/** The code the server accepts for what was typed, or null. @param {string} raw */
export const typedValid = (raw) => normalize(raw);
