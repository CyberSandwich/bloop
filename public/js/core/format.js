// Pure formatting shared by the pages.
/** @import {Item} from "../../../src/shared/protocol.ts" */
import { normalize } from "../shared/codes.js";

/**
 * Local wall-clock time as "11:35".
 * @param {number} ms
 * @param {string} [locale]
 * @param {string} [timeZone]
 */
export function clock(ms, locale = "en-GB", timeZone) {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone ? { timeZone } : {}),
  }).format(ms);
}

/**
 * What a person typed, as it should read in the field: upper case, two groups ("K7M Q9X").
 * @param {string} raw
 */
export function typedCode(raw) {
  const s = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 7);
  return s.length > 3 ? `${s.slice(0, 3)} ${s.slice(3)}` : s;
}

/** The pairing code in a QR link's query string (`?c=K7MQ9X`), or null. @param {string} search */
export const codeFromSearch = (search) => new URLSearchParams(search).get("c");

/** The code the server accepts for what was typed, or null. @param {string} raw */
export const typedValid = (raw) => normalize(raw);

/**
 * The "10 min ago" part of "Edited 10 min ago": digits and tight units.
 * @param {number} now
 * @param {number} then
 */
export function ago(now, then) {
  const min = Math.max(0, Math.floor((now - then) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/**
 * Splits a long file name so CSS can ellipsize the head and keep the tail (the end and extension).
 * @param {string} name
 * @returns {[string, string]}
 */
export function splitName(name) {
  const keep = 10;
  return name.length > keep + 6 ? [name.slice(0, -keep), name.slice(-keep)] : [name, ""];
}

/** A file size as "79 KB" or "2.5 MB" (1024 steps, as the drop cap counts). @param {number} bytes */
export function sizeLabel(bytes) {
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

/** Spoken form for the QR label: "K 7 M, Q 9 X". @param {string} code */
export function spelled(code) {
  const chars = [...code];
  return `${chars.slice(0, 3).join(" ")}, ${chars.slice(3).join(" ")}`;
}

/**
 * The label design.md section 10 requires on the QR image.
 * @param {string} code
 * @param {string} host
 */
export const qrLabel = (code, host) =>
  `QR code. Scan it with your phone camera to open bloop. Or enter the code ${spelled(code)} at ${host} slash code.`;

/** "1:05" or "59:12": minutes and seconds left, never negative. @param {number} ms */
export function countdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The host a link card and a row name ("vevox.com"); "" for a URL that does not parse. @param {string} url */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const KINDS = { pptx: "PowerPoint", pdf: "PDF", jpg: "JPEG image", png: "PNG image", webp: "WebP image" };

/**
 * A row's second line: the kind, then the size when the item has bytes, then the date only when the source gave one.
 * A link reads "Link" and its host.
 * @param {Item} item
 * @param {string | null} [date] "Edited 10 min ago"
 */
export function itemLine(item, date = null) {
  const parts =
    item.kind === "link"
      ? ["Link", hostOf(item.url)]
      : [KINDS[item.type], item.size === null ? "" : sizeLabel(item.size), date ?? ""];
  return parts.filter(Boolean).join(" · ");
}

/** A row's name: a link's title, a file's name. @param {Item} item */
export const itemName = (item) => (item.kind === "link" ? item.title : item.name);

/** Iconic icon paths (free set, 24 viewBox, stroke 1.5): projector, file-text, photo, link, plus. */
const ICONS = {
  pptx: [
    "M18.25 7.75H5.75v7.5c0 1.1.9 2 2 2h8.5a2 2 0 0 0 2-2v-7.5Z",
    "M18.25 4.75H5.75a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1h12.5a1 1 0 0 0 1-1v-1a1 1 0 0 0-1-1Z",
    "M12 17.5v1.75",
  ],
  pdf: [
    "M7.75 19.25h8.5a2 2 0 0 0 2-2V9L14 4.75H7.75a2 2 0 0 0-2 2v10.5c0 1.1.9 2 2 2Z",
    "M18 9.25h-4.25V5",
    "M9.75 15.25h4.5",
    "M9.75 12.25h4.5",
  ],
  image: [
    "m4.75 16 2.75-3.49a2 2 0 0 1 3.09-.07L13 15.25m-2.09-2.43 2.59-3.32a2 2 0 0 1 3.09-.06L19 12.25M6.75 19.25h10.5a2 2 0 0 0 2-2V6.75a2 2 0 0 0-2-2H6.75a2 2 0 0 0-2 2v10.5c0 1.1.9 2 2 2Z",
  ],
  link: [
    "M16.75 13.25 18 12a4.24 4.24 0 0 0-6-6l-1.25 1.25",
    "M7.25 10.75 6 12a4.24 4.24 0 0 0 6 6l1.25-1.25",
    "m14.25 9.75-4.5 4.5",
  ],
};
export const ICON_ADD = ["M12 5.75v12.5", "M18.25 12H5.75"];

/** The type tile's glyph: slides, a document for a PDF, a picture for an image, a link. @param {Item} item */
export function itemIcon(item) {
  if (item.kind === "link") return ICONS.link;
  return item.type === "pptx" || item.type === "pdf" ? ICONS[item.type] : ICONS.image;
}
