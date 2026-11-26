// The batch's sheet (docs/ux/upload.md section 3): a dialog with a row per file, loaded when it is first opened.
import { el, icon, setText } from "./ui.js";

/**
 * @typedef {{id: number, name: string, state: string}} Row
 * @param {object} hooks what the binding knows
 * @param {{append: (node: Node) => void}} hooks.host
 * @param {(name: string) => import("../types.js").IconPart[]} hooks.glyph
 * @param {(row: any) => string} hooks.line the second line of a row, by its state
 * @param {(row: any) => HTMLElement | null} hooks.control a row's own control: Cancel, Check Again
 * @param {HTMLElement} hooks.close the sheet's own Close
 */
export function createSheet({ host, glyph, line, control, close }) {
  const dialog = /** @type {HTMLDialogElement} */ (el("dialog", { class: "up-sheet" }));
  dialog.addEventListener("click", (e) => e.target === dialog && dialog.close());
  host.append(dialog);
  /** @type {Map<number, HTMLElement>} */
  const lines = new Map();
  let key = "";
  return {
    /** Rebuilt only when the files or their states change; otherwise only the lines move, so focus and taps hold.
     * @param {Row[]} files @param {string} label */
    paint(files, label) {
      const next = files.map((f) => `${f.id}:${f.state}`).join(",");
      if (next !== key) {
        key = next;
        dialog.setAttribute("aria-label", label);
        const items = files.map((f) => {
          const text = el("span", { class: f.state === "refused" ? "up-line up-bad" : "up-line" }, [line(f)]);
          lines.set(f.id, text);
          const item = el("li", { class: "up-item" }, [
            icon(glyph(f.name)),
            el("span", { class: "up-text" }, [el("strong", { class: "up-title" }, [f.name]), text]),
          ]);
          const own = control(f);
          if (own) item.append(own);
          return item;
        });
        items.push(el("li", { class: "up-item" }, [close]));
        dialog.replaceChildren(el("ul", { class: "up-list glass glass-pane" }, items));
      } else for (const f of files) setText(/** @type {HTMLElement} */ (lines.get(f.id)), line(f));
    },
    show: () => dialog.open || dialog.showModal(),
    hide: () => dialog.close(),
    isOpen: () => dialog.open,
    /** @param {Node} node */
    contains: (node) => dialog.contains(node),
    remove: () => dialog.remove(),
  };
}
