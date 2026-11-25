// The drop hint (design.md section 7, drag and drop), loaded at the page's first file drag. phone.js keeps all that
// must happen inside the event, and the drop itself, so a drop never waits on this module or is lost with it:
// claiming the drag, so the browser never opens the file, and taking the files, which a drop allows only while it
// runs. It hands each event here in order.
import { show } from "./ui.js";

const hintEl = /** @type {HTMLElement} */ (document.getElementById("drop-hint"));
let depth = 0;

/**
 * The hint shows while a file is over a page that can take one.
 * @param {string} type the drag event's type
 * @param {boolean} canAdd
 */
export function hint(type, canAdd) {
  if (type === "dragover") return;
  depth = type === "dragenter" ? depth + 1 : type === "dragleave" ? Math.max(0, depth - 1) : 0;
  show(hintEl, depth > 0 && canAdd);
}
