// What the pill shows of a file: its kind glyph, and the rule that fits the name beside the status (docs/ux/upload.md
// section 1).
import { ICONS } from "./icons.js";

/** Fewer visible characters of a name than this is no name: the pill drops it, and the tile and the accessible names carry it. */
export const MIN_NAME_CHARS = 8;
const CHAR_EM = 0.55;

/** @param {string} name */
export const glyphOf = (name) =>
  /\.pptx?$/i.test(name)
    ? ICONS.presentation
    : /\.(mp4|mov|webm)$/i.test(name)
      ? ICONS.film
      : /\.(jpe?g|png|gif|webp|heic)$/i.test(name)
        ? ICONS.image
        : ICONS["file-text"];

/**
 * Hides the name (`.bare`) while its room is under MIN_NAME_CHARS. It looks again when the text area or the status
 * changes size, and measures with the name shown.
 * @param {HTMLElement} node the pill
 */
export function fitName(node) {
  const check = () => {
    node.classList.remove("bare");
    const head = node.querySelector(".head");
    if (head && head.clientWidth < MIN_NAME_CHARS * CHAR_EM * parseFloat(getComputedStyle(head).fontSize)) {
      node.classList.add("bare");
    }
  };
  const watch = new ResizeObserver(check);
  for (const part of [".up-text", ".up-status"]) {
    const it = node.querySelector(part);
    if (it) watch.observe(it);
  }
}
