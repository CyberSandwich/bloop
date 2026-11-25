// State to view mapping: the server's view plus what only the client knows become one state key.
// Pure; the pages render the key through copy.js.
/** @import {ErrorCode, FileItem, Item, PhoneStateKey, PhoneView, ScreenStateKey, ScreenView} from "../../../src/shared/protocol.ts" */
/** @import {PhoneCtx, ScreenCtx} from "../types.js" */
import { IN_SESSION, LIVE_CLAIM, PAIRING_OVER } from "../shared/session.js";
import { refusal } from "./channel.js";

/** @type {PhoneStateKey[]} */
export const RESULTS = ["ended", "canceled"];

/**
 * The pid first: a view that is over drops the pid it was read with. An owner whose first byte made it a guest
 * loses its OneDrive list: a guest's list is only its Add a File row.
 * @param {{pid: string | null, view: PhoneView | null, skew: number, info: PhoneCtx["info"], files: PhoneCtx["files"], selected: string[]}} c
 * @param {PhoneView} view
 * @param {(pid: string | null) => void} drop
 */
export function adopt(c, view, drop, pid = c.pid) {
  c.pid = pid;
  c.view = view;
  c.skew = view.now - Date.now();
  if (view.kind === "guest" && c.info && c.info.kind !== "guest") {
    c.info = { ...c.info, kind: "guest" };
    c.files = [];
    c.selected = [];
  }
  if (PAIRING_OVER.includes(view.state)) drop(pid);
}

/**
 * A pushed refusal: after a result it only ends the pairing; before one it shows, unless this phone canceled.
 * @param {PhoneCtx & {canceling: boolean}} c
 * @param {ErrorCode} code
 * @param {{drop: () => void, stop: () => void, fail: (code: ErrorCode) => void}} act
 */
export function onRefusal(c, code, act) {
  const over = RESULTS.includes(phoneKey(c));
  if (over || refusal(code) === "dead") act.drop();
  if (over) act.stop();
  else if (!c.canceling) act.fail(code);
}

/** A claim this phone holds, not yet approved. */
export const liveClaim = (/** @type {LeaveCtx} */ c) =>
  !!c.pid && !c.canceled && (!c.view || LIVE_CLAIM.includes(c.view.state));

/**
 * Back and Done (design.md, frame): a live session keeps its pid, so Revoke can come back.
 * @typedef {{pid: string | null, canceled: boolean, view: PhoneView | null, leaving: boolean}} LeaveCtx
 * @param {LeaveCtx} c
 * @param {{post: (path: string, body: unknown, auth: string | null) => Promise<{ok: boolean}>, drop: (pid: string | null) => void, assign: (to: string) => void}} io
 */
export async function leave(c, io, /** @type {string} */ to, forget = false) {
  if (c.leaving) return;
  c.leaving = true;
  // A refused cancel (the approve landed first) leaves a session that still needs this pid.
  const canceled = liveClaim(c) && (await io.post("/api/cancel", {}, c.pid)).ok;
  if (canceled || forget) io.drop(c.pid);
  io.assign(to);
}

/**
 * Try Again: what to rerun. Once the session is up, nothing: the call may have landed.
 * @param {{error: unknown, retry: (() => void) | null, view: PhoneView | null}} c
 */
export function retryStep(c) {
  const run = c.retry;
  c.error = null;
  c.retry = null;
  return c.view && IN_SESSION.includes(c.view.state) ? null : run;
}

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
  const v = c.view;
  // A result is final: a refusal pushed after it (the pairing is gone by then) never replaces it.
  if (c.canceled || (v?.state === "ended" && v.endReason === "canceled")) return "canceled";
  if (v?.state === "ended") return "ended";
  // A repeat that lost the race (a guest's re-sent file, another set approved) reads as taken; this pairing's own
  // session view, once pushed, wins.
  if (c.error && !(c.error === "taken" && v && IN_SESSION.includes(v.state))) return c.error;
  if (!c.info) return "checking";
  if (v) {
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
  }
  if (c.drop) return `guest_${c.drop}`;
  if ((v?.kind ?? c.info.kind) === "guest") return "guest_add";
  if (!c.files) return "match";
  if (c.files.length === 0) return "empty";
  if (c.approving) return "approving";
  if (c.selected.length === 0) return "choose";
  if (c.info.mode === "demo") return "approve_demo";
  return c.info.registered ? "approve" : "unregistered";
}
