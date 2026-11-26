// The row menu (library.md section 4): Move Up and Down on an Up Next row, Rename, Download, Move to Trash; an upload's
// row holds only Cancel Upload and a disabled file only Move to Trash. From 640 it sits by its More button.
/** @import {Row} from "./model.js" */
import { el } from "../core/ui.js";
import { allRows } from "./model.js";

/** @param {any} page the page object library.js passes */
export function start(page) {
  /** @param {string} glyphName @param {string} label @param {() => void} run @param {string} [cls] */
  const item = (glyphName, label, run, cls = "") => {
    const button = el("button", { type: "button", ...(cls ? { class: cls } : {}) }, [page.glyph(glyphName), label]);
    button.addEventListener("click", run);
    return button;
  };

  /** @param {string} id @returns {Row | null} */
  const find = (id) => {
    const list = page.list();
    return list ? (allRows(list).find((/** @type {Row} */ r) => r.id === id) ?? null) : null;
  };

  /** The file's name as the sheet's title, two lines at most like a row's. @param {string} name */
  const title = (name) => el("h2", { id: "menu-title", tabindex: "-1", class: "row-name" }, [name]);

  /** @param {string} id @param {HTMLElement | null} opener @param {"menu" | "rename"} [mode] */
  async function open(id, opener, mode = "menu") {
    const row = find(id);
    if (!row) return;
    const body = el("div", { class: "lib-menu" });
    const dialog = await page.sheet(
      "menu-title",
      [el("div", { class: "lib-sheet-head" }, [title(row.name), page.closer()]), body],
      opener,
    );
    const close = () => dialog.close();

    /** The rows for the file as it is now; a move redraws them in place. */
    const fill = () => {
      const now = find(id);
      if (!now) return close();
      const order = page.list()?.upNext ?? [];
      const at = order.indexOf(id);
      /** @type {HTMLElement[]} */
      const rows = [];
      if (now.upload !== undefined) {
        rows.push(
          item(
            "x",
            "Cancel Upload",
            async () => {
              close();
              const answer = await page.send("DELETE", `/api/uploads/${encodeURIComponent(now.upload ?? "")}`, {});
              if (!answer.ok) page.refuse(answer);
              void page.load(true);
            },
            "lib-danger",
          ),
        );
        return body.replaceChildren(...rows);
      }
      if (at >= 0 && !now.disabled) {
        if (at > 0) rows.push(item("arrow-up", "Move Up", () => void moveAndKeep(-1)));
        if (at < order.length - 1) rows.push(item("arrow-down", "Move Down", () => void moveAndKeep(1)));
      }
      if (!now.disabled) {
        rows.push(item("pencil", "Rename", () => renaming()));
        rows.push(
          item("download", "Download", () => {
            close();
            void page.download(id);
          }),
        );
      }
      rows.push(
        item(
          "trash-2",
          "Move to Trash",
          () => {
            close();
            void page.trashFile(id);
          },
          "lib-danger",
        ),
      );
      body.replaceChildren(...rows);
    };

    /** Moves the row and keeps the menu open, focus on the same action (or the first, at an end). @param {number} delta */
    const moveAndKeep = async (delta) => {
      const label = delta < 0 ? "Move Up" : "Move Down";
      const moving = page.moveBy(id, delta);
      fill();
      const buttons = [...body.querySelectorAll("button")];
      (buttons.find((b) => b.textContent === label) ?? buttons[0])?.focus();
      await moving;
    };

    /** The menu becomes the name field, the base selected without its extension (library.md section 4). */
    const renaming = () => {
      const now = find(id);
      if (!now) return close();
      const base = now.ext && now.name.endsWith(`.${now.ext}`) ? now.name.slice(0, -now.ext.length - 1) : now.name;
      const field = /** @type {HTMLInputElement} */ (
        el("input", { class: "field", type: "text", maxlength: "200", "aria-label": "Name", autocomplete: "off" })
      );
      field.value = base;
      const save = /** @type {HTMLButtonElement} */ (el("button", { class: "btn primary", type: "submit" }, ["Save"]));
      const form = el("form", { class: "lib-form" }, [field, save]);
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        // The one file-name rule cleans what was typed (doubled spaces, stray joiners), so the server never refuses it.
        const { cleanName, NAME_MAX } = await import("../shared/file-name.js");
        const name = cleanName(field.value, NAME_MAX - now.name.length + base.length);
        if (!name) return page.say({ title: "That Name Can't Be Used", body: "", error: true });
        close();
        if (name !== base) await page.rename(id, name);
      });
      body.replaceWith(form);
      field.focus();
      field.select();
    };

    if (mode === "rename") renaming();
    else fill();
    // Measured once filled and at its anchored width: the empty sheet is shorter than the menu it will hold.
    anchor(dialog, opener);
  }

  /** From 640 the menu opens beside its More button, inside the window. @param {HTMLDialogElement} dialog @param {HTMLElement | null} opener */
  function anchor(dialog, opener) {
    if (!opener || !matchMedia("(min-width: 640px)").matches) return;
    const at = opener.getBoundingClientRect();
    dialog.classList.add("is-anchored");
    const height = dialog.getBoundingClientRect().height;
    dialog.style.setProperty("--top", `${Math.max(12, Math.min(at.bottom + 4, innerHeight - height - 12))}px`);
    dialog.style.setProperty("--left", `${Math.max(12, Math.min(at.right - 320, innerWidth - 332))}px`);
  }

  return { open };
}
