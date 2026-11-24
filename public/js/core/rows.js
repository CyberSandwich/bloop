// One item row's face, the sidebar's and the phone list's (design.md section 6): thumbnail or tile, name, meta line.
/** @import {Item} from "../../../src/shared/protocol.ts" */
import { itemIcon, itemLine, itemName, splitName } from "./format.js";
import { el, icon } from "./ui.js";

/** A 40 px tile holding the type glyph. @param {string[]} paths */
export const tile = (paths) => el("span", { class: "thumb" }, [icon(paths)]);

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
