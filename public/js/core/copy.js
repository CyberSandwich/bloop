// Every user-facing string of /s, /a and /code (docs/design.md sections 3 and 7): headings in Title Case with no
// period, lines as sentences. A string marked [V-n] there is gated by verified.js.
/** @import {PhoneStateKey, ScreenStateKey} from "../../../src/shared/protocol.ts" */
/** @import {PhoneAction, PhoneCopy, PhoneFacts, ScreenControl, ScreenCopy, ScreenFacts} from "../types.js" */
import { VERIFIED } from "./verified.js";

export const FOOTER_LINE = "Phone not with you? Sign in to this PC as usual.";
export const SIGN_IN_HINT = "Sign in to this PC as usual to open your file.";
/** The one string that names the session (design.md section 3). */
export const SESSION_ENDED = "Session Ended";

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
      // This browser also holds the claim (it went to /a): it finishes there.
      return f.mine
        ? { ...base, heading: "Finish Approving", controls: ["start_over", "continue"] }
        : {
            ...base,
            heading: "Check Your Phone",
            line: `Your phone shows ${f.match ?? ""}.`,
            controls: ["start_over"],
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
        heading: "This Screen Is Offline",
        line: f.inSession
          ? "Reconnecting. You can still end from your phone."
          : f.offlineLong
            ? `Reconnecting. ${SIGN_IN_HINT}`
            : "Reconnecting.",
      };
    case "service_down":
      return { ...base, heading: "bloop Isn't Responding", line: "Sign in to this PC as usual." };
    case "rate_limited":
      return {
        ...base,
        heading: f.demo ? "Too Many Demos Right Now" : "Too Many Screens Right Now",
        line: "Trying again by itself.",
      };
    case "error":
      return {
        ...base,
        heading: "Unable to Open Your File",
        line: "Try again on your phone, or sign in to this PC as usual.",
        alert: true,
      };
    case "phone_width":
      return {
        ...base,
        heading: "Use the Room's Screen",
        line: "Open this page there, then scan its code with your phone.",
      };
    case "demo_open":
      // The viewer: the item's name heads the stage; Present and Download belong to the item, not the state.
      return { ...base, heading: file, controls: END };
  }
}

/** Why the session ended, and what a live PC may still hold (residue.js BEYOND_REACH): the line under Session Ended. */
export function endLine(
  /** @type {import("../../../src/shared/protocol.ts").EndReason | null} */ reason,
  /** @type {{ppt: boolean, download: string | null}} */ left,
) {
  return [
    reason === "phone" ? "Revoked from the phone." : reason === "auto" ? "Time's up." : "",
    left.ppt ? "Close PowerPoint to take your slides off this PC." : "",
    left.download ? `Delete ${left.download} from Downloads before you leave.` : "",
  ]
    .filter(Boolean)
    .join(" ");
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
const REVOKE = { id: "end", label: "Revoke", kind: /** @type {const} */ ("rose") };
const BACK = {
  id: "back",
  label: "See It on the Screen",
  kind: /** @type {const} */ ("primary"),
  href: "/s?mode=demo",
};
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
    progress: false,
  };
  const file = f.file ?? "your file";
  const disconnect = f.account ? [DISCONNECT] : [];
  // The match digits ride on the button that commits: the person compares them with the screen.
  const code = f.match ? ` (${f.match})` : "";
  const aria = (/** @type {string} */ verb) => (f.match ? { aria: `${verb}, code ${f.match} on the screen` } : {});
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
  const room = { ...base, title: f.room, room: true, files: /** @type {const} */ ("list"), add: true };
  switch (key) {
    case "checking":
      return { ...base, body: "Checking the code." };
    case "match":
      return { ...room, files: "skeleton", add: false };
    case "choose":
      return { ...room, actions: disconnect };
    case "approve":
      return { ...room, scope: accountLine, actions: [...disconnect, CANCEL, APPROVE] };
    case "approve_demo":
      return { ...room, actions: [CANCEL, APPROVE] };
    case "unregistered":
      return {
        ...room,
        warn: "This screen isn't registered. Only approve if you can see it in front of you.",
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
        body: "Ask your IT team, or sign in to the PC as usual.",
        actions: [DONE],
      };
    case "empty":
      return {
        ...base,
        title: "No Files Found",
        body: "Save a file to OneDrive, then scan again.",
        actions: [SEND_FILE, DONE],
      };
    case "guest_choose":
      return {
        ...base,
        title: `Send a File to ${f.room}?`,
        body: "Choose one file from this phone. Only this file goes to the screen.",
        actions: [CANCEL, PICK],
      };
    case "guest_confirm":
      return {
        ...base,
        title: `Send ${file} to ${f.room}?`,
        body: VERIFIED.guestDelete ? "bloop deletes its copy when this ends." : "",
        actions: [CANCEL, { id: "send", label: `Send${code}`, kind: "primary", ...aria("Send") }],
      };
    case "guest_sending":
      return { ...base, title: `Sending ${file}`, progress: true, actions: [CANCEL] };
    case "guest_refused":
      return {
        ...base,
        title: "This File Can't Be Sent",
        body: `Choose a .pptx or .pdf file under ${f.maxMB ?? 50} MB.`,
        actions: [PICK],
      };
    case "guest_sent":
      return {
        ...base,
        title: `Sent to ${f.room}`,
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
        title: "This Screen Can't Take Files",
        body: "Sign in to the PC as usual to open your file.",
        actions: [DONE],
      };
    case "opening":
    case "open":
      return {
        ...base,
        title: `Approved for ${f.room}`,
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
        title: `Showing a PDF on ${f.room}`,
        body: "PowerPoint can't open it there. Animations and videos won't play.",
        actions: [REVOKE],
      };
    case "pdf_file":
      return { ...base, title: `PDF Opened on ${f.room}`, body: file, actions: [REVOKE] };
    case "ended":
      return {
        ...base,
        title: SESSION_ENDED,
        body: VERIFIED.endedLink
          ? "The screen's link to your file has stopped working."
          : f.demo
            ? "Your files left the screen."
            : "Close PowerPoint on the room PC and delete any download there.",
        actions: [DONE],
      };
    case "canceled":
      return { ...base, title: SESSION_ENDED, body: "Nothing was opened on the screen.", actions: [DONE] };
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
        actions: [TRY_AGAIN],
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
        body: "Try again in a few minutes, or sign in to the PC as usual.",
        actions: [DONE],
      };
    case "framed":
      return { ...base, title: "Open This Page Directly" };
    default:
      return {
        ...base,
        title: "Unable to Open Your File",
        body: "Check the file opens on your phone, then try again.",
        actions: [TRY_AGAIN],
      };
  }
}

const TYPED_WRONG = "Check the code on the screen and try again.";
export const TYPED_LETTERS = "Codes don't use 0, 1, I, L, O or U.";
/** The typed-code page's one sentence beside the field, per failure a claim can return. */
const TYPED = /** @type {Partial<Record<PhoneStateKey, string>>} */ ({
  typed_wrong: TYPED_WRONG,
  expired: "That code changed. Enter the new code on the screen.",
  taken: "This code was already used. Enter the new code on the screen.",
  offline: "You're offline. Check your connection, then try again.",
  rate_limited: "Too many tries. Wait a minute, then enter the code again.",
  framed: "Open this page directly to enter a code.",
});
export const typedError = (/** @type {PhoneStateKey} */ key) => TYPED[key] ?? "Unable to check the code. Try again.";
