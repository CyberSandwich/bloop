// One item row's face, the sidebar's and the phone list's (design.md section 6): thumbnail or tile, name, meta line.
/** @import {Item} from "../../../src/shared/protocol.ts" */
import { itemIcon, itemLine, itemName, splitName } from "./format.js";
import { ICONS } from "./icons.js";
import { el, icon } from "./ui.js";

/** https only (LINK-01): the server allows nothing else, and the page checks again before it makes a link. */
export const linkTo = (
  /** @type {string} */ url,
  /** @type {Record<string, string>} */ attrs,
  /** @type {(Node | string)[]} */ kids,
) =>
  url.startsWith("https://")
    ? el("a", { ...attrs, href: url, target: "_blank", rel: "noopener noreferrer" }, kids)
    : el("span", attrs, kids);

/** A link's row, the sidebar's and the phone's: it opens a new tab, never the stage. @param {Node[]} face */
export const linkRow = (/** @type {string} */ url, /** @type {string} */ cls, face) =>
  linkTo(url, { class: cls }, [...face, icon(ICONS["arrow-up-right"], true), el("span", { class: "sr" }, ["New Tab"])]);

/** A 40 px tile holding the type glyph. @param {import("../types.js").IconPart[]} parts */
export const tile = (parts) => el("span", { class: "thumb" }, [icon(parts)]);

/**
 * @param {Item} item
 * @param {string | null} thumb a same-origin picture, or null for the type tile
 * @param {string | null} [date]
 * @returns {Node[]}
 */
export function rowFace(item, thumb, date = null) {
  const [head, tail] = splitName(itemName(item));
  return [
    // A page is shown whole on the tile (contained); a photo fills it (cover).
    thumb
      ? el("img", {
          class: `thumb${item.kind === "file" && (item.type === "pptx" || item.type === "pdf") ? " fit" : ""}`,
          src: thumb,
          alt: "",
        })
      : tile(itemIcon(item)),
    el("span", { class: "row-text" }, [
      el("span", { class: "row-name" }, [el("span", { class: "head" }, [head]), el("span", { class: "tail" }, [tail])]),
      el("span", { class: "small" }, [itemLine(item, date)]),
    ]),
  ];
}
