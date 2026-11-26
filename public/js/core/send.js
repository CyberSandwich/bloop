// A guest's one file on its way from /a: prepared, then PUT /api/drop with the raw bytes (docs/architecture.md section
// 4.4); phone.js draws its row. XMLHttpRequest, not fetch, because only XHR reports upload progress in every phone
// browser. Lazy: phone.js fetches it when the offer shows, so it is in before Send.
/** @import {ErrorCode} from "../../../src/shared/protocol.ts" */
/** @import {SendCtx, SendIo, SendResult, Xhr} from "../types.js" */
import { ERRORS } from "../shared/errors.js";
import { HEIC, kindOf } from "./drop.js";

/** @typedef {{photo: () => Promise<typeof import("./photo.js")>, video: () => Promise<typeof import("./video.js")>}} MediaModules */
/** @type {MediaModules} */
const MEDIA = { photo: () => import("./photo.js"), video: () => import("./video.js") };

/**
 * The file to send: a photo compressed without its metadata, a video with its location blanked. The media modules
 * load only now, so a page that sends a deck never fetches them. Never rejects: a module that fails to load (the
 * venue's Wi-Fi dropped) is a refusal like any other.
 * @param {File} file
 * @param {number} maxBytes
 * @param {MediaModules} [load] the unit tests pass failing ones
 * @returns {Promise<{ok: true, file: File} | {ok: false, problem: "photo" | "heic" | "video" | "large"}>}
 */
export async function prepareFile(file, maxBytes, load = MEDIA) {
  const kind = kindOf(file.name);
  if (kind !== "photo" && kind !== "video") return { ok: true, file };
  try {
    if (kind === "video") {
      const out = await (await load.video()).stripLocation(file);
      return out.ok ? out : { ok: false, problem: "video" };
    }
    const out = await (await load.photo()).preparePhoto(file, maxBytes);
    if (out.ok) return out;
    if (out.reason === "large") return { ok: false, problem: "large" };
    return { ok: false, problem: out.reason === "decode" && HEIC.test(file.name) ? "heic" : "photo" };
  } catch {
    return { ok: false, problem: kind };
  }
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
      const ours = req.getResponseHeader("X-Bloop") === "1";
      if (req.status >= 200 && req.status < 300 && body && ours) return resolve({ ok: true, view: body });
      // A 200 that is not bloop's (no marker) is a filter's page: the network, not bloop (REL-03).
      if (req.status >= 200 && req.status < 300) return resolve({ ok: false, error: "network_blocked" });
      if (isErrorCode(body?.code)) return resolve({ ok: false, error: body.code });
      resolve({ ok: false, error: req.status >= 500 || body === null ? "service_down" : "bad_request" });
    };
    req.send(file);
  });
  return { done, abort: () => req.abort() };
}

/**
 * Sends the offered file: prepared first (a photo compressed, a video's location blanked), then the bytes.
 * @param {SendCtx} c
 * @param {SendIo} io
 */
export async function send(c, io) {
  const file = c.file;
  if (!file || c.drop === "sending") return;
  let stopped = false;
  /** @type {{abort: () => void} | null} */
  let up = null;
  c.drop = "sending";
  c.progress = kindOf(file.name) === "file" ? 0 : null;
  c.upload = {
    abort: () => {
      stopped = true;
      up?.abort();
    },
  };
  io.render();
  const ready = await prepareFile(file, c.maxBytes);
  if (stopped) return;
  if (!ready.ok) {
    // The file cannot be made safe to send, so its offer goes too, with or without a list under it.
    c.upload = null;
    c.drop = "confirm";
    io.leaveOffer();
    return io.refuse(ready.problem, file);
  }
  c.progress = 0;
  io.render();
  const sending = sendFile({
    file: ready.file,
    pid: /** @type {string} */ (c.pid),
    onProgress: (fraction) => {
      c.progress = fraction;
      io.render();
    },
  });
  up = sending;
  const res = await sending.done;
  c.upload = null;
  if (stopped) return;
  c.drop = null;
  if (res.ok) io.setView(res.view);
  else io.fail(res.error, io.retry);
  io.sent();
}
