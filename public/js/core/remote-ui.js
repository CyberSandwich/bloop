// The phone's remote (design.md section 7, Phone page), its stylesheet first: file rows that put an item on the screen,
// a preview that steps by its halves or a swipe, and bubbles that step and present. Markup: a.html's #remote-parts.
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
    post: (command) => api.post("/api/control", command, c.pid, true),
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
      const label = pages
        ? `${item.kind === "file" && item.type === "pdf" ? "Page" : "Slide"} ${at.page} of ${pages.length}`
        : "";
      preview.setAttribute("aria-label", label ? `${name}, ${label}` : name);
      // Built ahead as the pictures shown, so the browser fetches the format it will choose.
      const faces = pages?.map((p) =>
        el("picture", {}, [
          el("source", { type: "image/avif", srcset: `${p}.avif` }),
          el("img", { src: `${p}.webp`, alt: "" }),
        ]),
      );
      const face =
        faces?.[at.page - 1] ??
        el("div", { class: "card" }, [
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
  // A tap on the preview's left or right half steps back or on; a swipe over SWIPE px steps; a drag is no tap.
  let x = 0;
  let y = 0;
  preview.addEventListener("pointerdown", (e) => {
    [x, y] = [e.clientX, e.clientY];
  });
  preview.addEventListener("pointerup", (e) => {
    const dx = e.clientX - x;
    if (Math.abs(dx) > SWIPE) remote.tap({ step: dx < 0 ? 1 : -1 });
  });
  preview.addEventListener("click", (e) => {
    if (Math.hypot(e.clientX - x, e.clientY - y) > 10) return;
    const box = preview.getBoundingClientRect();
    remote.tap({ step: e.clientX < box.left + box.width / 2 ? -1 : 1 });
  });

  return (next) => {
    on = next;
    paint();
  };
}
