// Pure parts of the demo screen's viewer (viewer.js) and the demo phone's rows. No DOM, so the unit tests run them in Node.
/** @import {Item, Mode} from "../../../src/shared/protocol.ts" */

const PROTOCOL_PREFIX = "ms-powerpoint:ofv|u|";

/** The sample deck's pages, one AVIF and one WebP each (tools/render-slides.py). The PDF is its export: same pages. */
export const SLIDES = ["/img/demo-slide-1", "/img/demo-slide-2"];
/** The catalog photo's 120 px square thumbnail, so its row has a picture before any link is minted. */
export const PHOTO_THUMB = "/img/demo-dog-thumb.webp";

/** The https link inside a pushed link (protocol or plain), when it is on this origin; null otherwise. */
export function openTarget(/** @type {string} */ link, /** @type {string} */ origin) {
  try {
    const url = new URL(link.startsWith(PROTOCOL_PREFIX) ? link.slice(PROTOCOL_PREFIX.length) : link);
    return url.origin === origin ? url.href : null;
  } catch {
    return null;
  }
}

/** How a document shows: portrait pages (taller than wide) scroll as one column; slides page one at a time. */
export const pageMode = (/** @type {number} */ width, /** @type {number} */ height) =>
  height > width ? "scroll" : "paged";

/**
 * Where the control pill goes for an item (width over height `ratio`) contained in a `w` x `h` stage, the one that
 * shows the item widest: "right" (a column `reserve` wide beside it, which must be no taller than the item, `stack`),
 * "below" (a pill `gap` tall under it) or "list" (a column under the side list: only where `listFits`, and the item
 * then takes the whole stage). Within 1 px the item's own controls win: right, then below, then list.
 * @returns {"right" | "below" | "list"}
 */
export function placeControls(
  /** @type {number} */ ratio,
  /** @type {number} */ w,
  /** @type {number} */ h,
  /** @type {{reserve: number, gap: number, stack: number, listFits: boolean}} */ at,
) {
  const widest = (/** @type {number} */ boxW, /** @type {number} */ boxH) => Math.max(0, Math.min(boxW, boxH * ratio));
  const right = widest(w - at.reserve, h);
  const sizes = {
    right: right / ratio >= at.stack ? right : Number.NEGATIVE_INFINITY,
    below: widest(w, h - at.gap),
    list: at.listFits ? widest(w, h) : Number.NEGATIVE_INFINITY,
  };
  const best = Math.max(sizes.right, sizes.below, sizes.list);
  return /** @type {const} */ (["right", "below", "list"]).find((k) => sizes[k] >= best - 1) ?? "below";
}

/** The page after a step, held at either end. */
export const stepPage = (/** @type {number} */ at, /** @type {number} */ by, /** @type {number} */ count) =>
  Math.min(count - 1, Math.max(0, at + by));

/** The tap zones: the slide box's halves. @param {{left: number, top: number, width: number, height: number}} box */
export const halves = (box) => [
  { ...box, width: box.width / 2 },
  { ...box, left: box.left + box.width / 2, width: box.width / 2 },
];

/**
 * The pre-rendered pages of a demo account's deck or PDF; null for anything else (a guest's own file has none).
 * @param {Item} item
 * @param {{mode: Mode, kind: string | null}} view
 */
export const pagesOf = (item, view) =>
  view.mode === "demo" && view.kind === "owner" && item.kind === "file" && (item.type === "pptx" || item.type === "pdf")
    ? SLIDES
    : null;

/**
 * A demo account's row thumbnail: page 1 of the deck or PDF, the photo's own thumbnail; null shows the type tile.
 * @param {Item} item
 * @param {{mode: Mode, kind: string | null}} view
 */
export function thumbOf(item, view) {
  if (pagesOf(item, view)) return `${SLIDES[0]}.webp`;
  return view.mode === "demo" && view.kind === "owner" && item.kind === "file" && item.type === "jpg"
    ? PHOTO_THUMB
    : null;
}
