// A guest video on the stage (design.md section 7, Video), loaded with the first video link: its own size entry.
/** @import {Shot} from "./viewer.js" */
import { el } from "./core/ui.js";

/**
 * Plays a view link in a <video>, which reads it in ranges (VID-02) under the page's `media-src 'self'`. Native
 * controls without their download, full screen and casting: Present is the one way to fill the window. It never
 * autoplays: Play is the presenter's click, so the room hears it with sound.
 * @param {Shot} shot filled in here: its node, its ratio at the metadata, ready at the first playable frame
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
  const on = (/** @type {string} */ type, /** @type {() => void} */ then) =>
    video.addEventListener(
      type,
      () => {
        if (!live) return;
        then();
        onChange(shot);
      },
      { once: true },
    );
  on("loadedmetadata", () => {
    shot.ratio = video.videoWidth / video.videoHeight || null;
  });
  on("canplay", () => {
    shot.ready = true;
  });
  // Before the first frame or mid-play (a decoder fault, a read refused), the card takes the stage.
  on("error", () => {
    shot.ready = false;
    shot.failed = true;
  });
  shot.node = video;
  // An emptied element stops reading and lets the decoder go.
  shot.stop = () => {
    live = false;
    video.removeAttribute("src");
    video.load();
  };
}
