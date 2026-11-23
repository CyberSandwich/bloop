// The guest upload: PUT /api/drop with the raw file (docs/architecture.md section 4.4). XMLHttpRequest, not
// fetch, because only XHR reports upload progress in every phone browser.
/** @import {ErrorCode} from "../../../src/shared/protocol.ts" */
/** @import {SendResult, Xhr} from "../types.js" */
import { ERRORS } from "../shared/errors.js";

const MB = 1024 * 1024;
const EXTENSION = /\.(pptx|pdf)$/i;

/** @param {number} bytes @returns {number} whole megabytes, rounded down, at least 1 */
export const wholeMB = (bytes) => Math.max(1, Math.floor(bytes / MB));

/**
 * What the phone can tell before sending a byte: the extension and the size. The server checks both again,
 * and the bytes themselves (DROP-02).
 * @param {{name: string, size: number}} file
 * @param {number} maxBytes
 * @returns {boolean}
 */
export const sendable = (file, maxBytes) => EXTENSION.test(file.name) && file.size > 0 && file.size <= maxBytes;

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
