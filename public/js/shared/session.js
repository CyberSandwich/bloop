// One copy for the Worker and the pages.
/** @import {SessionState, Sound} from "../../../src/shared/protocol.ts" */

/** @type {readonly SessionState[]} */
export const IN_SESSION = ["approved", "opening", "open"];

/** A claim not yet approved. @type {readonly SessionState[]} */
export const LIVE_CLAIM = ["claimed", "choosing"];

/** A video's play state when `shown` carries none, and a new item's (VID-05): playing, with sound. */
export const TUNE = Object.freeze({ play: true, sound: /** @type {Sound} */ ("on") });
/** @param {{play?: boolean | undefined, sound?: Sound | undefined} | null | undefined} s */
export const tuneOf = (s) => ({ play: s?.play ?? TUNE.play, sound: s?.sound ?? TUNE.sound });

// The pairing is over: its pid opens nothing.
export const PAIRING_OVER = /** @type {readonly SessionState[]} */ (["ended", "waiting", "closed"]);

/**
 * Files by name, then links by title: every list, and every item index.
 * @template {{kind: "file", name: string} | {kind: "link", title: string}} T
 * @param {readonly T[]} items
 * @returns {T[]}
 */
export function orderItems(items) {
  const label = (/** @type {T} */ i) => (i.kind === "file" ? i.name : i.title);
  const rank = (/** @type {T} */ i) => (i.kind === "file" ? 0 : 1);
  return [...items].sort((a, b) => rank(a) - rank(b) || label(a).localeCompare(label(b), "en"));
}
