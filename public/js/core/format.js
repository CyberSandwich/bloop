// Pure formatting shared by the pages.
/** @import {Item} from "../../../src/shared/protocol.ts" */
import { normalize } from "../shared/codes.js";
import { ICONS } from "./icons.js";

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
  `QR code, scan with your phone, or enter the code ${spelled(code)} at ${host} slash code`;

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

/** The type tile's glyph by kind: slides, a document, a picture, a link. */
const TYPE_ICONS = {
  pptx: ICONS.presentation,
  pdf: ICONS["file-text"],
  image: ICONS.image,
  link: ICONS.link,
};

/** The type tile's glyph: slides, a document for a PDF, a picture for an image, a link. @param {Item} item */
export function itemIcon(item) {
  if (item.kind === "link") return TYPE_ICONS.link;
  return item.type === "pptx" || item.type === "pdf" ? TYPE_ICONS[item.type] : TYPE_ICONS.image;
}
