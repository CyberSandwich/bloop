// The Session Expiry sheet (design.md section 7), loaded on the first tap on "Ends in"; its markup is in a.html.
// A failed change is a toast over the running session, never a page state.
/** @import {ErrorCode, PhoneView} from "../../../src/shared/protocol.ts" */
/** @import {PhonePage} from "../types.js" */
import { clampLength, fitPresets, minutesUntil } from "../shared/length.js";
import { createApi } from "./api.js";
import { toast } from "./toast.js";

const MINUTE = 60_000;
const api = createApi();
const sheet = /** @type {HTMLDialogElement} */ (document.getElementById("length"));
const at = /** @type {HTMLInputElement} */ (document.getElementById("length-at"));
const ends = /** @type {HTMLElement} */ (document.getElementById("ends"));
let max = 0;
/** @type {(minutes: number, wanted: number) => void} */
let set = () => {};
/** @type {Promise<void> | undefined} */
let styled;

const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
const clock = (/** @type {Date} */ d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Its stylesheet before the sheet shows. Never a rejection (a failed module stays failed): unstyled, and the next open retries. */
function style() {
  styled ??= new Promise((resolve) => {
    const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/css/length.css" });
    link.onload = () => resolve();
    link.onerror = () => {
      link.remove();
      styled = undefined;
      resolve();
    };
    document.head.append(link);
  });
  return styled;
}

/** The ends of a session need no toast: its socket pushes them and the page shows them. */
const SHOWN_BY_PUSH = /** @type {ErrorCode[]} */ (["session_ended", "pairing_invalid", "wrong_state", "screen_gone"]);

/** A refused or failed change, as a toast; the session runs on as it was. */
function failed(/** @type {ErrorCode} */ code) {
  if (SHOWN_BY_PUSH.includes(code)) return;
  toast({
    title: "The Session Expiry Didn't Change",
    body:
      code === "rate_limited"
        ? "Too many changes at once. Wait a minute, then try again."
        : code === "offline"
          ? "Check the connection, then try again."
          : "Try again in a moment.",
    error: true,
  });
}

/** The sheet closes on the tap; the new end arrives in the answer, and on the screen through its socket. */
function choose(/** @type {number} */ minutes) {
  sheet.close();
  set(clampLength(minutes, max), minutes);
}

sheet.addEventListener("click", (e) => {
  const chip = e.target instanceof Element && e.target.closest("[data-minutes]");
  if (chip) choose(Number(chip.getAttribute("data-minutes")));
  else if (e.target === sheet) sheet.close();
});
sheet.querySelector("form.until")?.addEventListener("submit", (e) => {
  e.preventDefault();
  choose(minutesUntil(at.value));
});
// The sheet goes when the page hides "Ends in" (an end, an error, a reconnect).
new MutationObserver(() => {
  if (ends.hidden) sheet.close();
}).observe(ends, { attributeFilter: ["hidden"] });

/**
 * Opens the sheet: presets within the cap, the time input at the current end on this phone's clock.
 * @param {PhonePage} c
 * @param {(view: PhoneView) => void} onView the phone's view as `POST /api/session/length` answers it
 */
export async function openLength(c, onView) {
  const view = c.view;
  if (!view?.endsAt || ends.hidden) return;
  max = view.maxMinutes;
  set = async (minutes, wanted) => {
    const asked = Date.now() + wanted * MINUTE;
    const res = await api.post("/api/session/length", { minutes }, c.pid);
    if (!res.ok) return failed(res.error);
    const next = res.value;
    // The socket's push is the truth: an older answer (an End meanwhile) is dropped.
    if (next.now >= (c.view?.now ?? 0)) onView(next);
    // The cap cut the choice short: say the end it set.
    if (next.state !== "ended" && next.endsAt && next.endsAt - c.skew < asked - MINUTE) {
      toast({
        title: `Ends at ${clock(new Date(next.endsAt - c.skew))}`,
        body: "That's the longest this session can run.",
      });
    }
  };
  fitPresets(sheet.querySelector(".chips"), max);
  at.value = clock(new Date(view.endsAt - c.skew));
  await style();
  if (ends.hidden) return;
  sheet.showModal();
  // Not Close: its :focus-visible ring read as a large circle on iPhone Safari.
  sheet.focus();
}
