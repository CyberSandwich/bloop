// The name segment of a /f/ link. Cosmetic: the server ignores it, but it is the file name PowerPoint
// and the browser show and write into shortcuts, and it sits inside the 256-character Office URI.
// ASCII letters, digits and single hyphens only: no character the URI rules ban, no percent-encoding
// to inflate the length, no ".." possible.
/** @import {FileType} from "../../../src/shared/protocol.ts" */

/** Longest base name, before the extension. */
export const MAX_BASE = 60;

/**
 * @param {string} name a display name, with or without its file type's extension
 * @param {number} [max] longest base name
 * @returns {string} 1 to `max` characters of [A-Za-z0-9-], never starting or ending with a hyphen
 */
export function slugBase(name, max = MAX_BASE) {
  const stem = name.replace(/\.(pptx|pdf|jpe?g|png|webp|mp4|mov)$/i, "");
  const ascii = stem
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii.slice(0, Math.max(1, max)).replace(/-+$/, "") || "file";
}

/** Longest display name, in characters, extension included. */
export const MAX_DISPLAY = 120;

/**
 * A file name safe to show and store: control and format characters (including bidi overrides) removed,
 * path separators turned into hyphens, spaces collapsed, cut to `max` characters with the extension kept.
 * It is still untrusted text: pages set it with textContent only.
 * @param {string} raw
 * @param {number} [max]
 * @returns {string} empty when nothing printable is left
 */
export function cleanName(raw, max = MAX_DISPLAY) {
  const name = raw
    .normalize("NFC")
    .replace(/\p{C}/gu, "")
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
 * @param {string} name display name
 * @param {FileType} ext
 * @param {number} [max] longest base name
 * @returns {string} `<slug>.<ext>`
 */
export const linkFileName = (name, ext, max = MAX_BASE) => `${slugBase(name, max)}.${ext}`;
