// What a refusal the phone can name before sending says, as a toast (design.md section 7, Phone page). Lazy: a refusal
// is a rare path, so its words stay off /a's first load; phone.js falls back to the generic toast if this fails.
import { FILE_TYPES } from "./copy-phone.js";

/**
 * A video cap as recording time, at about 1 MB a second: an iPhone's default 1080p at 30 fps (HEVC) is about 60 MB a
 * minute (design.md, Toast). Under 2 minutes it says seconds, rounded down to 10 once there are 10; a no-break space
 * keeps the number on its unit's line.
 * @param {number} maxMB
 */
export function videoTime(maxMB) {
  if (maxMB >= 120) return `${Math.floor(maxMB / 60)}\u00a0minutes`;
  const s = maxMB < 10 ? maxMB : Math.floor(maxMB / 10) * 10;
  return `${s}\u00a0second${s === 1 ? "" : "s"}`;
}

/** @typedef {"heic" | "type" | "empty" | "large" | "several" | "photo" | "video"} Problem */

/**
 * The cap is the server's (`dropMaxBytes`).
 * @param {Problem} problem
 * @param {{demo: boolean, maxMB: number, video?: boolean}} f `video`: the file too large is a video
 * @returns {{title: string, body: string, error: true}}
 */
export function refusalToast(problem, f) {
  const takes = f.demo ? "The demo takes" : "bloop takes";
  /** @type {Record<typeof problem, [string, string]>} */
  const all = {
    heic: ["This HEIC Photo Can't Be Converted", "This browser can't read it. Export it as JPEG and try again."],
    type: ["This File Type Isn't Supported", `Choose a ${FILE_TYPES} file.`],
    empty: ["This File Is Empty", "Choose another file."],
    large: f.video
      ? ["Video Too Long", `${takes} videos up to about ${videoTime(f.maxMB)} (${f.maxMB} MB). Trim it and try again.`]
      : ["File Too Large", `${takes} files up to ${f.maxMB} MB.`],
    several: ["One File at a Time", "Drop a single file."],
    photo: ["This Photo Can't Be Sent", "This browser can't read it. Try another photo."],
    video: ["This Video Can't Be Sent", "bloop couldn't remove its location. Try another video."],
  };
  const [title, body] = all[problem];
  return { title, body, error: true };
}
