// The one loading part (docs/design.md section 6, Loader); the phone's upload rows reuse it.
import { el } from "./ui.js";

/**
 * @param {string} label what is loading, for screen readers
 * @param {string | null} thumb a same-origin thumbnail, or none (the glass on `--g1`)
 */
export function loader(label, thumb) {
  return el(
    "div",
    {
      class: "loader",
      role: "progressbar",
      "aria-label": `Loading ${label}`,
      "aria-valuemin": "0",
      "aria-valuemax": "100",
    },
    [
      ...(thumb ? [el("img", { class: "loader-thumb", src: thumb, alt: "" })] : []),
      el("span", { class: "glass" }),
      el("span", { class: "loader-fill" }),
    ],
  );
}

/**
 * The share received, 0 to 1; null while the length is unknown (indeterminate).
 * @param {HTMLElement} part
 * @param {number | null} fraction
 */
export function setProgress(part, fraction) {
  if (fraction === null) {
    part.removeAttribute("aria-valuenow");
    part.style.removeProperty("--progress");
    return;
  }
  const f = Math.min(1, Math.max(0, fraction));
  part.setAttribute("aria-valuenow", String(Math.round(f * 100)));
  part.style.setProperty("--progress", String(f));
}

/**
 * Reads a body to its end, reporting the share received; null when the length is unknown (an encoded body's length
 * counts other bytes than the reader sees).
 * @param {Response} res
 * @param {(fraction: number | null) => void} onProgress
 * @returns {Promise<Blob>}
 */
export async function readAll(res, onProgress) {
  const total = res.headers.get("Content-Encoding") ? 0 : Number(res.headers.get("Content-Length")) || 0;
  onProgress(total ? 0 : null);
  const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    if (total) onProgress(got / total);
  }
  return new Blob(/** @type {BlobPart[]} */ (chunks), { type: res.headers.get("Content-Type") ?? "" });
}
