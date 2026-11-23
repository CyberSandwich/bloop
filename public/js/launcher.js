// Seam for the open path (docs/interfaces.md section 4): the open module replaces this with a
// ScreenLauncher. While it is null the screen shows no Download controls and ignores `open` frames.
/** @import {LinkSet} from "../../src/shared/protocol.ts" */

/**
 * @typedef {object} ScreenLauncher
 * @property {(links: LinkSet) => void} launch
 * @property {() => Promise<void>} download
 * @property {() => Promise<void>} showPdf
 */

/** @type {ScreenLauncher | null} */
export const launcher = null;
