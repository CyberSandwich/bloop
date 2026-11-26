// The upload pill's face (docs/ux/upload.md section 1): a glass pill over the loader, with no engine behind it, so the
// room screen's receiving pill can wear it too.
import { splitName } from "./format.js";
import { loader, setProgress } from "./loader.js";
import { el, icon, setText } from "./ui.js";

const LEAVE_MS = 200;
/** Lucide `x`: no glyph of icons.js, which every page loads, is spent on the one lazy part that needs it. */
export const CLOSE = /** @type {import("../types.js").IconPart[]} */ (["M18 6 6 18", "m6 6 12 12"]);

/**
 * @typedef {object} Face
 * @property {string} [title]
 * @property {string} [line]
 * @property {number | null} [fill] 0 to 1; null while there is nothing to show yet
 * @property {import("../types.js").IconPart[] | null} [glyph] the tile's glyph
 * @property {string} [label] the progress bar's name, "Uploading Lecture 5.pptx"
 * @property {boolean} [sheen] the sweep: while bytes move, or while the work is not measurable
 * @property {boolean} [wrap] the title wraps (to two lines) instead of giving way in the middle: it ends in its own words
 * @property {(() => void) | null} [press] the pill is a button (a batch opening its sheet)
 * @property {(Node | string)[]} [slot] the end of the pill: Cancel, an action
 */

/**
 * @param {Face & {host?: {append: (node: Node) => void}}} first
 * @returns {{node: HTMLElement, update: (patch: Face) => void, leave: () => void}}
 */
export function pill({ host = document.body, ...first }) {
  const bar = loader("", null);
  const tile = el("span", { class: "thumb up-tile" });
  const title = el("strong", { class: "up-title" });
  const line = el("span", { class: "up-line" });
  const slot = el("span", { class: "up-slot" });
  const press = el("button", { class: "up-press", type: "button" });
  const node = el("div", { class: "up-pill glass" }, [
    bar,
    tile,
    el("span", { class: "up-text" }, [title, line]),
    press,
    slot,
  ]);
  /** @type {(() => void) | null} */
  let onPress = null;
  let shownTitle = "";
  /** @type {Face["glyph"]} */
  let shownGlyph;
  /** @type {(Node | string)[]} */
  let shownSlot = [];
  press.addEventListener("click", () => onPress?.());

  /** @param {Face} patch */
  function update(patch) {
    if (patch.title !== undefined && patch.title !== shownTitle) {
      shownTitle = patch.title;
      // A long name ellipsizes in the middle: the head gives way, the end and extension stay.
      const [head, tail] = splitName(patch.title);
      title.replaceChildren(el("span", { class: "head" }, [head]), el("span", { class: "tail" }, [tail]));
      press.setAttribute("aria-label", patch.title);
    }
    if (patch.line !== undefined) setText(line, patch.line);
    if (patch.fill !== undefined) setProgress(bar, patch.fill);
    if (patch.label !== undefined) bar.setAttribute("aria-label", patch.label);
    // Only what changed is touched: a button swapped under a finger between pointerdown and pointerup never clicks.
    if (patch.glyph !== undefined && patch.glyph !== shownGlyph) {
      shownGlyph = patch.glyph;
      tile.replaceChildren(...(patch.glyph ? [icon(patch.glyph)] : []));
    }
    if (patch.sheen !== undefined) node.classList.toggle("moving", patch.sheen);
    if (patch.wrap !== undefined) node.classList.toggle("wrap", patch.wrap);
    if (patch.press !== undefined) {
      onPress = patch.press;
      press.hidden = !patch.press;
    }
    if (patch.slot && !(patch.slot.length === shownSlot.length && patch.slot.every((n, i) => n === shownSlot[i]))) {
      shownSlot = patch.slot;
      slot.replaceChildren(...patch.slot);
    }
  }

  update({ press: null, fill: null, sheen: false, ...first });
  host.append(node);

  return {
    node,
    update,
    leave() {
      const calm = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (calm) return node.remove();
      node.classList.add("out");
      setTimeout(() => node.remove(), LEAVE_MS);
    },
  };
}
