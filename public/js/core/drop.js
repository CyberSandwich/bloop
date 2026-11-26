// The guest upload: what the phone checks and prepares before a byte goes, and an adapter over the upload engine
// (core/upload.js) on the guest routes, by the pairing credential (docs/uploads.md).
/** @import {ErrorCode} from "../../../src/shared/protocol.ts" */
/** @import {SendResult} from "../types.js" */
import { typeOfName } from "../shared/names.js";
import { createApi, isErrorCode } from "./api.js";

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

/** @typedef {{upload: () => Promise<Pick<typeof import("./upload.js"), "createUploader">>, view: (pid: string) => Promise<import("./api.js").Reply<any>>}} SendModules */
/** @type {SendModules} */
const SEND = {
  upload: () => import("./upload.js"),
  view: (pid) => createApi().get("/api/pair/state", pid),
};

/** @param {string | undefined} code @returns {ErrorCode} a code the phone can say; the engine's own are the service */
const sayable = (code) => (isErrorCode(code) ? code : "service_down");

/**
 * Sends one file through the upload engine on the guest routes (docs/uploads.md), which loads only now. `abort()`
 * stops it; the result then says `upload_aborted`. Once the file is ready, the answer is the phone's view.
 * @param {object} args
 * @param {{name: string, size: number, slice: (s: number, e: number) => Blob}} args.file a File
 * @param {string} args.pid
 * @param {(fraction: number) => void} args.onProgress 0 to 1
 * @param {SendModules} [args.load] the unit tests pass fakes
 * @returns {{done: Promise<SendResult>, abort: () => void}}
 */
export function sendFile({ file, pid, onProgress, load = SEND }) {
  let aborted = false;
  /** @type {(() => void) | null} */
  let stop = null;
  /** @type {Promise<SendResult>} */
  const done = new Promise((resolve) => {
    /** @param {SendResult} result */
    const end = (result) => {
      stop = null;
      resolve(result);
    };
    load.upload().then(
      ({ createUploader }) => {
        if (aborted) return end({ ok: false, error: "upload_aborted" });
        let settled = false;
        /** @type {number | undefined} */
        let id;
        const up = createUploader({
          pid,
          onChange: (batch) => {
            const f = batch.files.find((x) => x.id === id);
            if (!f || settled) return;
            if (f.state === "uploading") onProgress(f.fraction);
            const out = outcome(f);
            if (!out) return;
            settled = true;
            // Disposed after the snapshot is read: the engine calls back from inside its own run.
            queueMicrotask(() => up.dispose());
            if (out === "saved") {
              load.view(pid).then(
                (res) => end(res.ok ? { ok: true, view: res.value } : { ok: false, error: res.error }),
                () => end({ ok: false, error: "offline" }),
              );
            } else end({ ok: false, error: out });
          },
        });
        [id] = up.add([file]);
        stop = () => (id === undefined ? undefined : up.cancel(id));
      },
      // The engine could not load (the venue's Wi-Fi dropped): the same as no connection.
      () => end({ ok: false, error: "offline" }),
    );
  });
  return {
    done,
    abort: () => {
      aborted = true;
      stop?.();
    },
  };
}

/**
 * Where a file's run ended, or null while it runs.
 * @param {import("./upload.js").FileSnap} f
 * @returns {"saved" | ErrorCode | null}
 */
function outcome(f) {
  if (f.state === "saved") return "saved";
  if (f.state === "refused") return sayable(f.error);
  if (f.state === "canceled" || f.state === "paused") return "upload_aborted";
  return f.state === "unsettled" ? "service_down" : null;
}
