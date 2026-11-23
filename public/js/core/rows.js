// One item row's face, shared by the screen's sidebar and the phone's list (docs/design.md section 6): a 40 px
// thumbnail or type tile, the name on one line, then the kind, size and date line.
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
    thumb ? el("img", { class: "thumb", src: thumb, alt: "", width: "40", height: "40" }) : tile(itemIcon(item)),
    el("span", { class: "row-text" }, [
      el("span", { class: "row-name" }, [el("span", { class: "head" }, [head]), el("span", { class: "tail" }, [tail])]),
      el("span", { class: "small" }, [itemLine(item, date)]),
    ]),
  ];
}
