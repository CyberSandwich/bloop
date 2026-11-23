// Every user-facing string of /s, /a and /code, from docs/design.md sections 3 and 7. A string marked
// [V-n] there is gated by verified.js.
/** @import {FileType, OpenMode, PhoneStateKey, ScreenStateKey} from "../../../src/shared/protocol.ts" */
import { VERIFIED } from "./verified.js";

export const FOOTER_LINE = "Phone not with you? Sign in to this PC as usual.";
export const SIGN_IN_HINT = "Sign in to this PC as usual to open your slides.";

/** @typedef {"start_over" | "end" | "open" | "download" | "pdf" | "here"} ScreenControl `here` is the demo's "Approve on This Device" link */
/**
 * @typedef {object} ScreenCopy
 * @property {string} heading
 * @property {string} line
 * @property {ScreenControl[]} controls
 * @property {boolean} alert announce assertively
 * @property {string | null} chip text of the status chip, only after the object shows the state
 * @property {string | null} [chipIcon]
 */
/**
 * @typedef {object} ScreenFacts
 * @property {string} room
 * @property {string | null} match
 * @property {string | null} file
 * @property {string | null} endsAt local time, "11:35"
 * @property {boolean} guest
 * @property {boolean} offlineLong the screen has been offline for a while
 * @property {boolean} [demo] a demo screen (`/s?mode=demo`)
 * @property {OpenMode | null} [openMode] how the screen opened the file; only `protocol` is a PowerPoint launch
 * @property {FileType | null} [fileType]
 */

/**
 * @param {ScreenStateKey} key
 * @param {ScreenFacts} f
 * @returns {ScreenCopy}
 */
export function screenCopy(key, f) {
  const file = f.file ?? "your slides";
  const base = { controls: /** @type {ScreenControl[]} */ ([]), alert: false, chip: null };
  switch (key) {
    case "waiting":
      return f.demo
        ? {
            ...base,
            heading: f.room,
            line: "Scan with your phone camera, or approve on this device.",
            controls: ["here"],
          }
        : { ...base, heading: f.room, line: "Scan with your phone camera to present your slides." };
    case "scanned":
      return {
        ...base,
        heading: "Check your phone.",
        line: `It should show ${f.match ?? ""}.`,
        controls: ["start_over"],
        chip: "Scanned",
      };
    case "choosing":
      return {
        ...base,
        heading: "Check your phone.",
        line: "Choose a file, then tap Approve.",
        controls: ["start_over"],
        chip: "Scanned",
      };
    case "approved":
      return {
        ...base,
        heading: "Approved.",
        line: `Opening ${file}.`,
        controls: ["end"],
        chip: "Approved",
        chipIcon: "check",
      };
    case "opening":
      return {
        ...base,
        heading: `Opening ${file}`,
        line: "in PowerPoint on this PC.",
        controls: ["end", "download"],
        chip: "Approved",
        chipIcon: "check",
      };
    case "open": {
      const ends = f.endsAt;
      const line = f.guest
        ? VERIFIED.guestDelete && ends
          ? `bloop deletes its copy when this ends at ${ends}.`
          : ""
        : VERIFIED.autoEnd && ends
          ? `Ends by itself at ${ends}.`
          : "";
      return {
        ...base,
        // Only a protocol launch put it in PowerPoint; a fetch with no launch report says no more than it knows.
        heading: f.openMode === "protocol" ? `${file} is open in PowerPoint.` : `${file} is open.`,
        line,
        controls: ["end", "download"],
        chip: "Approved",
        chipIcon: "check",
      };
    }
    case "open_fallback":
      return {
        ...base,
        heading: "PowerPoint didn't open.",
        line: "Download the file, then open it from Downloads.",
        controls: ["download", "pdf", "end"],
        chip: "Approved",
        chipIcon: "check",
      };
    case "pdf_fallback":
      return {
        ...base,
        heading: `Showing ${file} as a PDF.`,
        line: "PowerPoint can't open it on this PC. Animations and videos won't play.",
        controls: ["end"],
        chip: "Approved",
        chipIcon: "check",
      };
    case "pdf_file":
      return {
        ...base,
        heading: file,
        line: "Opened as a PDF.",
        controls: ["end"],
        chip: "Approved",
        chipIcon: "check",
      };
    case "guest_open":
      return {
        ...base,
        heading: file,
        line: "Sent by a guest. Open it here when you're ready.",
        controls: ["open", "start_over"],
        chip: "Scanned",
      };
    case "ended":
      return { ...base, heading: "Ended.", line: "Scan the new code to present." };
    case "offline":
      return {
        ...base,
        heading: "This screen is offline.",
        line: f.offlineLong ? `Reconnecting. ${SIGN_IN_HINT}` : "Reconnecting.",
        chip: "Offline",
        chipIcon: "wifi-off",
      };
    case "service_down":
      return { ...base, heading: "bloop isn't responding.", line: "Sign in to this PC as usual." };
    case "rate_limited":
      return {
        ...base,
        heading: f.demo ? "Too many demos open right now." : "Too many screens started here.",
        line: "Try again in a few minutes.",
      };
    case "error":
      return {
        ...base,
        heading: `Unable to open ${file}.`,
        line: "Try again on your phone, or sign in to this PC as usual.",
        alert: true,
      };
    case "phone_width":
      return {
        ...base,
        heading: "Open this on the room's screen.",
        line: "Then scan its code with your phone.",
      };
    case "demo_open": {
      const done = { ...base, chip: "Approved", chipIcon: "check" };
      if (!f.guest) {
        return { ...done, heading: file, line: "On a room PC this opens in PowerPoint.", controls: ["end"] };
      }
      return {
        ...done,
        heading: "Your file reached the screen.",
        line: f.fileType === "pdf" ? "On a room PC it opens as a PDF." : "On a room PC it opens in PowerPoint.",
        controls: ["end", "download"],
      };
    }
  }
}

/** @typedef {{id: string, label: string, kind: "primary" | "secondary" | "text", href?: string}} PhoneAction */
/**
 * @typedef {object} PhoneCopy
 * @property {string} title
 * @property {string} body
 * @property {boolean} room the room row
 * @property {boolean} match the match code block
 * @property {"none" | "skeleton" | "list"} files
 * @property {string} scope the scope line under the files, with a lock
 * @property {string} warn the unregistered-screen card
 * @property {PhoneAction[]} actions
 * @property {boolean} loading the primary action shows its progress label
 * @property {boolean} progress the upload progress bar
 */
/**
 * @typedef {object} PhoneFacts
 * @property {string} room
 * @property {string | null} file
 * @property {string | null} endsAt
 * @property {boolean} [account] the phone is signed in to OneDrive, so it can disconnect
 * @property {number} [maxMB] the largest guest file, in whole megabytes
 * @property {boolean} [back] this tab is also the demo screen (the one-device round trip), so it can go back to it
 */

const ENTER_CODE = { id: "code", label: "Enter a Code", kind: /** @type {const} */ ("text"), href: "/code" };
/** Revokes the stored OneDrive access (docs/architecture.md section 6, /api/me/disconnect). */
const DISCONNECT = { id: "disconnect", label: "Disconnect OneDrive", kind: /** @type {const} */ ("text") };
/** The guest entry: a phone that scanned with no OneDrive to choose from sends its own file instead. */
const SEND_FILE = { id: "send-file", label: "Send a File Instead", kind: /** @type {const} */ ("text") };
const PICK = { id: "pick", label: "Choose File", kind: /** @type {const} */ ("primary") };
const CANCEL = { id: "cancel", label: "Cancel", kind: /** @type {const} */ ("secondary") };
const DONE = { id: "done", label: "Done", kind: /** @type {const} */ ("primary") };
const TRY_AGAIN = { id: "retry", label: "Try Again", kind: /** @type {const} */ ("primary") };
const END = { id: "end", label: "End", kind: /** @type {const} */ ("primary") };
const BACK = {
  id: "back",
  label: "See It on the Screen",
  kind: /** @type {const} */ ("primary"),
  href: "/s?mode=demo",
};
/** End, or with the way back to the demo screen first, which then takes the primary. */
const endActions = (/** @type {PhoneFacts} */ f) =>
  /** @type {PhoneAction[]} */ (f.back ? [BACK, { ...END, kind: "secondary" }] : [END]);

/**
 * @param {PhoneStateKey} key
 * @param {PhoneFacts} f
 * @returns {PhoneCopy}
 */
export function phoneCopy(key, f) {
  const base = {
    title: "",
    body: "",
    room: false,
    match: false,
    files: /** @type {"none" | "skeleton" | "list"} */ ("none"),
    scope: "",
    warn: "",
    actions: /** @type {PhoneAction[]} */ ([]),
    loading: false,
    progress: false,
  };
  const file = f.file ?? "your slides";
  const disconnect = f.account ? [DISCONNECT] : [];
  const approveActions = /** @type {PhoneAction[]} */ ([
    { id: "approve", label: "Approve", kind: "primary" },
    CANCEL,
    SEND_FILE,
    ...disconnect,
  ]);
  const accountLine = VERIFIED.accountNeverReaches
    ? "Only this file goes to the screen. The screen never gets your account."
    : "Only this file goes to the screen.";
  switch (key) {
    case "checking":
      return { ...base, body: "Checking the code" };
    case "match":
      return { ...base, title: "Open slides on this screen?", room: true, match: true, files: "skeleton" };
    case "choose":
      return {
        ...base,
        title: "Choose your slides.",
        body: "Your recent slides",
        room: true,
        match: true,
        files: "list",
        actions: [SEND_FILE, ...disconnect],
      };
    case "approve":
      return {
        ...base,
        title: `Open ${file} on ${f.room}?`,
        room: true,
        match: true,
        files: "list",
        scope: accountLine,
        actions: approveActions,
      };
    case "approve_demo":
      return {
        ...base,
        title: `Open ${file} here?`,
        room: true,
        match: true,
        files: "list",
        scope: "This is a demo. You don't need an account.",
        actions: approveActions.filter((a) => a.id !== DISCONNECT.id),
      };
    case "unregistered":
      return {
        ...base,
        title: `Open ${file} on ${f.room}?`,
        room: true,
        match: true,
        files: "list",
        warn: "This screen isn't registered. Only approve if you can see it in front of you.",
        scope: accountLine,
        actions: approveActions,
      };
    case "approving":
      return {
        ...base,
        title: `Open ${file} on ${f.room}?`,
        room: true,
        match: true,
        files: "list",
        scope: accountLine,
        actions: [
          { id: "approve", label: "Approving...", kind: "primary" },
          { id: "cancel", label: "Cancel", kind: "secondary" },
        ],
        loading: true,
      };
    case "first_use":
      return {
        ...base,
        title: "Connect your OneDrive.",
        body: VERIFIED.oneDriveOnce
          ? "bloop reads your slides from OneDrive. You do this once, on this phone."
          : "bloop reads your slides from OneDrive.",
        room: true,
        match: true,
        actions: [{ id: "connect", label: "Connect OneDrive", kind: "primary" }, CANCEL, SEND_FILE],
      };
    case "needs_admin":
      return {
        ...base,
        title: "Your organization needs to approve bloop.",
        body: "Ask your IT team, or sign in to the PC as usual.",
        actions: [DONE],
      };
    case "empty":
      return {
        ...base,
        title: "No slides found.",
        body: "Save a .pptx file to OneDrive, then scan again.",
        actions: [DONE, SEND_FILE],
      };
    case "guest_choose":
      return {
        ...base,
        title: `Send a file to ${f.room}?`,
        body: "Choose one file from this phone. Only this file goes to the screen.",
        room: true,
        match: true,
        actions: [PICK, CANCEL],
      };
    case "guest_confirm":
      return {
        ...base,
        title: `Send ${file} to ${f.room}?`,
        body: VERIFIED.guestDelete ? "bloop deletes its copy when this ends." : "",
        room: true,
        match: true,
        actions: [{ id: "send", label: "Send", kind: "primary" }, CANCEL],
      };
    case "guest_sending":
      return { ...base, title: `Sending ${file}`, progress: true, actions: [CANCEL] };
    case "guest_refused":
      return {
        ...base,
        title: "This file can't be sent.",
        body: `Choose a .pptx or .pdf file under ${f.maxMB ?? 50} MB.`,
        actions: [PICK],
      };
    case "guest_sent":
      return {
        ...base,
        title: `Sent to ${f.room}.`,
        body: "Open it on the screen when you're ready.",
        actions: f.back ? [BACK, CANCEL] : [CANCEL],
      };
    case "guest_pass_needed":
      return {
        ...base,
        title: "Ask your host for a guest link.",
        body: "Open it on this phone, then scan the code again.",
        actions: [DONE],
      };
    case "guest_off":
      return {
        ...base,
        title: "This screen can't take files.",
        body: "Sign in to the PC as usual to open your file.",
        actions: [DONE],
      };
    case "opening":
      return { ...base, title: `Opening on ${f.room}.`, body: file, actions: endActions(f) };
    case "open": {
      const ends = VERIFIED.autoEnd && f.endsAt ? ` Ends by itself at ${f.endsAt}.` : "";
      return { ...base, title: `Open on ${f.room}.`, body: `${file}.${ends}`, actions: endActions(f) };
    }
    case "open_fallback":
      return {
        ...base,
        title: "PowerPoint didn't open on the screen.",
        body: "Tap Download on the screen to open it there.",
        actions: [END],
      };
    case "pdf_fallback":
      return {
        ...base,
        title: `Showing as a PDF on ${f.room}.`,
        body: "PowerPoint can't open it there. Animations and videos won't play.",
        actions: [END],
      };
    case "pdf_file":
      return { ...base, title: `Opened as a PDF on ${f.room}.`, body: file, actions: [END] };
    case "ended":
      return {
        ...base,
        title: "Ended.",
        body: VERIFIED.endedLink ? "The screen's link to your file has stopped working." : "",
        actions: [DONE],
      };
    case "canceled":
      return { ...base, title: "Canceled.", body: "Nothing was opened on the screen.", actions: [DONE] };
    case "expired":
      return {
        ...base,
        title: "This code has expired.",
        body: "Scan the new code on the screen.",
        actions: [ENTER_CODE],
      };
    case "taken":
      return {
        ...base,
        title: "This code was already used.",
        body: "Scan the new code on the screen.",
        actions: [ENTER_CODE],
      };
    case "typed_wrong":
      return { ...base, title: "Check the code on the screen and try again.", actions: [ENTER_CODE] };
    case "offline":
      return {
        ...base,
        title: "You're offline.",
        body: "Connect to Wi-Fi or mobile data, then try again.",
        actions: [TRY_AGAIN],
      };
    case "rate_limited":
      return {
        ...base,
        title: "Too many tries.",
        body: "Wait a minute, then scan the code again.",
        actions: [DONE],
      };
    case "busy":
      return {
        ...base,
        title: "bloop can't take files right now.",
        body: "Try again in a few minutes, or sign in to the PC as usual.",
        actions: [DONE],
      };
    case "framed":
      return { ...base, title: "Open this page directly to approve." };
    default:
      return {
        ...base,
        title: "Unable to open your slides.",
        body: "Check the file opens on your phone, then try again.",
        actions: [TRY_AGAIN],
      };
  }
}

/** Typed-code page: the line beside the field for a failed claim. */
export const typedError = (/** @type {PhoneStateKey} */ key) => {
  const c = phoneCopy(key, { room: "", file: null, endsAt: null });
  return [c.title, c.body].filter(Boolean).join(" ");
};
