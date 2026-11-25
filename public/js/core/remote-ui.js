// The phone's remote (design.md section 7, Phone page), fetched once the claim is a demo's, its stylesheet first.
// The file rows put an item on the screen and the row it shows is marked; a preview of what it shows
// steps by its halves or a swipe; the bubbles above Revoke step and present. Markup: a.html's #remote-parts.
/** @import {PhoneView} from "../../../src/shared/protocol.ts" */
/** @import {PhonePage} from "../types.js" */
import { createApi } from "./api.js";
import { pagesOf, thumbOf } from "./demo.js";
import { isVideo, itemName } from "./format.js";
import { refused, styled } from "./lazy.js";
import { canPresent, createRemote } from "./remote.js";
import { rowFace } from "./rows.js";
import { el, setText } from "./ui.js";

await styled("/css/remote.css");

const api = createApi();
const SWIPE = 50;

/**
 * @param {PhonePage} c
 * @param {(view: PhoneView) => void} onView the phone's view as `POST /api/control` answers it
 * @returns {(on: boolean) => void} shows the remote (a demo session in approved, opening or open) or takes it away
 */
export function mount(c, onView) {
  const parts = /** @type {HTMLTemplateElement} */ (document.getElementById("remote-parts")).content;
  const preview = /** @type {HTMLElement} */ (parts.querySelector(".preview"));
  const bubbles = /** @type {HTMLElement} */ (parts.querySelector(".bubbles"));
  const count = /** @type {HTMLElement} */ (preview.querySelector(".count"));
  const present = /** @type {HTMLButtonElement} */ (bubbles.querySelector("[data-present]"));
  const back = /** @type {HTMLButtonElement} */ (bubbles.querySelector("[data-step='-1']"));
  const ahead = /** @type {HTMLButtonElement} */ (bubbles.querySelector("[data-step='1']"));
  const list = /** @type {HTMLElement} */ (document.getElementById("file-list"));
  const ends = /** @type {HTMLElement} */ (document.getElementById("ends"));
  const panel = /** @type {HTMLElement} */ (document.querySelector(".column > .actions"));
  let on = false;
  let drawn = "";

  const remote = createRemote({
    view: () => c.view,
    post: (command) => api.post("/api/control", command, c.pid),
    adopt: onView,
    refused: refused("The Screen Didn't Change"),
    paint,
  });

  function paint() {
    const v = c.view;
    const at = remote.at();
    const item = at && v?.items.find((x) => x.id === at.item);
    if (!on || !v || !at || !item) {
      preview.remove();
      bubbles.remove();
      return;
    }
    if (!preview.isConnected) ends.after(preview);
    if (!bubbles.isConnected) panel.prepend(bubbles);
    for (const row of list.querySelectorAll("[data-id]")) {
      if (row.getAttribute("data-id") === at.item) row.setAttribute("aria-current", "true");
      else row.removeAttribute("aria-current");
    }
    const pages = pagesOf(item, v);
    const key = `${at.item}:${at.page}`;
    if (key !== drawn) {
      drawn = key;
      const name = itemName(item);
      const base = pages?.[at.page - 1];
      const label = pages
        ? `${item.kind === "file" && item.type === "pdf" ? "Page" : "Slide"} ${at.page} of ${pages.length}`
        : "";
      preview.setAttribute("aria-label", label ? `${name}, ${label}` : name);
      // Every page is fetched ahead, so a step swaps at once.
      for (const p of pages ?? []) new Image().src = `${p}.avif`;
      const face = base
        ? el("picture", {}, [
            el("source", { type: "image/avif", srcset: `${base}.avif` }),
            el("img", { src: `${base}.webp`, alt: "" }),
          ])
        : el("div", { class: "card" }, [
            ...rowFace(item, thumbOf(item, v)),
            // The screen plays a video under its own controls (design.md section 7, Phone page).
            ...(isVideo(item) ? [el("span", { class: "small" }, ["Play and pause it on the screen."])] : []),
          ]);
      preview.replaceChildren(face, count);
    }
    setText(count, pages ? `${at.page} / ${pages.length}` : "");
    count.hidden = !pages;
    back.disabled = !pages || at.page === 1;
    ahead.disabled = !pages || at.page === pages.length;
    present.disabled = !canPresent(item, v);
    setText(present, at.present ? "Stop" : "Present");
    present.classList.toggle("primary", at.present);
    present.classList.toggle("secondary", !at.present);
  }

  list.addEventListener("click", (e) => {
    const row = on && e.target instanceof Element && e.target.closest("[data-id]");
    if (row) remote.tap({ item: row.getAttribute("data-id") ?? "" });
  });
  bubbles.addEventListener("click", (e) => {
    const b = e.target instanceof Element && e.target.closest("button");
    if (!b || b.disabled) return;
    if (b === present) remote.tap({ present: true });
    else remote.tap({ step: Number(b.getAttribute("data-step")) });
  });
  // A tap on the preview's left or right half steps back or on; a swipe over SWIPE px steps, and is not also a tap.
  let x = Number.NaN;
  let swiped = false;
  preview.addEventListener("pointerdown", (e) => {
    x = e.clientX;
    swiped = false;
  });
  preview.addEventListener("pointerup", (e) => {
    const dx = e.clientX - x;
    swiped = Math.abs(dx) > SWIPE;
    if (swiped) remote.tap({ step: dx < 0 ? 1 : -1 });
  });
  preview.addEventListener("click", (e) => {
    if (swiped) return;
    const box = preview.getBoundingClientRect();
    remote.tap({ step: e.clientX < box.left + box.width / 2 ? -1 : 1 });
  });

  return (next) => {
    on = next;
    paint();
  };
}
