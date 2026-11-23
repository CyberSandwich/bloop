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

/** The page after a step, held at either end. */
export const stepPage = (/** @type {number} */ at, /** @type {number} */ by, /** @type {number} */ count) =>
  Math.min(count - 1, Math.max(0, at + by));

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
