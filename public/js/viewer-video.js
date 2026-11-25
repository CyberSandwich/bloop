// A guest video on the stage; every choice here is design.md section 7, Video.
/** @import {Shot, Tune} from "./viewer.js" */
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
  /**
   * Sound first; where the browser holds it (no tap on the page yet) muted, so it reports blocked, and refused even
   * muted (a policy that blocks all autoplay) paused, so it reports blocked and not playing. Only the screen's own
   * hand (user activation, the end) reports a change: a command's play() and pause() have no activation. With no
   * UserActivation API every event counts, as in screen.js; a command's own events repeat its state, reporting nothing.
   * @param {Tune} want @param {(next: Tune) => void} retune
   */
  shot.tune = (want, retune) => {
    video.onplay =
      video.onpause =
      video.onvolumechange =
        () =>
          (video.ended || (navigator.userActivation?.isActive ?? true)) &&
          retune({ play: !video.paused, sound: !video.muted ? "on" : want.sound === "on" ? "off" : want.sound });
    video.muted = want.sound !== "on";
    if (!want.play) return video.pause();
    // An interrupted play() (a pause, the end) is no refusal.
    video
      .play()
      .catch(
        (e) =>
          e.name === "NotAllowedError" &&
          retune(video.muted ? { play: false, sound: "blocked" } : { ...want, sound: "blocked" }),
      );
  };
  // Emptied, it stops reading and frees the decoder.
  shot.stop = () => {
    live = false;
    clearTimeout(late);
    video.removeAttribute("src");
    video.load();
  };
}
