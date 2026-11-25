// The room screen's strings (the rules: copy.js).
/** @import {ScreenStateKey} from "../../../src/shared/protocol.ts" */
/** @import {ScreenControl, ScreenCopy, ScreenFacts} from "../types.js" */
import { down } from "../shared/errors.js";
import { SESSION_ENDED } from "./copy.js";
import { VERIFIED } from "./verified.js";

/** A claim's status, for screen readers only: the room screen shows the title and the match number alone. */
const WAITING_LINE = "Waiting for Approval";
/** Under Session Ended once a tap or Enter has asked for a new code. */
export const FRESH_LINE = "Getting a new code.";
export const CANT_PLAY = "This Video Can't Play Here";

/** The Check This Room page (`/s?check`). Numbers are arguments, filled from config and the measurement, never constants here. */
export const CHECK = {
  link: "Check This Room",
  title: "Check This Room",
  running: "Checking…",
  button: "Check Again",
  ready: "This room is ready.",
  limits: "This room works, with the limits below.",
  blocked: "bloop can't run in this room. Ask your IT team to allow bloop.here, then check again.",
  api: { pass: "bloop answers on this network.", fail: "This network blocks bloop." },
  live: {
    pass: "Live updates work here.",
    fail: (/** @type {number} */ seconds) =>
      `Live updates are blocked here, so bloop checks every ${seconds} s instead.`,
  },
  files: { pass: "Files load from their own address.", fail: "Files come from bloop.here instead." },
  speed: (/** @type {number} */ mbPerSecond) => `Downloads run at about ${mbPerSecond} MB a second.`,
  awake: { pass: "This browser can keep the screen awake.", fail: "This browser may let the screen sleep." },
  clock: {
    pass: "This PC's clock is right.",
    fail: (/** @type {number} */ minutes) => `This PC's clock is ${minutes} minutes off.`,
  },
};

/**
 * @param {ScreenStateKey} key
 * @param {ScreenFacts} f
 * @returns {ScreenCopy}
 */
export function screenCopy(key, f) {
  const file = f.file ?? "your file";
  /** @type {ScreenControl[]} */
  const END = ["end"];
  // In a session every state keeps End (and hides Back): a transient one (offline, an error) is no way out.
  const base = { line: "", controls: f.inSession ? END : [], alert: false };
  switch (key) {
    case "waiting":
      return { ...base, heading: f.room, controls: f.demo ? ["here"] : [] };
    case "scanned":
    case "choosing":
      return {
        ...base,
        heading: f.room,
        line: f.mine ? "Finish on this device." : `${WAITING_LINE}. Your phone shows ${f.match ?? ""}.`,
        controls: f.mine ? ["start_over", "continue"] : ["start_over"],
      };
    case "approved":
      return { ...base, heading: "Approved", line: `Opening ${file}.`, controls: END };
    case "opening":
      return {
        ...base,
        heading: !f.openMode || f.openMode === "protocol" ? "Opening in PowerPoint" : "Opening",
        line: f.click
          ? `${file}. Click Open to ${!f.openMode || f.openMode === "protocol" ? "start PowerPoint" : "show it"}.`
          : file,
        controls: ["end", "download"],
      };
    case "open": {
      const ends = f.endsAt;
      const after = f.guest
        ? VERIFIED.guestDelete && ends
          ? ` bloop deletes its copy when this ends at ${ends}.`
          : ""
        : VERIFIED.autoEnd && ends
          ? ` Ends by itself at ${ends}.`
          : "";
      return {
        ...base,
        // Only a protocol launch put it in PowerPoint; a fetch with no launch report says no more than it knows.
        heading: f.openMode === "protocol" ? "Open in PowerPoint" : "Opened",
        line: `${file}.${after}`,
        controls: ["end", "download"],
      };
    }
    case "open_fallback":
      return {
        ...base,
        heading: "PowerPoint Didn't Open",
        line: "Download the file, then open it from Downloads.",
        controls: ["download", "pdf", "end"],
      };
    case "pdf_fallback":
      return {
        ...base,
        heading: "Showing as a PDF",
        line: `${file}. PowerPoint can't open it on this PC. Animations and videos won't play.`,
        controls: END,
      };
    case "pdf_file":
      return { ...base, heading: "Opened as a PDF", line: `${file}.`, controls: END };
    case "guest_open":
      return {
        ...base,
        heading: "Sent by a Guest",
        line: `${file}. Open it here when you're ready.`,
        controls: ["open", "start_over"],
      };
    case "ended":
      return { ...base, heading: SESSION_ENDED, line: f.endLine ?? "", controls: f.demo ? ["waitlist"] : [] };
    case "offline":
      return {
        ...base,
        heading: "Offline",
        line: f.inSession ? "Reconnecting. You can still end from your phone." : "Reconnecting.",
      };
    case "service_down":
      return { ...base, heading: "bloop Isn't Responding", line: down("Refresh this page") };
    case "rate_limited":
      return {
        ...base,
        heading: f.demo ? "Too Many Demos Right Now" : "Busy Right Now",
        line: "Trying again by itself.",
      };
    case "error":
      return {
        ...base,
        heading: "Unable to Open Your File",
        line: "Try again on your phone.",
        alert: true,
      };
    case "phone_width":
      return {
        ...base,
        heading: "Use the Room's Screen",
        line: "Open this page there, then scan its code with your phone.",
      };
    case "demo_open":
      return { ...base, heading: file, controls: END };
  }
}

/** Why the session ended, and what a live PC may still hold (residue.js BEYOND_REACH): the line under Session Ended. */
export function endLine(
  /** @type {import("../../../src/shared/protocol.ts").EndReason | null} */ reason,
  /** @type {{ppt: boolean, download: string | null}} */ left,
) {
  return [
    reason === "auto" ? "Time's up." : "",
    left.ppt ? "Close PowerPoint to take your slides off this PC." : "",
    left.download ? `Delete ${left.download} from Downloads before you leave.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
