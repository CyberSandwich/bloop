// State to view mapping: the server's view plus what only the client knows become one state key.
// Pure; the pages render the key through copy.js.
/** @import {FileItem, Item, PhoneStateKey, PhoneView, ScreenStateKey, ScreenView} from "../../../src/shared/protocol.ts" */
/** @import {PhoneCtx, ScreenCtx} from "../types.js" */

/**
 * The first file of a view's items, or null: the one an approval launches.
 * @param {Item[]} items
 * @returns {FileItem | null}
 */
export const firstFile = (items) => /** @type {FileItem | undefined} */ (items.find((i) => i.kind === "file")) ?? null;

/** A deck shown as a PDF is the fallback; a file that is a PDF is just opened as one. */
const pdfKey = (/** @type {ScreenView | PhoneView} */ v) =>
  firstFile(v.items)?.type === "pdf" ? "pdf_file" : "pdf_fallback";

/**
 * @param {ScreenCtx} c
 * @returns {ScreenStateKey}
 */
export function screenKey(c) {
  if (c.limited) return "rate_limited";
  if (c.link === "offline") return "offline";
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
      // A demo launches nothing: the page shows the file itself, so a reload or a lost frame lands here too.
      if (v.mode === "demo") return "demo_open";
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

/**
 * @param {PhoneCtx} c
 * @returns {PhoneStateKey}
 */
export function phoneKey(c) {
  if (c.error) return c.error;
  if (!c.info) return "checking";
  if (c.canceled) return "canceled";
  const v = c.view;
  if (v) {
    if (v.state === "ended") return v.endReason === "canceled" ? "canceled" : "ended";
    if (v.state === "waiting" || v.state === "closed") return "expired";
    if (v.state === "approved" || v.state === "opening") return "opening";
    if (v.state === "open") {
      // A demo screen shows the file itself; its Download is an extra, never a fallback.
      if (v.mode === "demo") return "open";
      if (v.openMode === "download") return "open_fallback";
      if (v.openMode === "pdf") return pdfKey(v);
      return "open";
    }
    // The server's word wins over this phone's: a reload or a second push can arrive in any of these.
    if (v.state === "offered") return "guest_sent";
    if (v.state === "uploading") return "guest_sending";
    if (v.kind === "guest" && !c.drop) return "guest_choose";
  }
  if (c.drop) return `guest_${c.drop}`;
  if (!c.files) return "match";
  if (c.files.length === 0) return "empty";
  if (c.approving) return "approving";
  if (c.selected.length === 0) return "choose";
  if (c.info.mode === "demo") return "approve_demo";
  return c.info.registered ? "approve" : "unregistered";
}
