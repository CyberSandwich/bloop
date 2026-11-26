// The rule a stored library file name must satisfy (LIB-06), shared by the Worker and the library page. It sits apart
// from names.js because the bundler keeps every export of a file a page imports, and the pairing pages import names.js.

/** Longest file name the library stores or accepts in a rename, in code points, extension included. */
export const NAME_MAX = 200;

/**
 * Characters no stored name may hold: C0 and C1 controls, the line and paragraph separators, every bidi control
 * (overrides, isolates and the invisible LRM, RLM and ALM marks), the invisible zero-width space, word joiner and
 * byte-order mark, lone surrogates and both slashes. The joiner and non-joiner stay: emoji sequences and several scripts
 * need them.
 * @param {number} c a code point
 */
const refused = (c) =>
  c <= 0x1f ||
  (c >= 0x7f && c <= 0x9f) ||
  c === 0x061c ||
  c === 0x200b ||
  c === 0x200e ||
  c === 0x200f ||
  c === 0x2060 ||
  c === 0xfeff ||
  c === 0x2028 ||
  c === 0x2029 ||
  (c >= 0x202a && c <= 0x202e) ||
  (c >= 0x2066 && c <= 0x2069) ||
  (c >= 0xd800 && c <= 0xdfff) ||
  c === 0x2f ||
  c === 0x5c;

/** @param {string} char one code point */
export const refusedChar = (char) => refused(/** @type {number} */ (char.codePointAt(0)));

/**
 * Whether a name may be stored as typed: at least one and at most NAME_MAX code points, none of them refused.
 * @param {string} name
 */
export const isValidName = (name) => {
  const chars = Array.from(name);
  return chars.length >= 1 && chars.length <= NAME_MAX && !chars.some(refusedChar);
};
