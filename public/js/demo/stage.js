// What the landing stage shows for each demo state (docs/design.md section 6, "Demo states in the stage
// screen"). Pure: demo/index.js draws it. The phone mock reuses the real /a strings from core/copy.js.
/** @import {PhoneStateKey, ScreenStateKey} from "../../../src/shared/protocol.ts" */

/** @typedef {"waiting" | "scanned" | "approved" | "open" | "ended" | "error"} StageState */

/**
 * The stage state for a screen state key. Null for `offline`: a dropped socket keeps what is shown until it
 * reconnects, so a blip does not flash the error state.
 * @param {ScreenStateKey} key
 * @returns {StageState | null}
 */
export function stageState(key) {
  switch (key) {
    case "waiting":
      return "waiting";
    case "scanned":
    case "choosing":
    case "guest_open":
      return "scanned";
    case "approved":
    case "opening":
      return "approved";
    case "open":
    case "open_fallback":
    case "pdf_fallback":
      return "open";
    case "ended":
      return "ended";
    case "offline":
      return null;
    default:
      return "error";
  }
}

/**
 * @param {StageState} state
 * @param {string | null} match the two digits the phone shows
 * @returns {{heading: string, line: string, action: string | null}}
 */
export function stageCopy(state, match) {
  switch (state) {
    case "waiting":
      return { heading: "Demo screen", line: "Scan with your phone camera to try it.", action: null };
    case "scanned":
      return { heading: "Check your phone.", line: `It should show ${match ?? ""}.`, action: null };
    case "approved":
      return { heading: "Approved.", line: "Opening the sample deck.", action: null };
    case "open":
      return {
        heading: "The sample deck is open.",
        line: "This page has no account. It was shown one file.",
        action: "Run It Again",
      };
    case "ended":
      return { heading: "Ended.", line: "Scan the new code to try again.", action: null };
    case "error":
      return { heading: "Unable to start the demo.", line: "", action: "Try Again" };
  }
}

/**
 * The real phone sheet the stage's phone mock echoes, or null while the phone has nothing to show.
 * @param {StageState} state
 * @returns {PhoneStateKey | null}
 */
export function phoneMockKey(state) {
  switch (state) {
    case "scanned":
      return "approve_demo";
    case "approved":
      return "opening";
    case "open":
      return "open";
    case "ended":
      return "ended";
    default:
      return null;
  }
}
