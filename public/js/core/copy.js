// Every user-facing string of /s, /a and /code, from docs/design.md sections 3 and 7. A string marked
// [V-n] there is gated by verified.js.
/** @import {PhoneStateKey, ScreenStateKey} from "../../../src/shared/protocol.ts" */
/** @import {PhoneAction, PhoneCopy, PhoneFacts, ScreenControl, ScreenCopy, ScreenFacts} from "../types.js" */
import { VERIFIED } from "./verified.js";

export const FOOTER_LINE = "Phone not with you? Sign in to this PC as usual.";
export const SIGN_IN_HINT = "Sign in to this PC as usual to open your slides.";
/** The one string that names the session, by the owner's ruling (design.md section 3). */
export const SESSION_ENDED = "Session Ended";

/**
 * @param {ScreenStateKey} key
 * @param {ScreenFacts} f
 * @returns {ScreenCopy}
 */
export function screenCopy(key, f) {
  const file = f.file ?? "your slides";
  const base = { line: "", controls: /** @type {ScreenControl[]} */ ([]), alert: false };
  /** @type {ScreenControl[]} */
  const END = ["end"];
  switch (key) {
    case "waiting":
      return { ...base, heading: f.room, controls: f.demo ? ["here"] : [] };
    case "scanned":
    case "choosing":
      // The line is for screen readers: the digits on the QR card show it (app.css hides it there).
      return {
        ...base,
        heading: "Check your phone.",
        line: `It should show ${f.match ?? ""}.`,
        controls: ["start_over"],
      };
    case "approved":
      return { ...base, heading: "Approved.", line: `Opening ${file}.`, controls: END };
    case "opening":
      return { ...base, heading: `Opening ${file}`, line: "in PowerPoint on this PC.", controls: ["end", "download"] };
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
      };
    }
    case "open_fallback":
      return {
        ...base,
        heading: "PowerPoint didn't open.",
        line: "Download the file, then open it from Downloads.",
        controls: ["download", "pdf", "end"],
      };
    case "pdf_fallback":
      return {
        ...base,
        heading: `Showing ${file} as a PDF.`,
        line: "PowerPoint can't open it on this PC. Animations and videos won't play.",
        controls: END,
      };
    case "pdf_file":
      return { ...base, heading: file, line: "Opened as a PDF.", controls: END };
    case "guest_open":
      return {
        ...base,
        heading: file,
        line: "Sent by a guest. Open it here when you're ready.",
        controls: ["open", "start_over"],
      };
    case "ended":
      return { ...base, heading: SESSION_ENDED };
    case "offline":
      return {
        ...base,
        heading: "This screen is offline.",
        line: f.offlineLong ? `Reconnecting. ${SIGN_IN_HINT}` : "Reconnecting.",
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
      return { ...base, heading: "Open this on the room's screen.", line: "Then scan its code with your phone." };
    case "demo_open":
      // The viewer: the item's name heads the stage; Present and Download belong to the item, not the state.
      return { ...base, heading: file, controls: END };
  }
}

const ENTER_CODE = { id: "code", label: "Enter a Code", kind: /** @type {const} */ ("text"), href: "/code" };
/** Revokes the stored OneDrive access (docs/architecture.md section 6, /api/me/disconnect). */
const DISCONNECT = { id: "disconnect", label: "Disconnect OneDrive", kind: /** @type {const} */ ("text") };
/** The guest entry where there is no list to end with the "Add a file" row. */
const SEND_FILE = { id: "send-file", label: "Add a File", kind: /** @type {const} */ ("text") };
const PICK = { id: "pick", label: "Choose File", kind: /** @type {const} */ ("primary") };
const CANCEL = { id: "cancel", label: "Cancel", kind: /** @type {const} */ ("secondary") };
const DONE = { id: "done", label: "Done", kind: /** @type {const} */ ("primary") };
const TRY_AGAIN = { id: "retry", label: "Try Again", kind: /** @type {const} */ ("primary") };
/** Ends the session, as End did: every link stops working. */
const REVOKE = { id: "end", label: "Revoke", kind: /** @type {const} */ ("primary") };
const BACK = {
  id: "back",
  label: "See It on the Screen",
  kind: /** @type {const} */ ("primary"),
  href: "/s?mode=demo",
};
/** Revoke, or with the way back to the demo screen first, which then takes the primary. */
const revokeActions = (/** @type {PhoneFacts} */ f) =>
  /** @type {PhoneAction[]} */ (f.back ? [BACK, { ...REVOKE, kind: "secondary" }] : [REVOKE]);

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
    files: /** @type {PhoneCopy["files"]} */ ("none"),
    add: false,
    ends: false,
    scope: "",
    warn: "",
    actions: /** @type {PhoneAction[]} */ ([]),
    loading: false,
    progress: false,
  };
  const file = f.file ?? "your slides";
  const disconnect = f.account ? [DISCONNECT] : [];
  const APPROVE = { id: "approve", label: "Approve", kind: /** @type {const} */ ("primary") };
  const accountLine = VERIFIED.accountNeverReaches
    ? "Only the items you tick go to the screen. The screen never gets your account."
    : "Only the items you tick go to the screen.";
  /** The room as the title over its code and the list (match to approving). */
  const room = { ...base, title: f.room, room: true, match: true, files: /** @type {const} */ ("list"), add: true };
  switch (key) {
    case "checking":
      return { ...base, body: "Checking the code" };
    case "match":
      return { ...room, files: "skeleton", add: false };
    case "choose":
      return { ...room, actions: disconnect };
    case "approve":
      return { ...room, scope: accountLine, actions: [APPROVE, CANCEL, ...disconnect] };
    case "approve_demo":
      return { ...room, actions: [APPROVE, CANCEL] };
    case "unregistered":
      return {
        ...room,
        warn: "This screen isn't registered. Only approve if you can see it in front of you.",
        scope: accountLine,
        actions: [APPROVE, CANCEL, ...disconnect],
      };
    case "approving":
      return {
        ...room,
        add: false,
        scope: f.demo ? "" : accountLine,
        actions: [{ ...APPROVE, label: "Approving..." }, CANCEL],
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
        match: true,
        actions: [PICK, CANCEL],
      };
    case "guest_confirm":
      return {
        ...base,
        title: `Send ${file} to ${f.room}?`,
        body: VERIFIED.guestDelete ? "bloop deletes its copy when this ends." : "",
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
    case "open":
      return {
        ...base,
        title: `Authorized on ${f.room}`,
        files: "items",
        ends: VERIFIED.autoEnd,
        actions: revokeActions(f),
      };
    case "open_fallback":
      return {
        ...base,
        title: "PowerPoint didn't open on the screen.",
        body: "Tap Download on the screen to open it there.",
        actions: [REVOKE],
      };
    case "pdf_fallback":
      return {
        ...base,
        title: `Showing as a PDF on ${f.room}.`,
        body: "PowerPoint can't open it there. Animations and videos won't play.",
        actions: [REVOKE],
      };
    case "pdf_file":
      return { ...base, title: `Opened as a PDF on ${f.room}.`, body: file, actions: [REVOKE] };
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
  const c = phoneCopy(key, { room: "", file: null });
  return [c.title, c.body].filter(Boolean).join(" ");
};
