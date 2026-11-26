// The trash view (library.md section 6), in place of the list: each file's countdown, Restore and Delete Now in its
// menu, Empty Trash by the title. Deleting asks first in a sheet, since nothing undoes it.
/** @import {List, Row} from "./model.js" */
import { deletesIn, emptyTrashLine, quotaLine, T, trashEmptyLine, trashRule, trashUses } from "../core/copy-library.js";
import { el, focusTitle, setText, show } from "../core/ui.js";
import { nameParts } from "./model.js";

/** @param {any} page the page object library.js passes */
export function start(page) {
  const { els } = page;
  const view = /** @type {HTMLElement} */ (els.trashView);
  /** @type {List | null} */
  let trash = null;

  /** @param {string} title @param {string} line @param {string} action @returns {Promise<boolean>} */
  async function confirm(title, line, action) {
    // Cancel keeps focus (autofocus, no title stop): a delete is never one Enter from the dialog opening.
    const dialog = await page.sheet(
      "confirm-q",
      [
        el("h2", { id: "confirm-q" }, [title]),
        el("p", {}, [line]),
        el("form", { class: "buttons", method: "dialog" }, [
          el("button", { class: "btn secondary", type: "submit", value: "", autofocus: "" }, ["Cancel"]),
          el("button", { class: "btn rose", type: "submit", value: "yes" }, [action]),
        ]),
      ],
      /** @type {HTMLElement | null} */ (document.activeElement),
    );
    return new Promise((done) => dialog.addEventListener("close", () => done(dialog.returnValue === "yes")));
  }

  /** @param {Row} row */
  function rowItem(row) {
    const [head, tail] = nameParts(row.name);
    const left = deletesIn(row.purgeAfter ?? Date.now(), Date.now());
    const more = el(
      "button",
      { class: "lib-more", type: "button", "aria-haspopup": "dialog", "aria-label": `${T.moreFor}${row.name}` },
      [page.glyph("ellipsis")],
    );
    more.addEventListener("click", () => void menu(row, more));
    return el("li", { class: "lib-item", "data-trash": row.id }, [
      el("span", { class: "row" }, [
        page.tile({ ...row, thumb: undefined }),
        el("span", { class: "row-text" }, [
          el("span", { class: "row-name" }, [
            el("span", { class: "head" }, [head]),
            el("span", { class: "tail" }, [tail]),
          ]),
          el("span", { class: `small${left.soon ? " lib-danger" : ""}` }, [left.text]),
        ]),
      ]),
      more,
    ]);
  }

  /** Restore and Delete Now for one file. @param {Row} row @param {HTMLElement} opener */
  async function menu(row, opener) {
    const restore = el("button", { type: "button" }, [page.glyph("rotate-ccw"), "Restore"]);
    const remove = el("button", { type: "button", class: "lib-danger" }, [page.glyph("trash-2"), "Delete Now"]);
    const [head, tail] = nameParts(row.name);
    const dialog = await page.sheet(
      "trash-menu",
      [
        el("div", { class: "lib-sheet-head" }, [
          el("h2", { id: "trash-menu", tabindex: "-1", class: "row-name" }, [
            el("span", { class: "head" }, [head]),
            el("span", { class: "tail" }, [tail]),
          ]),
          page.closer(),
        ]),
        el("div", { class: "lib-menu" }, [restore, remove]),
      ],
      opener,
    );
    restore.addEventListener("click", async () => {
      dialog.close();
      if (!page.guard()) return;
      const answer = await page.send("POST", `${page.path(row.id)}/restore`, {});
      if (!answer.ok) return page.refuse(answer);
      page.say({ title: T.restored, body: "" });
      await refresh();
    });
    remove.addEventListener("click", async () => {
      dialog.close();
      if (await confirm(`Delete ${row.name}?`, "This can't be undone.", "Delete")) await purge({ ids: [row.id] });
    });
  }

  /** @param {{ids: string[]} | {all: true}} body */
  async function purge(body) {
    if (!page.guard()) return;
    const answer = await page.send("POST", "/api/library/trash/delete", body);
    if (!answer.ok) return page.refuse(answer);
    await refresh();
  }

  async function refresh() {
    const answer = await page.net.call("GET", "/api/library?view=trash");
    if (!answer.ok) return page.refuse(answer);
    trash = /** @type {List} */ (answer.value);
    paint();
    void page.load(true);
  }

  function paint() {
    if (!trash) return;
    const days = trash.limits.trashDays;
    const rows = trash.files;
    setText(
      els.quota,
      trash.trash.bytes > 0 ? trashUses(trash.trash.bytes, trash.quota.limit) : quotaLine(trash.quota),
    );
    show(els.emptyTrash, rows.length > 0);
    const list = el("ul", { class: "list lib-list" }, rows.map(rowItem));
    view.replaceChildren(
      ...(rows.length
        ? [el("p", { class: "lib-first" }, [trashRule(days)]), list]
        : [el("div", { class: "lib-empty" }, [el("h2", {}, [T.trashEmpty]), el("p", {}, [trashEmptyLine(days)])])]),
    );
  }

  async function emptyAll() {
    const n = trash?.files.length ?? 0;
    if (n && (await confirm("Empty the Trash?", emptyTrashLine(n), "Empty Trash"))) await purge({ all: true });
  }

  function close() {
    page.view = "files";
    setText(els.title, T.title);
    show(els.back, false);
    show(els.emptyTrash, false);
    show(view, false);
    view.replaceChildren();
    page.render();
    focusTitle(els.title);
  }

  els.back.addEventListener("click", close);
  els.emptyTrash.addEventListener("click", () => void emptyAll());

  async function open() {
    page.view = "trash";
    setText(els.title, T.trashTitle);
    show(els.back, true);
    show(view, true);
    view.replaceChildren();
    focusTitle(els.title);
    await refresh();
  }

  return { open };
}
