// The phone's remote (design.md section 7, Phone page), its stylesheet first. Markup: a.html's #remote-parts.
/** @import {PhoneView} from "../../../src/shared/protocol.ts" */
/** @import {PhonePage} from "../types.js" */

import { tuneOf } from "../shared/session.js";
import { createApi } from "./api.js";
import { pagesOf } from "./demo.js";
import { isVideo, itemName } from "./format.js";
import { refused, styled } from "./lazy.js";
import { canPresent, createRemote } from "./remote.js";
import { el, setText } from "./ui.js";

await styled("/css/remote.css");

const api = createApi();
const SWIPE = 50;

/**
 * @param {PhonePage} c
 * @param {(view: PhoneView) => void} onView
 * @returns {(on: boolean) => void} shows or takes away the remote
 */
export function mount(c, onView) {
  const parts = /** @type {HTMLTemplateElement} */ (document.getElementById("remote-parts")).content;
  const preview = /** @type {HTMLElement} */ (parts.querySelector(".preview"));
  const note = /** @type {HTMLElement} */ (parts.querySelector("[data-note]"));
  const bubbles = /** @type {HTMLElement} */ (parts.querySelector(".bubbles"));
  const count = /** @type {HTMLElement} */ (preview.querySelector(".count"));
  const present = /** @type {HTMLButtonElement} */ (bubbles.querySelector("[data-present]"));
  const back = /** @type {HTMLButtonElement} */ (bubbles.querySelector("[data-step='-1']"));
  const ahead = /** @type {HTMLButtonElement} */ (bubbles.querySelector("[data-step='1']"));
  const play = /** @type {HTMLButtonElement} */ (bubbles.querySelector("[data-play]"));
  const sound = /** @type {HTMLButtonElement} */ (bubbles.querySelector("[data-sound]"));
  const list = /** @type {HTMLElement} */ (document.getElementById("file-list"));
  const panel = /** @type {HTMLElement} */ (document.querySelector(".column > .actions"));
  const column = /** @type {HTMLElement} */ (list.parentElement);
  let on = false;
  let drawn = "";
  /** A paged item: the one the preview shows. */
  let paged = false;

  // The preview sits over the panel only where the list above it keeps two rows (remote.css holds the list at two):
  // where the column would then overflow, it gives way, and Previous and Next still step.
  const place = () => {
    if (paged && !preview.isConnected) panel.before(preview);
    if (!paged || column.scrollHeight > column.clientHeight) preview.remove();
  };
  addEventListener("resize", place);

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
      paged = false;
      place();
      note.remove();
      bubbles.remove();
      return;
    }
    if (!bubbles.isConnected) panel.prepend(bubbles);
    for (const row of list.querySelectorAll("[data-id]")) {
      if (row.getAttribute("data-id") === at.item) row.setAttribute("aria-current", "true");
      else row.removeAttribute("aria-current");
    }
    const pages = pagesOf(item, v);
    const video = isVideo(item);
    // Only a paged item has a preview: a photo, video or link row already shows what the screen does.
    const key = `${at.item}:${at.page}`;
    if (pages && key !== drawn) {
      drawn = key;
      const kind = item.kind === "file" && item.type === "pdf" ? "Page" : "Slide";
      preview.setAttribute("aria-label", `${itemName(item)}, ${kind} ${at.page} of ${pages.length}`);
      // A picture, so the browser fetches the format it picks.
      const p = pages[at.page - 1];
      const pic = el("picture", { "data-item": at.item }, [
        el("source", { type: "image/avif", srcset: `${p}.avif` }),
        el("img", { src: `${p}.webp`, alt: "" }),
      ]);
      // Another item cross-fades over the last (core/crossfade.js); not loaded, the page swaps at once.
      const tally = `${at.page} / ${pages.length}`;
      import("./crossfade.js").then(
        (m) => m.swap(preview, pic, count, tally, () => drawn === key),
        () => {
          preview.replaceChildren(pic, count);
          setText(count, tally);
        },
      );
    }
    paged = !!pages;
    // The screen holds sound until a tap there: the phone says so under the list.
    if (video && at.sound === "blocked") {
      if (!note.isConnected) list.after(note);
    } else note.remove();
    // After the note: it changes the column's height, which decides whether the preview fits.
    place();
    // A video's bubbles play and sound, not step.
    for (const [b, on] of /** @type {const} */ ([
      [play, tuneOf(at).play],
      [sound, tuneOf(at).sound === "on"],
    ])) {
      b.hidden = !video;
      b.setAttribute("aria-pressed", String(on));
      b.children[0]?.toggleAttribute("hidden", !on);
      b.children[1]?.toggleAttribute("hidden", on);
    }
    back.hidden = ahead.hidden = video;
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
    else if (b === play) remote.tap({ play: true });
    else if (b === sound) remote.tap({ sound: true });
    else remote.tap({ step: Number(b.getAttribute("data-step")) });
  });
  // A tap on a half steps that way, as does a swipe; a drag is no tap.
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
