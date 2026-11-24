// The guest upload: PUT /api/drop with the raw file (docs/architecture.md section 4.4). XMLHttpRequest, not
// fetch, because only XHR reports upload progress in every phone browser.
/** @import {ErrorCode} from "../../../src/shared/protocol.ts" */
/** @import {SendResult, Xhr} from "../types.js" */
import { ERRORS } from "../shared/errors.js";

const MB = 1024 * 1024;
const EXTENSION = /\.(pptx|pdf|jpe?g|png|mp4|mov)$/i;
const PHOTO = /\.(jpe?g|png)$/i;
const VIDEO = /\.(mp4|mov)$/i;
const HEIC = /\.(heic|heif)$/i;

/** @param {number} bytes @returns {number} whole megabytes, rounded down, at least 1 */
export const wholeMB = (bytes) => Math.max(1, Math.floor(bytes / MB));

/**
 * What the phone can tell before sending a byte: the extension, and the size (a photo's is checked once it is
 * compressed). The server checks both again, and the bytes themselves (DROP-02).
 * @param {{name: string, size: number}} file
 * @param {number} maxBytes
 * @returns {"heic" | "type" | "empty" | "large" | null} why not, or null
 */
export function fileProblem(file, maxBytes) {
  if (HEIC.test(file.name)) return "heic";
  if (!EXTENSION.test(file.name)) return "type";
  if (file.size === 0) return "empty";
  return file.size > maxBytes && !PHOTO.test(file.name) ? "large" : null;
}

/**
 * The file to send: a photo compressed without its metadata, a video with its location blanked. The media modules
 * load only now, so a page that sends a deck never fetches them.
 * @param {File} file
 * @param {number} maxBytes
 * @returns {Promise<{ok: true, file: File} | {ok: false, problem: "photo" | "video"}>}
 */
export async function prepareFile(file, maxBytes) {
  if (PHOTO.test(file.name)) {
    const out = await (await import("./photo.js")).preparePhoto(file, maxBytes);
    return out ? { ok: true, file: out } : { ok: false, problem: "photo" };
  }
  if (!VIDEO.test(file.name)) return { ok: true, file };
  const out = await (await import("./video.js")).stripLocation(file);
  return out.ok ? out : { ok: false, problem: "video" };
}

/** @param {unknown} code @returns {code is ErrorCode} */
const isErrorCode = (code) => typeof code === "string" && Object.hasOwn(ERRORS, code);

/** @returns {Xhr} */
const browserXhr = () => new /** @type {any} */ (globalThis).XMLHttpRequest();

/**
 * Starts the upload. `abort()` stops it; the result then says `upload_aborted`.
 * @param {object} args
 * @param {{name: string, size: number}} args.file a File
 * @param {string} args.pid
 * @param {(fraction: number) => void} args.onProgress 0 to 1
 * @param {() => Xhr} [args.xhr]
 * @returns {{done: Promise<SendResult>, abort: () => void}}
 */
export function sendFile({ file, pid, onProgress, xhr: make = browserXhr }) {
  const req = make();
  /** @type {Promise<SendResult>} */
  const done = new Promise((resolve) => {
    req.open("PUT", "/api/drop");
    req.setRequestHeader("Authorization", `Bearer ${pid}`);
    req.setRequestHeader("Content-Type", "application/octet-stream");
    req.setRequestHeader("X-Bloop-Name", encodeURIComponent(file.name));
    req.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    req.onerror = () => resolve({ ok: false, error: "offline" });
    req.onabort = () => resolve({ ok: false, error: "upload_aborted" });
    req.onload = () => {
      let body = null;
      try {
        body = JSON.parse(req.responseText);
      } catch {
        // an empty or non-JSON answer is handled below
      }
      if (req.status >= 200 && req.status < 300 && body) return resolve({ ok: true, view: body });
      if (isErrorCode(body?.code)) return resolve({ ok: false, error: body.code });
      resolve({ ok: false, error: req.status >= 500 || body === null ? "service_down" : "bad_request" });
    };
    req.send(file);
  });
  return { done, abort: () => req.abort() };
}
