// The name segment of a /f/ link. Cosmetic: the server ignores it, but it is the file name PowerPoint
// and the browser show and write into shortcuts, and it sits inside the 256-character Office URI.
// ASCII letters, digits and single hyphens only: no character the URI rules ban, no percent-encoding
// to inflate the length, no ".." possible.

/** Longest base name, before the extension. */
export const MAX_BASE = 60;

/**
 * @param {string} name a display name, with or without a .pptx or .pdf extension
 * @param {number} [max] longest base name
 * @returns {string} 1 to `max` characters of [A-Za-z0-9-], never starting or ending with a hyphen
 */
export function slugBase(name, max = MAX_BASE) {
  const stem = name.replace(/\.(pptx|pdf)$/i, "");
  const ascii = stem
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii.slice(0, Math.max(1, max)).replace(/-+$/, "") || "file";
}

/**
 * @param {string} name display name
 * @param {"pptx" | "pdf"} ext
 * @param {number} [max] longest base name
 * @returns {string} `<slug>.<ext>`
 */
export const linkFileName = (name, ext, max = MAX_BASE) => `${slugBase(name, max)}.${ext}`;
