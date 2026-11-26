// File names: the type a name declares, a name safe to show, and the name segment of a /f/ link.
// The segment is cosmetic: the server ignores it, but it is the file name PowerPoint
// and the browser show and write into shortcuts, and it sits inside the 256-character Office URI.
// ASCII letters, digits and single hyphens only: no character the URI rules ban, no percent-encoding
// to inflate the length, no ".." possible.
/** @import {FileType} from "../../../src/shared/protocol.ts" */

/** Longest base name, before the extension. */
export const MAX_BASE = 60;

/**
 * The one list of file extensions a guest may send and the type each declares: the drop route reads it, the phone
 * refuses anything else before sending, and a test ties the picker's accept list to it.
 * @type {Readonly<Record<string, FileType>>}
 */
export const EXTENSION_TYPES = {
  pptx: "pptx",
  pdf: "pdf",
  jpg: "jpg",
  jpeg: "jpg",
  png: "png",
  mp4: "mp4",
  mov: "mov",
};
const EXTENSION = new RegExp(`\\.(${Object.keys(EXTENSION_TYPES).join("|")})$`, "i");

/** @param {string} name @returns {FileType | null} the type its extension declares */
export const typeOfName = (name) => EXTENSION_TYPES[EXTENSION.exec(name)?.[1]?.toLowerCase() ?? ""] ?? null;

/**
 * @param {string} name a display name, with or without its file type's extension
 * @param {number} [max] longest base name
 * @returns {string} 1 to `max` characters of [A-Za-z0-9-], never starting or ending with a hyphen
 */
export function slugBase(name, max = MAX_BASE) {
  const stem = name.replace(EXTENSION, "");
  const ascii = stem
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii.slice(0, Math.max(1, max)).replace(/-+$/, "") || "file";
}

/** Longest stored file name, in code points, extension included. Display length is CSS ellipsis, never a cut. */
export const NAME_MAX = 200;

/**
 * The refused characters: every control, format, unassigned and private-use character (bidi overrides among them)
 * except the joiners emoji and Persian need (ZWJ, ZWNJ) and the tag characters a subdivision flag is built from.
 */
const REFUSED = "[\\p{C}--[\\u200C\\u200D\\u{E0020}-\\u{E007F}]]";
const REFUSED_ALL = new RegExp(REFUSED, "gv");
const REFUSED_ANY = new RegExp(REFUSED, "v");

/**
 * A file name safe to show and store: refused characters removed, path separators turned into hyphens,
 * spaces collapsed, cut to `max` code points with the extension kept.
 * It is still untrusted text: pages set it with textContent only.
 * @param {string} raw
 * @param {number} [max]
 * @returns {string} empty when nothing printable is left
 */
export function cleanName(raw, max = NAME_MAX) {
  const name = raw
    .normalize("NFC")
    .replace(REFUSED_ALL, "")
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(name);
  if (chars.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : "";
  return `${chars.slice(0, max - Array.from(ext).length).join("")}${ext}`;
}

/**
 * A typed name is refused, never cut: 1 to NAME_MAX code points and no refused character.
 * @param {string} name
 */
export const isValidName = (name) => name !== "" && !REFUSED_ANY.test(name) && Array.from(name).length <= NAME_MAX;

/**
 * @param {string} name display name
 * @param {FileType} ext
 * @param {number} [max] longest base name
 * @returns {string} `<slug>.<ext>`
 */
export const linkFileName = (name, ext, max = MAX_BASE) => `${slugBase(name, max)}.${ext}`;
