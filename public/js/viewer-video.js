// A guest video on the stage; every choice here is design.md section 7, Video.
/** @import {Shot} from "./viewer.js" */
import { el } from "./core/ui.js";

export const METADATA_MS = 15_000;

/**
 * Ready at the metadata, not canplay: iOS may buffer nothing before Play.
 * @param {Shot} shot
 * @param {string} url
 * @param {(shot: Shot) => void} onChange never after stop
 */
export function roll(shot, url, onChange) {
  const video = el("video", {
    src: url,
    controls: "",
    playsinline: "",
    preload: "auto",
    controlslist: "nodownload nofullscreen noremoteplayback noplaybackrate",
    disablepictureinpicture: "",
    disableremoteplayback: "",
  });
  let live = true;
  const fail = () => {
    shot.ready = false;
    shot.failed = true;
  };
  const late = setTimeout(() => {
    if (!live) return;
    fail();
    onChange(shot);
  }, METADATA_MS);
  const on = (/** @type {string} */ type, /** @type {() => void} */ then) =>
    video.addEventListener(
      type,
      () => {
        if (!live) return;
        clearTimeout(late);
        then();
        onChange(shot);
      },
      { once: true },
    );
  on("loadedmetadata", () => {
    // No picture: audio alone, or a codec this engine cannot draw.
    if (!video.videoWidth || !video.videoHeight) return fail();
    shot.ratio = video.videoWidth / video.videoHeight;
    shot.ready = true;
  });
  on("error", fail);
  shot.node = video;
  // Emptied, it stops reading and frees the decoder.
  shot.stop = () => {
    live = false;
    clearTimeout(late);
    video.removeAttribute("src");
    video.load();
  };
}
