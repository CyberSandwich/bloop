// Every user-facing string of /s, /a and /code (docs/design.md sections 3 and 7): headings in Title Case with no
// period, lines as sentences. A string marked [V-n] there is gated by verified.js.
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
  const title = f.file ?? "Your Slides";
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
        heading: "Check Your Phone",
        line: `It should show ${f.match ?? ""}.`,
        controls: ["start_over"],
      };
    case "approved":
      return { ...base, heading: "Approved", line: `Opening ${file}.`, controls: END };
    case "opening":
      return { ...base, heading: `Opening ${title}`, line: "In PowerPoint on this PC.", controls: ["end", "download"] };
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
        heading: f.openMode === "protocol" ? `${title} Is Open in PowerPoint` : `${title} Is Open`,
        line,
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
        heading: `Showing ${title} as a PDF`,
        line: "PowerPoint can't open it on this PC. Animations and videos won't play.",
        controls: END,
      };
    case "pdf_file":
      return { ...base, heading: title, line: "Opened as a PDF.", controls: END };
    case "guest_open":
      return {
        ...base,
        heading: title,
        line: "Sent by a guest. Open it here when you're ready.",
        controls: ["open", "start_over"],
      };
    case "ended":
      return { ...base, heading: SESSION_ENDED };
    case "offline":
      return {
        ...base,
        heading: "This Screen Is Offline",
        line: f.offlineLong ? `Reconnecting. ${SIGN_IN_HINT}` : "Reconnecting.",
      };
    case "service_down":
      return { ...base, heading: "bloop Isn't Responding", line: "Sign in to this PC as usual." };
    case "rate_limited":
      return {
        ...base,
        heading: f.demo ? "Too Many Demos Open Right Now" : "Too Many Screens Started Here",
        line: "Try again in a few minutes.",
      };
    case "error":
      return {
        ...base,
        heading: `Unable to Open ${title}`,
        line: "Try again on your phone, or sign in to this PC as usual.",
        alert: true,
      };
    case "phone_width":
      return { ...base, heading: "Open This on the Room's Screen", line: "Then scan its code with your phone." };
    case "demo_open":
      // The viewer: the item's name heads the stage; Present and Download belong to the item, not the state.
      return { ...base, heading: title, controls: END };
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
/** Revoke, or with the way back to the demo screen after it, which then takes the primary. */
const revokeActions = (/** @type {PhoneFacts} */ f) =>
  /** @type {PhoneAction[]} */ (f.back ? [{ ...REVOKE, kind: "secondary" }, BACK] : [REVOKE]);

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
  const file = f.file ?? "your slides";
  const disconnect = f.account ? [DISCONNECT] : [];
  // The match digits ride on the button that commits: the person compares them with the screen.
  const code = f.match ? ` (Code ${f.match})` : "";
  const APPROVE = { id: "approve", label: `Approve${code}`, kind: /** @type {const} */ ("primary") };
  const accountLine = VERIFIED.accountNeverReaches
    ? "Only the items you tick go to the screen. The screen never gets your account."
    : "Only the items you tick go to the screen.";
  /** The room as the title over the list (match to approving). */
  const room = { ...base, title: f.room, room: true, files: /** @type {const} */ ("list"), add: true };
  switch (key) {
    case "checking":
      return { ...base, body: "Checking the code" };
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
          ? "bloop reads your slides from OneDrive. You do this once, on this phone."
          : "bloop reads your slides from OneDrive.",
        room: true,
        actions: [SEND_FILE, CANCEL, { id: "connect", label: "Connect OneDrive", kind: "primary" }],
      };
    case "needs_admin":
      return {
        ...base,
        title: "Your Organization Needs to Approve bloop",
        body: "Ask your IT team, or sign in to the PC as usual.",
        actions: [DONE],
      };
    case "empty":
      return {
        ...base,
        title: "No Slides Found",
        body: "Save a .pptx file to OneDrive, then scan again.",
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
        actions: [CANCEL, { id: "send", label: `Send${code}`, kind: "primary" }],
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
        title: "Ask Your Host for a Guest Link",
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
        title: `Authorized on ${f.room}`,
        files: "items",
        ends: VERIFIED.autoEnd,
        actions: revokeActions(f),
      };
    case "open_fallback":
      return {
        ...base,
        title: "PowerPoint Didn't Open on the Screen",
        body: "Tap Download on the screen to open it there.",
        actions: [REVOKE],
      };
    case "pdf_fallback":
      return {
        ...base,
        title: `Showing as a PDF on ${f.room}`,
        body: "PowerPoint can't open it there. Animations and videos won't play.",
        actions: [REVOKE],
      };
    case "pdf_file":
      return { ...base, title: `Opened as a PDF on ${f.room}`, body: file, actions: [REVOKE] };
    case "ended":
      return {
        ...base,
        title: "Ended",
        body: VERIFIED.endedLink ? "The screen's link to your file has stopped working." : "",
        actions: [DONE],
      };
    case "canceled":
      return { ...base, title: "Canceled", body: "Nothing was opened on the screen.", actions: [DONE] };
    case "expired":
      return {
        ...base,
        title: "This Code Has Expired",
        body: "Scan the new code on the screen.",
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
        body: "Connect to Wi-Fi or mobile data, then try again.",
        actions: [TRY_AGAIN],
      };
    case "rate_limited":
      return {
        ...base,
        title: "Too Many Tries",
        body: "Wait a minute, then scan the code again.",
        actions: [DONE],
      };
    case "busy":
      return {
        ...base,
        title: "bloop Can't Take Files Right Now",
        body: "Try again in a few minutes, or sign in to the PC as usual.",
        actions: [DONE],
      };
    case "framed":
      return { ...base, title: "Open This Page Directly to Approve" };
    default:
      return {
        ...base,
        title: "Unable to Open Your Slides",
        body: "Check the file opens on your phone, then try again.",
        actions: [TRY_AGAIN],
      };
  }
}

const TYPED_WRONG = "Check the code on the screen and try again.";
/** The typed-code page's one sentence beside the field, per failure a claim can return. */
const TYPED = /** @type {Partial<Record<PhoneStateKey, string>>} */ ({
  typed_wrong: TYPED_WRONG,
  expired: "This code has expired. Enter the new code on the screen.",
  taken: "This code was already used. Enter the new code on the screen.",
  offline: "You're offline. Connect to Wi-Fi or mobile data, then try again.",
  rate_limited: "Too many tries. Wait a minute, then try again.",
  framed: "Open this page directly to enter a code.",
});
export const typedError = (/** @type {PhoneStateKey} */ key) => TYPED[key] ?? "Unable to check the code. Try again.";
