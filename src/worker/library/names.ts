// The one place a library file name is judged (LIB-06). Names reach the page only through textContent, and downloads use
// filename*; this file keeps the stored value free of characters that reorder, hide or break a line.

import { isValidName, refusedChar } from "../../../public/js/shared/name-rule.js";

/**
 * A rename's new name: `base` NFC-normalized and trimmed, joined to the file's unchanged extension. A typed extension
 * stays part of the base. Null when the base is empty or the whole name is not valid (shared/name-rule.js: NAME_MAX code
 * points, no refused character).
 */
export function renamed(base: string, ext: string): string | null {
  const stem = base.normalize("NFC").trim();
  const name = `${stem}.${ext}`;
  return stem !== "" && isValidName(name) ? name : null;
}

/** Characters Windows refuses in a file name, besides the ones `refused` covers. */
const WINDOWS_NAME_CHARS = new Set([":", "<", ">", '"', "|", "?", "*"]);
/** Windows reads the part before the first dot as the device name, so `CON.tar.gz` is one too. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)$/i;
const isReservedStem = (stem: string): boolean => WINDOWS_RESERVED.test((stem.split(".", 1)[0] ?? "").trim());
export const EXPORT_NAME_BYTES = 200;
const MAX_EXPORT_EXT = 10;
const utf8 = new TextEncoder();

const cleaned = (s: string): string =>
  Array.from(s, (c) => (refusedChar(c) || WINDOWS_NAME_CHARS.has(c) ? "_" : c)).join("");

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
  const base = isReservedStem(stem) ? `_${stem}` : stem === "" ? "file" : stem;
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
