// Pure formatting shared by the pages.
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
