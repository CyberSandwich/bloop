// The one place a library file name is judged (LIB-06). Names reach the page only through textContent, and downloads use
// filename*; this file keeps the stored value free of characters that reorder, hide or break a line.

export const MAX_NAME_CHARS = 200;

/** C0 and C1 controls, the line and paragraph separators, bidi overrides and isolates, and both slashes. */
const refused = (c: number): boolean =>
  c <= 0x1f ||
  (c >= 0x7f && c <= 0x9f) ||
  c === 0x2028 ||
  c === 0x2029 ||
  (c >= 0x202a && c <= 0x202e) ||
  (c >= 0x2066 && c <= 0x2069) ||
  c === 0x2f ||
  c === 0x5c;

/**
 * A rename's new name: `base` NFC-normalized and trimmed, joined to the file's unchanged extension. A typed extension
 * stays part of the base. Null when the base is empty, holds a refused character or the whole name passes 200.
 */
export function renamed(base: string, ext: string): string | null {
  const stem = base.normalize("NFC").trim();
  const name = `${stem}.${ext}`;
  if (stem === "" || name.length > MAX_NAME_CHARS) return null;
  for (let i = 0; i < stem.length; i++) if (refused(stem.charCodeAt(i))) return null;
  return name;
}
