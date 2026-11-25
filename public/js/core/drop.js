// The guest upload: PUT /api/drop with the raw file (docs/architecture.md section 4.4). XMLHttpRequest, not
// fetch, because only XHR reports upload progress in every phone browser.
/** @import {ErrorCode} from "../../../src/shared/protocol.ts" */
/** @import {SendResult, Xhr} from "../types.js" */
import { ERRORS } from "../shared/errors.js";
import { typeOfName } from "../shared/names.js";

const MB = 1024 * 1024;
/** Not a type bloop stores: a HEIC is sent only as the JPEG this browser can make of it (design.md, Upload). */
export const HEIC = /\.(heic|heif)$/i;

/** @param {number} bytes @returns {number} whole megabytes, rounded down, at least 1 */
export const wholeMB = (bytes) => Math.max(1, Math.floor(bytes / MB));

/**
 * What the phone does with a file before sending it, by its name; null for a type bloop refuses.
 * @param {string} name
 * @returns {"photo" | "video" | "file" | null}
 */
export function kindOf(name) {
  if (HEIC.test(name)) return "photo";
  const type = typeOfName(name);
  if (type === "jpg" || type === "png") return "photo";
  if (type === "mp4" || type === "mov") return "video";
  return type && "file";
}

/**
 * What the phone can tell before sending a byte: the extension, and the size (a photo's is checked once it is
 * compressed). The server checks both again, and the bytes themselves (DROP-02).
 * @param {{name: string, size: number}} file
 * @param {number} maxBytes
 * @returns {"type" | "empty" | "large" | null} why not, or null
 */
export function fileProblem(file, maxBytes) {
  const kind = kindOf(file.name);
  if (!kind) return "type";
  if (file.size === 0) return "empty";
  return file.size > maxBytes && kind !== "photo" ? "large" : null;
}

/**
 * The file to send: a photo compressed without its metadata, a video with its location blanked. The media modules
 * load only now, so a page that sends a deck never fetches them.
 * @param {File} file
 * @param {number} maxBytes
 * @returns {Promise<{ok: true, file: File} | {ok: false, problem: "photo" | "heic" | "video"}>}
 */
export async function prepareFile(file, maxBytes) {
  const kind = kindOf(file.name);
  if (kind === "photo") {
    const out = await (await import("./photo.js")).preparePhoto(file, maxBytes);
    return out ? { ok: true, file: out } : { ok: false, problem: HEIC.test(file.name) ? "heic" : "photo" };
  }
  if (kind !== "video") return { ok: true, file };
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
