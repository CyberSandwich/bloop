// State to view mapping: the server's view plus what only the client knows become one state key.
// Pure; the pages render the key through their copy (core/copy.js). The phone's own half: core/phone-states.js.
/** @import {FileItem, Item, PhoneView, ScreenStateKey, ScreenView} from "../../../src/shared/protocol.ts" */
/** @import {ScreenCtx} from "../types.js" */

/**
 * The first file of a view's items, or null: the one an approval launches.
 * @param {Item[]} items
 * @returns {FileItem | null}
 */
export const firstFile = (items) => /** @type {FileItem | undefined} */ (items.find((i) => i.kind === "file")) ?? null;

/** A photo or a video: a file with no pages. @param {Item | null} item */
export const onStage = (item) => item?.kind === "file" && item.type !== "pptx" && item.type !== "pdf";

/** In the page, live too (design.md section 7, The viewer). @param {ScreenView | null} v */
export const guestOnStage = (v) => v?.kind === "guest" && onStage(firstFile(v.items));

/** A deck shown as a PDF is the fallback; a file that is a PDF is just opened as one. */
export const pdfKey = (/** @type {ScreenView | PhoneView} */ v) =>
  firstFile(v.items)?.type === "pdf" ? "pdf_file" : "pdf_fallback";

/**
 * Whether a PDF view can exist: a PDF is its own, and a source converts a deck. A guest's deck and any photo or video
 * have none (the route answers `pdf_unavailable`).
 * @param {ScreenView | null} v
 */
export function hasPdf(v) {
  const type = firstFile(v?.items ?? [])?.type;
  return type === "pdf" || (type === "pptx" && v?.kind !== "guest");
}

/**
 * @param {ScreenCtx} c
 * @returns {ScreenStateKey}
 */
export function screenKey(c) {
  if (c.limited) return "rate_limited";
  if (c.link === "offline") return "offline";
  if (c.link === "blocked") return "network_blocked";
  if (c.link === "down") return "service_down";
  if (c.errored) return "error";
  const v = c.view;
  if (!v) return "offline";
  switch (v.state) {
    case "claimed":
      return "scanned";
    case "choosing":
    case "uploading":
      return "choosing";
    case "offered":
      return "guest_open";
    case "approved":
    case "opening":
    case "open":
      // The page shows the file itself, so a reload or a lost frame lands here too.
      if (v.mode === "demo" || guestOnStage(v)) return "demo_open";
      if (v.state === "approved") return "approved";
      if (v.openMode === "download") return "open_fallback";
      if (v.openMode === "pdf") return pdfKey(v);
      return v.state === "opening" ? "opening" : "open";
    case "ended":
      return "ended";
    case "closed":
      return "service_down";
    default:
      return "waiting";
  }
}
