// The sort sheet (library.md section 2): Newest First, Name, Size, remembered on this device.
import { el } from "../core/ui.js";

const CHOICES = /** @type {const} */ ([
  ["updated", "Newest First"],
  ["name", "Name"],
  ["size", "Size"],
]);

/** @param {any} page the page object library.js passes */
export function start(page) {
  /** @param {HTMLElement | null} opener */
  async function open(opener) {
    /** @type {HTMLDialogElement | null} */
    let dialog = null;
    const choices = CHOICES.map(([key, label]) => {
      const button = el(
        "button",
        { type: "button", role: "menuitemradio", "aria-checked": String(page.sort === key) },
        [page.glyph("check"), label],
      );
      button.addEventListener("click", () => {
        dialog?.close();
        if (page.sort === key) return;
        page.sort = "updated";
        void page.load();
      });
      return button;
    });
    dialog = await page.sheet(
      "sort-title",
      [
        el("div", { class: "lib-sheet-head" }, [
          el("h2", { id: "sort-title", tabindex: "-1" }, ["Sort"]),
          page.closer(),
        ]),
        el("div", { class: "lib-menu", role: "menu", "aria-labelledby": "sort-title" }, choices),
      ],
      opener,
    );
  }
  return { open };
}
