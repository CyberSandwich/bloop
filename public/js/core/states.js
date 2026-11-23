// State to view mapping: the server's view plus what only the client knows become one state key.
// Pure; the pages render the key through copy.js.
/** @import {FileEntry, PhoneStateKey, PhoneView, ScreenStateKey, ScreenView} from "../../../src/shared/protocol.ts" */

/** A deck shown as a PDF is the fallback; a file that is a PDF is just opened as one. */
const pdfKey = (/** @type {ScreenView | PhoneView} */ v) => (v.fileType === "pdf" ? "pdf_file" : "pdf_fallback");

/**
 * @typedef {object} ScreenCtx
 * @property {ScreenView | null} view
 * @property {"ok" | "offline" | "down"} link
 * @property {boolean} errored an action or a pushed error failed; clears after a pause
 */

/**
 * @param {ScreenCtx} c
 * @returns {ScreenStateKey}
 */
export function screenKey(c) {
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
      return "approved";
    case "opening":
    case "open":
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
 * @typedef {object} PhoneInfo what the claim or a resumed view says about the room
 * @property {string} roomName
 * @property {boolean} registered
 * @property {string} match
 * @property {"live" | "demo"} mode
 */

/**
 * @typedef {object} PhoneCtx
 * @property {PhoneStateKey | null} error a failure to show in place of the flow
 * @property {PhoneInfo | null} info null while the claim is in flight
 * @property {PhoneView | null} view the latest pushed or fetched view
 * @property {FileEntry[] | null} files null while loading
 * @property {string | null} selected a file id
 * @property {boolean} approving the approve call is in flight
 * @property {boolean} canceled this phone canceled the pairing
 * @property {"choose" | "confirm" | "sending" | null} drop where the guest flow is, which only this phone knows
 */

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
  if (c.selected === null) return "choose";
  if (c.info.mode === "demo") return "approve_demo";
  return c.info.registered ? "approve" : "unregistered";
}
