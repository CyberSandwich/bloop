// The one loading part (docs/design.md section 6, Loader). The phone's upload rows move onto it with c-phone.
import { el } from "./ui.js";

/** @param {string} label @param {string | null} thumb a same-origin thumbnail, or none */
export function loader(label, thumb) {
  // aria-valuemin and aria-valuemax default to 0 and 100 on a progressbar.
  return el("div", { class: "loader", role: "progressbar", "aria-label": `Loading ${label}` }, [
    ...(thumb ? [el("img", { class: "loader-thumb", src: thumb, alt: "" })] : []),
    el("span", { class: "glass" }),
    el("span", { class: "loader-fill" }),
  ]);
}

/** @param {HTMLElement} part @param {number | null} fraction 0 to 1, or null while the length is unknown */
export function setProgress(part, fraction) {
  if (fraction === null) {
    part.removeAttribute("aria-valuenow");
    return part.style.removeProperty("--progress");
  }
  const f = Math.min(1, Math.max(0, fraction));
  part.setAttribute("aria-valuenow", String(Math.round(f * 100)));
  part.style.setProperty("--progress", String(f));
}

/**
 * Reads a body to its end, reporting the share received: null when the length is unknown, as for an encoded body,
 * whose length counts other bytes than the reader sees.
 * @param {Response} res @param {(fraction: number | null) => void} onProgress @returns {Promise<Blob>}
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
