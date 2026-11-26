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

/** Characters Windows refuses in a file name, besides the ones `refused` covers. */
const WINDOWS_NAME_CHARS = new Set([":", "<", ">", '"', "|", "?", "*"]);
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export const EXPORT_NAME_BYTES = 200;
const MAX_EXPORT_EXT = 10;
const utf8 = new TextEncoder();

const cleaned = (s: string): string =>
  Array.from(s, (c) => (refused(c.codePointAt(0) as number) || WINDOWS_NAME_CHARS.has(c) ? "_" : c)).join("");

/** At most `bytes` UTF-8 bytes of `s`, cut on a code point. */
function fitBytes(s: string, bytes: number): string {
  let out = "";
  let used = 0;
  for (const c of s) {
    const n = utf8.encode(c).length;
    if (used + n > bytes) break;
    out += c;
    used += n;
  }
  return out;
}

/**
 * The path an export entry gets (LIB-07): `folder/name`, NFC, with controls, bidi characters, separators and Windows'
 * forbidden characters replaced by `_`, a reserved device name prefixed, trailing dots and spaces cut and the name at most
 * 200 UTF-8 bytes with its extension kept. A path already in `used` (compared without case, as Windows and macOS extract)
 * gets ` (2)`, ` (3)` before its extension; the chosen path joins `used`.
 */
export function exportPath(folder: "Files" | "Trash", name: string, used: Set<string>): string {
  const normal = name.normalize("NFC");
  const dot = normal.lastIndexOf(".");
  const hasExt = dot > 0 && normal.length - dot <= MAX_EXPORT_EXT + 1;
  const ext = hasExt ? cleaned(normal.slice(dot)).replace(/[. ]+$/, "") : "";
  const stem = cleaned(hasExt ? normal.slice(0, dot) : normal)
    .replace(/^ +/, "")
    .replace(/[. ]+$/, "");
  const base = WINDOWS_RESERVED.test(stem) ? `_${stem}` : stem === "" ? "file" : stem;
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : ` (${n})`;
    const room = EXPORT_NAME_BYTES - utf8.encode(ext + suffix).length;
    const fitted = fitBytes(base, room).replace(/[. ]+$/, "");
    const path = `${folder}/${fitted === "" ? "file" : fitted}${suffix}${ext}`;
    if (!used.has(path.toLowerCase())) {
      used.add(path.toLowerCase());
      return path;
    }
  }
}
