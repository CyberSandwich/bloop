// The library page's rules, without the DOM: what a row shows, who may be ticked, and how Up Next changes.
// The server decides; these only shape the optimistic step and the words (docs/ux/library.md sections 2 and 4).
import {
  DISABLED_REASON,
  dateText,
  fontsNote,
  kindOf,
  preparingText,
  reasonOf,
  sizeText,
  T,
} from "../core/copy-library.js";
import { splitName } from "../core/format.js";

/**
 * @typedef {{id: string, name: string, ext: string, bytes: number, status: string, refusal?: string, updatedAt: number,
 *   lastPresentedAt?: number, selected: boolean, trashedAt?: number, purgeAfter?: number, disabled: boolean,
 *   derived: {state: string, done?: number, total?: number, pages?: number, fontsMissing?: string[]}, thumb?: string,
 *   upload?: string}} Row
 * `upload` is set on a row the page made from an open upload: its upload id.
 * @typedef {{uploadId: string, fileId: string, name: string, bytes: number, createdAt: number}} OpenUpload
 * @typedef {"on" | "readonly" | "off"} Switch
 * @typedef {{view: string, sort: string, files: Row[], next: string | null, uploads: OpenUpload[], upNext: string[],
 *   quota: {used: number, reserved: number, limit: number}, trash: {count: number, bytes: number},
 *   limits: {upNext: number, trashDays: number, maxFileBytes: number},
 *   switches: {uploads: Switch, previews: Switch, export: Switch}, account: {state: string}}} List
 */

/**
 * A name as the head that may take the ellipsis and the tail that never does: splitName's, or for a name too short
 * for it to split, the extension, so a narrow row still says the file's kind (library.md section 2).
 * @param {string} name @returns {[string, string]}
 */
export function nameParts(name) {
  const [head, tail] = splitName(name);
  const dot = name.lastIndexOf(".");
  return tail || dot < 1 ? [head, tail] : [name.slice(0, dot), name.slice(dot)];
}

/** A row still on its way: an open upload, or a settled file the server is still checking. @param {Row} row */
export const pending = (row) => row.upload !== undefined || row.status === "checking";

/** The tick exists only on a ready, enabled file the converter did not refuse (library.md section 2). @param {Row} row */
export const canTick = (row) =>
  !pending(row) && row.status === "ready" && !row.disabled && row.derived.state !== "failed";

/** Refused files never reach the list (upload.md section 4); a stale answer may still name one. @param {Row} row */
export const listed = (row) => row.status !== "refused";

/**
 * The rows All Files shows: open uploads first (the newest on top), then the files in the server's order. An upload
 * whose file row already exists is that row.
 * @param {List} list
 * @returns {Row[]}
 */
export function allRows(list) {
  const have = new Set(list.files.map((f) => f.id));
  const uploads = [...list.uploads]
    .filter((u) => !have.has(u.fileId))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((u) => ({
      id: u.fileId,
      name: u.name,
      ext: u.name.includes(".") ? (u.name.split(".").pop() ?? "") : "",
      bytes: u.bytes,
      status: "checking",
      updatedAt: u.createdAt,
      selected: false,
      disabled: false,
      derived: { state: "none" },
      upload: u.uploadId,
    }));
  return [...uploads, ...list.files.filter(listed)];
}

/** Up Next's rows in Up Next order; an id the page has no row for is left out. @param {List} list */
export function upNextRows(list) {
  const byId = new Map(list.files.map((f) => [f.id, f]));
  return list.upNext.flatMap((id) => {
    const row = byId.get(id);
    return row && !row.trashedAt ? [row] : [];
  });
}

/**
 * A tick's result: the order it leaves, or `full` when it would be one past the limit (the tick stays off).
 * @param {string[]} order @param {string} id @param {boolean} on @param {number} max
 * @returns {{order: string[], full: boolean}}
 */
export function tick(order, id, on, max) {
  if (!on) return { order: order.filter((x) => x !== id), full: false };
  if (order.includes(id)) return { order, full: false };
  if (order.length >= max) return { order, full: true };
  return { order: [...order, id], full: false };
}

/** The order with `id` moved by `delta` places, held inside the ends. @param {string[]} order @param {string} id @param {number} delta */
export function move(order, id, delta) {
  const from = order.indexOf(id);
  if (from < 0) return order;
  const to = Math.min(order.length - 1, Math.max(0, from + delta));
  if (to === from) return order;
  const out = order.filter((x) => x !== id);
  out.splice(to, 0, id);
  return out;
}

/** The list with every copy of `row` replaced, the selection mirrored into Up Next. @param {List} list @param {Row} row */
export function withRow(list, row) {
  const files = list.files.map((f) => (f.id === row.id ? { ...f, ...row } : f));
  const inOrder = list.upNext.includes(row.id);
  const upNext =
    row.selected && !inOrder
      ? [...list.upNext, row.id]
      : !row.selected && inOrder
        ? list.upNext.filter((x) => x !== row.id)
        : list.upNext;
  return { ...list, files, upNext };
}

/** The list without the row (moved to the trash). @param {List} list @param {string} id */
export const withoutRow = (list, id) => ({
  ...list,
  files: list.files.filter((f) => f.id !== id),
  upNext: list.upNext.filter((x) => x !== id),
});

/** The list with Up Next set to `order`, each file's tick following it. @param {List} list @param {string[]} order */
export const withOrder = (list, order) => ({
  ...list,
  upNext: order,
  files: list.files.map((f) => (f.selected === order.includes(f.id) ? f : { ...f, selected: order.includes(f.id) })),
});

/**
 * What line 2 says after the kind and size: a chip ("Preparing Slides" amber, "Can't Show Slides" or "Unavailable"
 * rose) with its reason, or the fonts note, or nothing.
 * @param {Row} row
 * @returns {{tone: "amber" | "rose" | null, chip: string, reason: string, fonts: string}}
 */
export function status(row) {
  const none = { tone: null, chip: "", reason: "", fonts: "" };
  if (row.disabled) return { ...none, tone: "rose", chip: T.unavailable, reason: DISABLED_REASON };
  if (row.derived.state === "failed") return { ...none, tone: "rose", chip: T.cantShow, reason: reasonOf(row.refusal) };
  if (row.derived.state === "preparing")
    return { ...none, tone: "amber", chip: preparingText(row.derived.done, row.derived.total) };
  const missing = row.derived.fontsMissing?.length ?? 0;
  return missing ? { ...none, fonts: fontsNote(missing) } : none;
}

/**
 * Line 2's words before any chip: "PowerPoint · 18 MB · Edited today". A refused or disabled file says its reason
 * instead of the date, so the line stays one sentence.
 * @param {Row} row @param {number} now @param {string} [timeZone]
 */
export function rowLine(row, now, timeZone) {
  const s = status(row);
  if (s.reason) return "";
  const parts = [kindOf(row.ext).word, sizeText(row.bytes)];
  if (!pending(row)) parts.push(dateText(row, now, timeZone));
  return parts.join(" · ");
}

/** The answer a page paints from: a stored copy that does not parse as a list is no copy. @param {string | null} text @returns {List | null} */
export function cached(text) {
  if (!text) return null;
  try {
    const list = JSON.parse(text);
    return Array.isArray(list?.files) && Array.isArray(list?.upNext) && list?.quota ? list : null;
  } catch {
    return null;
  }
}
