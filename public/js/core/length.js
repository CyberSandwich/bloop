// The Session Length sheet (design.md section 7, Phone page), loaded on the first tap on "Ends in". Its markup is in
// a.html, so this module only wires it: a length applies at once and closes the sheet; Until sets a clock time.
/** @import {ErrorCode, PhoneView} from "../../../src/shared/protocol.ts" */
/** @import {PhonePage} from "../types.js" */
import { clampLength, minutesUntil } from "../shared/length.js";
import { createApi } from "./api.js";

// Its stylesheet first, so the sheet never shows unstyled; a failed load fails the import, which the phone shows.
await new Promise((onload, onerror) => {
  document.head.append(
    Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/css/length.css", onload, onerror }),
  );
});

const api = createApi();
const sheet = /** @type {HTMLDialogElement} */ (document.getElementById("length"));
const at = /** @type {HTMLInputElement} */ (document.getElementById("length-at"));
const ends = /** @type {HTMLElement} */ (document.getElementById("ends"));
let max = 0;
/** @type {(minutes: number) => void} */
let set = () => {};

const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");

/** The sheet closes on the tap; the new end arrives in the answer, and on the screen through its socket. */
function choose(/** @type {number} */ minutes) {
  sheet.close();
  set(clampLength(minutes, max));
}

sheet.addEventListener("click", (e) => {
  const chip = e.target instanceof Element && e.target.closest("[data-minutes]");
  if (chip) choose(Number(chip.getAttribute("data-minutes")));
  // The dialog box has no padding of its own, so a click on it is a click on the backdrop.
  else if (e.target === sheet) sheet.close();
});
sheet.querySelector("form.until")?.addEventListener("submit", (e) => {
  e.preventDefault();
  choose(minutesUntil(at.value));
});
// The sheet belongs to a running session: when the page hides "Ends in" (an end, an error, a reconnect), it goes too.
new MutationObserver(() => {
  if (ends.hidden) sheet.close();
}).observe(ends, { attributeFilter: ["hidden"] });

/**
 * Opens the sheet with the lengths the mode's cap allows, and Until at the current end on this phone's clock.
 * @param {PhonePage} c
 * @param {(view: PhoneView) => void} onView the phone's view as `POST /api/session/length` answers it
 * @param {(code: ErrorCode) => void} onFail
 */
export function openLength(c, onView, onFail) {
  const view = c.view;
  if (!view?.endsAt || ends.hidden) return;
  max = view.maxMinutes;
  set = async (minutes) => {
    const res = await api.post("/api/session/length", { minutes }, c.pid);
    if (res.ok) onView(res.value);
    else onFail(res.error);
  };
  for (const chip of sheet.querySelectorAll("[data-minutes]")) {
    /** @type {HTMLElement} */ (chip).hidden = Number(chip.getAttribute("data-minutes")) > max;
  }
  const end = new Date(view.endsAt - c.skew);
  at.value = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
  sheet.showModal();
}
