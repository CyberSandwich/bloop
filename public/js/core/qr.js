// The QR as one SVG path (docs/design.md section 10): version 4, level M, 4 modules of quiet zone,
// so the code is always 41 modules across and never changes size between refreshes.
import { encode } from "../vendor/uqr.js";

export const QR_MODULES = 41;

/** @param {string} text @returns {boolean[][]} */
export function qrMatrix(text) {
  return encode(text, { ecc: "M", minVersion: 4, maxVersion: 4, border: 4 }).data;
}

/** Horizontal runs of dark modules as `M x y h n v1 h-n z`; the path fills in the panel's ink color. */
export function qrPath(/** @type {boolean[][]} */ matrix) {
  const parts = [];
  for (const [y, row] of matrix.entries()) {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x += 1;
      parts.push(`M${start} ${y}h${x - start}v1h-${x - start}z`);
    }
  }
  return parts.join("");
}

/**
 * CSS pixels for the whole code: whole device pixels per module, half the viewport height at most,
 * never below 2 device pixels per module.
 */
export function qrSize(/** @type {number} */ viewportHeight, /** @type {number} */ dpr) {
  const perModule = Math.max(2, Math.floor((0.5 * viewportHeight * dpr) / QR_MODULES));
  return (perModule * QR_MODULES) / dpr;
}
