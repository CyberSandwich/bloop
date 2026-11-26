// The guest's send: what the phone checks and prepares before a byte moves, and the adapter to the upload engine.
/** @import {ErrorCode, PhoneView} from "../../../src/shared/protocol.ts" */
/** @import {SendResult} from "../types.js" */
import { typeOfName } from "../shared/names.js";
import { toast } from "./toast.js";

const MB = 1024 * 1024;
const SENT_MS = 2000;
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

/**
 * Starts the guest's upload through the engine and its pill (core/upload-pill.js), which load now: a page that sends
 * nothing never fetches them. `abort()` stops it; the result then says `upload_aborted`. If they cannot load nothing
 * was sent: a toast says so and the result is `offline`, so Try Again sends again.
 * @param {object} args
 * @param {File} args.file
 * @param {string} args.pid
 * @param {(fraction: number) => void} args.onProgress 0 to 1, never more than 0.99 before the server answers
 * @returns {{done: Promise<SendResult>, abort: () => void}}
 */
export function sendFile({ file, pid, onProgress }) {
  let stopped = false;
  let stop = () => {
    stopped = true;
  };
  /** @type {Promise<SendResult>} */
  const done = new Promise((resolve) => {
    /** @type {{dispose: () => void} | null} */
    let mounted = null;
    let settled = false;
    /** @param {SendResult} result @param {number} lingerMs how long the pill stays: "Sent" is read before it goes */
    const settle = (result, lingerMs) => {
      if (settled) return;
      settled = true;
      resolve(result);
      setTimeout(() => mounted?.dispose(), lingerMs);
    };
    import("./upload-pill.js")
      .then(({ mountUploads }) =>
        mountUploads({
          kind: "guest",
          pid,
          onChange: ({ files: [mine] }) => {
            if (!mine) return;
            if (mine.state === "sent") settle({ ok: true, view: /** @type {PhoneView} */ (mine.view) }, SENT_MS);
            else if (mine.state === "refused") settle({ ok: false, error: /** @type {ErrorCode} */ (mine.error) }, 0);
            else if (mine.state === "canceled") settle({ ok: false, error: "upload_aborted" }, 0);
            else onProgress(mine.fraction);
          },
        }),
      )
      .then(
        (up) => {
          mounted = up;
          if (stopped) return settle({ ok: false, error: "upload_aborted" }, 0);
          const [id] = up.add([file]);
          stop = () => up.cancel(/** @type {number} */ (id));
        },
        () => {
          toast({
            title: "Upload Didn't Load",
            body: "Reload the page, then try again.",
            error: true,
            action: { label: "Reload", run: () => /** @type {any} */ (globalThis).location.reload() },
          });
          resolve({ ok: false, error: "offline" });
        },
      );
  });
  return { done, abort: () => stop() };
}
