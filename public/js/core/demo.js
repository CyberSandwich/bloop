// Pure parts of the demo screen's viewer (viewer.js) and the demo phone's rows. No DOM, so the unit tests run them in Node.
/** @import {Item, Mode} from "../../../src/shared/protocol.ts" */

const PROTOCOL_PREFIX = "ms-powerpoint:ofv|u|";

// The demo account's item names are owned by src/shared/demo-catalog.ts (kept out of the pages' first load); this
// module owns the deck's page count and the id slug.
/** The deck's pre-rendered page count: public/img/demo-slide-1..N (tools/render-slides.py). */
export const DECK_PAGES = 5;
export const demoId = (/** @type {string} */ name) => `demo-${name.split(".")[0]?.toLowerCase()}`;

/** The demo deck's pages, one AVIF and one WebP each (tools/render-slides.py). */
export const SLIDES = Array.from({ length: DECK_PAGES }, (_, i) => `/img/demo-slide-${i + 1}`);

/** The https link inside a pushed link (protocol or plain), when it is on this origin; null otherwise. */
export function openTarget(/** @type {string} */ link, /** @type {string} */ origin) {
  try {
    const url = new URL(link.startsWith(PROTOCOL_PREFIX) ? link.slice(PROTOCOL_PREFIX.length) : link);
    return url.origin === origin ? url.href : null;
  } catch {
    return null;
  }
}

/** A link's name ends in its type (mintLink). */
export const isVideoLink = (/** @type {string} */ url) => /\.(mp4|mov)$/.test(new URL(url).pathname);

/** How a document shows: portrait pages (taller than wide) scroll as one column; slides page one at a time. */
export const pageMode = (/** @type {number} */ width, /** @type {number} */ height) =>
  height > width ? "scroll" : "paged";

/**
 * Where the controls go: the item fills the stage and they never shrink it, so they take the first free spot.
 * "under": the pill under the item, the slack holding it and an inset (item and pill centered as one block). "right":
 * the column at the stage's bottom right, the slack beside the centered item holding it. "rail": the column under the
 * side list, where it has room. Else "float": the pill over the item's foot.
 * @param {{w: number, h: number}} item @param {{w: number, h: number}} stage
 * @param {{pill: number, stackW: number, stackH: number, inset: number, rail: boolean}} need
 * @returns {"under" | "right" | "rail" | "float"}
 */
export function placeControls(item, stage, need) {
  if (stage.h - item.h >= need.pill + need.inset) return "under";
  if ((stage.w - item.w) / 2 >= need.stackW + need.inset && need.stackH <= stage.h) return "right";
  return need.rail ? "rail" : "float";
}

/** The page after a step, held at either end. */
export const stepPage = (/** @type {number} */ at, /** @type {number} */ by, /** @type {number} */ count) =>
  Math.min(count - 1, Math.max(0, at + by));

/** A remote command's seq (PAIR-13): the clock, always above the sender's last. */
export const nextSeq = (/** @type {number} */ last, now = Date.now()) => Math.max(now, last + 1);

/** The tap zones: the slide box's halves. @param {{left: number, top: number, width: number, height: number}} box */
export const halves = (box) => [
  { ...box, width: box.width / 2 },
  { ...box, left: box.left + box.width / 2, width: box.width / 2 },
];

/**
 * The pre-rendered pages of a demo account's deck; null for anything else (a guest's own file has none).
 * @param {Item} item
 * @param {{mode: Mode, kind: string | null}} view
 */
export const pagesOf = (item, view) =>
  view.mode === "demo" && view.kind === "owner" && item.kind === "file" && item.type === "pptx" ? SLIDES : null;

/**
 * A row's thumbnail: a link's same-origin preview; in a demo account page 1 of the deck, the photo's own thumbnail;
 * null shows the type tile.
 * @param {Item} item
 * @param {{mode: Mode, kind: string | null}} view
 */
export function thumbOf(item, view) {
  if (item.kind === "link") return item.preview ?? null;
  if (pagesOf(item, view)) return `${SLIDES[0]}.webp`;
  return view.mode === "demo" && view.kind === "owner" && item.kind === "file" && item.type === "jpg"
    ? `/img/${demoId(item.name)}-thumb.webp`
    : null;
}
