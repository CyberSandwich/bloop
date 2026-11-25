// The phone's strings (the rules: copy.js).
/** @import {PhoneStateKey} from "../../../src/shared/protocol.ts" */
/** @import {PhoneAction, PhoneCopy, PhoneFacts} from "../types.js" */

import { DOWN, SUPPORT } from "../shared/errors.js";
import { EXTENSION_TYPES } from "../shared/names.js";
import { SESSION_ENDED, TYPED_WRONG, WAITLIST_FORM } from "./copy.js";
import { VERIFIED } from "./verified.js";

export const MAIL_SUBJECT = "bloop isn't responding";

const ENTER_CODE = { id: "code", label: "Enter the Code", kind: /** @type {const} */ ("primary"), href: "/code" };
/** Revokes the stored OneDrive access (docs/architecture.md section 6, /api/me/disconnect). */
const DISCONNECT = { id: "disconnect", label: "Disconnect OneDrive", kind: /** @type {const} */ ("text") };
/** ".pptx, .pdf, .jpg, .png, .mp4 or .mov": each type once, by the extension that names it. */
const FILE_TYPES = [...new Set(Object.values(EXTENSION_TYPES))]
  .map((t) => `.${t}`)
  .join(", ")
  .replace(/, (?=[^,]*$)/, " or ");

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

/**
 * What a refusal the phone can name before sending says, as a toast. The cap is the server's (`dropMaxBytes`).
 * @param {"heic" | "type" | "empty" | "large" | "several" | "photo" | "video"} problem
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

/**
 * The upload row's second line: what the phone does to the file first, then the share sent (rounded as the loader's
 * aria-valuenow, but never 100 before the server answers).
 * @param {number | null} progress 0 to 1; null before the first byte
 * @param {"photo" | "video" | "file" | null} kind null after a reload, when this page holds no file
 */
export function uploadLine(progress, kind) {
  if (progress === null) return kind === "photo" ? "Compressing" : kind === "video" ? "Removing location" : "Sending";
  return progress >= 1 ? "Finishing" : `${Math.min(99, Math.round(progress * 100))}% sent`;
}

/** The guest entry where there is no list to end with the "Add a file" row. */
const SEND_FILE = { id: "send-file", label: "Add a File", kind: /** @type {const} */ ("text") };
const PICK = { id: "pick", label: "Choose File", kind: /** @type {const} */ ("primary") };
const CANCEL = { id: "cancel", label: "Cancel", kind: /** @type {const} */ ("secondary") };
const DONE = { id: "done", label: "Done", kind: /** @type {const} */ ("primary") };
/** A demo's end leads to the waitlist, in the same tab; Done steps back to secondary. */
const WAITLIST = {
  id: "waitlist",
  label: "Join the Waitlist",
  kind: /** @type {const} */ ("primary"),
  href: `${WAITLIST_FORM}?source=phone`,
  waitlist: true,
};
const resultActions = (/** @type {PhoneFacts} */ f) =>
  /** @type {PhoneAction[]} */ (f.demo ? [{ ...DONE, kind: "secondary" }, WAITLIST] : [DONE]);
const TRY_AGAIN = { id: "retry", label: "Try Again", kind: /** @type {const} */ ("primary") };
/** Ends the session, as End did: every link stops working. */
const REVOKE = { id: "end", label: "Revoke", kind: /** @type {const} */ ("rose") };
const BACK = {
  id: "back",
  label: "See It on the Screen",
  kind: /** @type {const} */ ("primary"),
  href: "/s?mode=demo",
};
/** In an approved session a failure keeps Revoke. */
const retryActions = (/** @type {PhoneFacts} */ f) =>
  /** @type {PhoneAction[]} */ (f.revoking ? [REVOKE] : f.live ? [REVOKE, TRY_AGAIN] : [TRY_AGAIN]);
/** Revoke, or with the way back to the demo screen after it, which then takes the primary. */
const revokeActions = (/** @type {PhoneFacts} */ f) =>
  /** @type {PhoneAction[]} */ (f.back ? [REVOKE, BACK] : [REVOKE]);

/**
 * Actions run in reading order side by side, the primary last (Cancel then Approve); stacked, app.css puts the
 * primary on top.
 * @param {PhoneStateKey} key
 * @param {PhoneFacts} f
 * @returns {PhoneCopy}
 */
export function phoneCopy(key, f) {
  const base = {
    title: "",
    body: "",
    room: false,
    files: /** @type {PhoneCopy["files"]} */ ("none"),
    add: false,
    ends: false,
    scope: "",
    warn: "",
    actions: /** @type {PhoneAction[]} */ ([]),
    loading: false,
  };
  const file = f.file ?? "your file";
  // A room with no name (unregistered) has none here either: the match digits say which screen.
  const to = (/** @type {string} */ word) => (f.room ? ` ${word} ${f.room}` : "");
  const disconnect = f.account ? [DISCONNECT] : [];
  // The match digits ride on the button that commits: the person compares them with the screen. One device has
  // nothing to compare.
  const match = f.back ? null : f.match;
  const code = match ? ` (${match})` : "";
  const aria = (/** @type {string} */ verb) => (match ? { aria: `${verb}, code ${match} on the screen` } : {});
  const APPROVE = {
    id: "approve",
    label: `Approve${code}`,
    kind: /** @type {const} */ ("primary"),
    ...aria("Approve"),
  };
  // A live phone's line: it approves one file.
  const accountLine = VERIFIED.accountNeverReaches
    ? "Only the file you select goes to the screen. The screen never gets your account."
    : "Only the file you select goes to the screen.";
  /** The room as the title over the list (match to approving). */
  const room = {
    ...base,
    title: f.room || (f.match ?? ""),
    room: true,
    files: /** @type {const} */ ("list"),
    add: true,
  };
  switch (key) {
    case "checking":
      return { ...base, body: "Checking the code." };
    case "match":
      return { ...room, files: "skeleton", add: false };
    case "choose":
      // Approve shows from the first list, disabled until a row is ticked, so the panel never changes shape.
      return { ...room, actions: [...disconnect, CANCEL, { ...APPROVE, disabled: true }] };
    case "approve":
      return { ...room, scope: accountLine, actions: [...disconnect, CANCEL, APPROVE] };
    case "approve_demo":
      return { ...room, actions: [CANCEL, APPROVE] };
    case "unregistered":
      return {
        ...room,
        warn: "This room isn't registered. Only approve if you can see the screen in front of you.",
        scope: accountLine,
        actions: [...disconnect, CANCEL, APPROVE],
      };
    case "approving":
      return {
        ...room,
        add: false,
        scope: f.demo ? "" : accountLine,
        actions: [CANCEL, { ...APPROVE, label: "Approving..." }],
        loading: true,
      };
    case "first_use":
      return {
        ...base,
        title: "Connect Your OneDrive",
        body: VERIFIED.oneDriveOnce
          ? "bloop reads your files from OneDrive. You do this once, on this phone."
          : "bloop reads your files from OneDrive.",
        room: true,
        actions: [SEND_FILE, CANCEL, { id: "connect", label: "Connect OneDrive", kind: "primary" }],
      };
    case "needs_admin":
      return {
        ...base,
        title: "Your IT Must Approve bloop",
        body: "Ask your IT team to approve it, then scan again.",
        actions: [DONE],
      };
    case "empty":
      return {
        ...base,
        title: "No Files Found",
        body: "Save a file to OneDrive, then scan again.",
        actions: [SEND_FILE, DONE],
      };
    case "guest_add":
      return {
        ...room,
        body: `Add one file from this ${f.back ? "device" : "phone"}. Only\u00a0this file goes to the screen.`,
      };
    case "guest_confirm": {
      // A long name keeps its start and its extension; the body then holds it whole.
      // By code points, so the cut never splits an emoji's surrogate pair.
      const chars = Array.from(file);
      const long = chars.length > 28;
      return {
        ...base,
        title: `Send ${long ? `${chars.slice(0, 19).join("")}…${chars.slice(-8).join("")}` : file}${to("to")}?`,
        body: `${long ? `${file}. ` : ""}${VERIFIED.guestDelete ? "bloop deletes its copy when this ends." : ""}`.trim(),
        actions: [CANCEL, { id: "send", label: `Send${code}`, kind: "primary", ...aria("Send") }],
      };
    }
    case "guest_sending":
      return { ...base, title: `Sending ${file}`, files: "upload", actions: [CANCEL] };
    case "guest_refused":
      return {
        ...base,
        title: "This File Can't Be Sent",
        body: `Choose a ${FILE_TYPES} file under ${f.maxMB ?? 50} MB.`,
        actions: f.list ? [CANCEL, PICK] : [PICK],
      };
    case "guest_sent":
      return {
        ...base,
        title: `Sent${to("to")}`,
        body: "Open it on the screen when you're ready.",
        actions: f.back ? [CANCEL, BACK] : [CANCEL],
      };
    case "guest_pass_needed":
      return {
        ...base,
        title: "Get a Guest Link First",
        body: "Open it on this phone, then scan the code again.",
        actions: [DONE],
      };
    case "guest_off":
      return {
        ...base,
        title: "This Room Can't Take Files",
        body: "Files from phones are off here. Ask your IT team to turn them on.",
        actions: [DONE],
      };
    case "opening":
    case "open":
      return {
        ...base,
        title: `Approved${to("for")}`,
        files: "items",
        ends: VERIFIED.autoEnd,
        actions: revokeActions(f),
      };
    case "open_fallback":
      return {
        ...base,
        title: "PowerPoint Didn't Open",
        body: "Tap Download on the screen to open it there.",
        actions: [REVOKE],
      };
    case "pdf_fallback":
      return {
        ...base,
        title: `Showing a PDF${to("on")}`,
        body: "PowerPoint can't open it there. Animations and videos won't play.",
        actions: [REVOKE],
      };
    case "pdf_file":
      return { ...base, title: `PDF Opened${to("on")}`, body: file, actions: [REVOKE] };
    case "ended":
      return {
        ...base,
        title: SESSION_ENDED,
        body: VERIFIED.endedLink
          ? "The screen's link to your file has stopped working."
          : f.demo
            ? ""
            : "Close PowerPoint on the room PC and delete any download there.",
        actions: resultActions(f),
      };
    case "canceled":
      return { ...base, title: "Approval Canceled", body: "Nothing was shared.", actions: resultActions(f) };
    case "expired":
      return {
        ...base,
        title: f.nocode ? "Scan the Code" : "This Code Has Expired",
        body: f.nocode ? "Point your phone camera at the code." : "Scan the new code on the screen.",
        actions: [ENTER_CODE],
      };
    case "taken":
      return {
        ...base,
        title: "This Code Was Already Used",
        body: "Scan the new code on the screen.",
        actions: [ENTER_CODE],
      };
    case "typed_wrong":
      return { ...base, title: "Check the Code", body: TYPED_WRONG, actions: [ENTER_CODE] };
    case "offline":
      return {
        ...base,
        title: "You're Offline",
        body: "Check your connection, then try again.",
        actions: retryActions(f),
      };
    case "rate_limited":
      return {
        ...base,
        title: "Too Many Scans Right Now",
        body: "Wait a minute, then scan the code again.",
        actions: [DONE],
      };
    case "busy":
      return {
        ...base,
        title: "bloop Can't Take Files Now",
        body: "Try again in a few minutes.",
        actions: [DONE],
      };
    case "service_down":
      return {
        ...base,
        title: "bloop Isn't Responding",
        body: DOWN,
        // Plain, so it works with bloop down; phone.js adds the facts on the way to it.
        actions: [
          {
            id: "mail",
            label: "Email bloop",
            kind: "text",
            href: `mailto:${SUPPORT}?subject=${encodeURIComponent(MAIL_SUBJECT)}`,
          },
          ...retryActions(f),
        ],
      };
    case "framed":
      return { ...base, title: "Open This Page Directly" };
    default:
      return {
        ...base,
        title: "Unable to Open Your File",
        body: "Check the file opens on your phone, then try again.",
        actions: retryActions(f),
      };
  }
}
