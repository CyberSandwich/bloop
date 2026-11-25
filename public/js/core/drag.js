// The drop hint and a dropped file (design.md section 7, drag and drop), loaded at the page's first file drag.
// phone.js keeps what must happen inside the event: claiming the drag, so the browser never opens the file, and
// reading the dropped files, which the event allows only while it runs. It hands each event here in order.
import { show } from "./ui.js";

const hint = /** @type {HTMLElement} */ (document.getElementById("drop-hint"));
let depth = 0;

/**
 * A dropped file takes the picker's road. The hint shows while a file is over a page that can take one.
 * @param {string} type the drag event's type
 * @param {File[]} files the dropped files (a drop only)
 * @param {boolean} canAdd
 * @param {(files: File[]) => void} choose
 */
export function drag(type, files, canAdd, choose) {
  if (type === "dragover") return;
  depth = type === "dragenter" ? depth + 1 : type === "dragleave" ? Math.max(0, depth - 1) : 0;
  show(hint, depth > 0 && canAdd);
  if (type === "drop" && canAdd) choose(files);
}
