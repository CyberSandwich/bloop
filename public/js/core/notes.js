// The presenter's notes on the phone (design.md section 7, Phone page): one component, its box, its scrolling and its
// empty state, loaded by the remote (core/remote-ui.js) on the first Present of a paged item, with its stylesheet. The
// layout that places it is `mount`; a wider layout can place `createBox().box` itself. The text is only ever set as text.
/** @import {Shown} from "../../../src/shared/protocol.ts" */
/** @import {PhonePage} from "../types.js" */
/** @import {Api} from "./api.js" */
import { createApi } from "./api.js";
import { pagesOf } from "./demo.js";
import { ICONS } from "./icons.js";
import { styled } from "./lazy.js";
import { el, icon } from "./ui.js";

await styled("/css/notes.css");

/** A phone held upright: a wider window keeps the plain list and preview. Keep in step with notes.css. */
const NARROW = "(max-width: 639.98px)";

/** One page's note, "" when it has none: a note of only blanks is none. @param {string[]} notes @param {number} page 1-based */
export function noteFor(notes, page) {
  const note = notes[page - 1] ?? "";
  return note.trim() === "" ? "" : note;
}

/** Whether any page has a note: a file with none keeps the plain layout. @param {string[]} notes */
export const hasNotes = (notes) => notes.some((note) => note.trim() !== "");

/**
 * The item's notes, or null when there are none to be had: a failed call, or an answer that is not a list, is no notes.
 * @param {Pick<Api, "get">} api
 * @param {string | null} pid
 * @param {string} item the phone's own item id
 * @returns {Promise<string[] | null>}
 */
export async function loadNotes(api, pid, item) {
  const res = await api.get(`/api/notes?item=${encodeURIComponent(item)}`, pid);
  const notes = res.ok ? res.value?.notes : null;
  return Array.isArray(notes) ? notes.map((note) => (typeof note === "string" ? note : "")) : null;
}

/** The notes box: it scrolls inside itself and keeps its size whatever it holds; a page with no note shows a glass pill. */
export function createBox() {
  const text = el("p", { class: "notes-text" });
  const none = el("p", { class: "notes-none glass" }, ["No Notes for This Slide"]);
  const box = el("div", { class: "notes", role: "region", "aria-label": "Notes", tabindex: "0" }, [text, none]);
  let held = "";
  return {
    box,
    /** @param {string} note "" for none @param {string} slide names the slide: a different one starts at the top */
    show(note, slide) {
      text.textContent = note;
      text.hidden = note === "";
      none.hidden = note !== "";
      box.classList.toggle("notes-blank", note === "");
      if (slide !== held) box.scrollTop = 0;
      held = slide;
    },
  };
}

/**
 * Places the box under the preview, over the panel, and folds the list to the row on screen. Returns the function the
 * remote calls on every paint.
 * @param {PhonePage} c
 * @param {() => Shown | null | false} at the slide on screen; false while the remote is away
 * @param {HTMLElement} preview
 * @returns {() => void}
 */
export function mount(c, at, preview) {
  const api = createApi();
  const list = /** @type {HTMLElement} */ (document.getElementById("file-list"));
  const panel = /** @type {HTMLElement} */ (document.querySelector(".column > .actions"));
  const { box, show } = createBox();
  const narrow = matchMedia(NARROW);
  /** @type {Map<string, string[]>} */
  const held = new Map();
  /** Asked during this Present: a failed call is asked again at the next one, not at every paint. */
  const asked = new Set();
  let on = false;
  let folded = true;
  let item = "";

  function release() {
    on = false;
    folded = true;
    item = "";
    box.remove();
    list.classList.remove("notes-folded");
    for (const x of list.querySelectorAll(".notes-chevron, [aria-expanded]")) {
      if (x.classList.contains("notes-chevron")) x.remove();
      else x.removeAttribute("aria-expanded");
    }
  }

  function update() {
    const now = at() || null;
    const view = c.view;
    if (!now?.present) asked.clear();
    const it = now && now.present ? view?.items.find((x) => x.id === now.item) : undefined;
    const paged = !!it && !!view && narrow.matches && !!pagesOf(it, view);
    const notes = it && paged ? held.get(it.id) : undefined;
    if (it && paged && !notes && !asked.has(it.id)) {
      asked.add(it.id);
      loadNotes(api, c.pid, it.id).then((got) => {
        if (got) held.set(it.id, got);
        update();
      });
    }
    if (!now || !it || !notes || !hasNotes(notes)) return release();
    on = true;
    if (it.id !== item) {
      item = it.id;
      folded = true;
    }
    const row = list.querySelector("[aria-current]");
    const focused = list.contains(document.activeElement);
    list.classList.toggle("notes-folded", folded);
    for (const x of list.querySelectorAll(".notes-chevron")) if (!row?.contains(x)) x.remove();
    for (const x of list.querySelectorAll("[aria-expanded]")) x.removeAttribute("aria-expanded");
    if (row) {
      row.setAttribute("aria-expanded", String(!folded));
      if (!row.querySelector(".notes-chevron")) {
        const chevron = icon(ICONS["chevron-up"], true);
        chevron.classList.add("notes-chevron");
        row.append(chevron);
      }
      // A row hidden by the fold takes its focus with it.
      if (focused && !list.contains(document.activeElement)) /** @type {HTMLElement} */ (row).focus();
    }
    if (folded) {
      if (!box.isConnected || preview.nextElementSibling !== box) panel.before(preview, box);
      show(noteFor(notes, now.page), `${it.id}:${now.page}`);
    } else box.remove();
  }

  // The row on screen is the fold's handle: a tap opens or folds the list and is no command (not "page 1 again").
  list.addEventListener(
    "click",
    (e) => {
      if (!on || !(e.target instanceof Element) || !e.target.closest("[aria-current]")) return;
      e.stopPropagation();
      folded = !folded;
      update();
    },
    true,
  );
  addEventListener("resize", update);
  return update;
}
