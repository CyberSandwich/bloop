// The Session Expiry sheet, loaded on the first tap on "Ends in"; markup in a.html.
/** @import {PhoneView} from "../../../src/shared/protocol.ts" */
/** @import {PhonePage} from "../types.js" */
import { canSet, clampLength, fitPresets, secondsUntil } from "../shared/length.js";
import { createApi } from "./api.js";
import { refused, styled } from "./lazy.js";

const api = createApi();
const sheet = /** @type {HTMLDialogElement} */ (document.getElementById("length"));
const at = /** @type {HTMLInputElement} */ (document.getElementById("length-at"));
const ends = /** @type {HTMLElement} */ (document.getElementById("ends"));
const setButton = /** @type {HTMLButtonElement} */ (sheet.querySelector("button[type=submit]"));
let max = 0;
/** @type {(seconds: number) => void} */
let set = () => {};
/** @type {ReturnType<typeof setInterval> | undefined} */
let tick;

const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
const clock = (/** @type {Date} */ d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const failed = refused("The Session Expiry Didn't Change");

/** Set is usable only for a time at least a minute ahead and within the cap; the minute arriving disables it. */
const refresh = () => {
  setButton.disabled = !canSet(at.value, max);
};

function choose(/** @type {number} */ seconds) {
  sheet.close();
  set(seconds);
}

sheet.addEventListener("click", (e) => {
  const t = e.target instanceof Element ? e.target : null;
  const chip = t?.closest("[data-minutes]");
  if (chip) choose(clampLength(Number(chip.getAttribute("data-minutes")) * 60, max * 60));
  // Close is a plain button: a submit in the time's form would ask for a valid time first.
  else if (t === sheet || t?.closest(".sheet-x")) sheet.close();
});
sheet.querySelector("form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  // The Until path never clamps: out of range posts nothing, and the disabled Set already says why.
  if (canSet(at.value, max)) choose(secondsUntil(at.value));
});
at.addEventListener("input", refresh);
at.addEventListener("change", refresh);
sheet.addEventListener("close", () => clearInterval(tick));
// It goes when the page hides "Ends in" (an end, an error, a reconnect).
new MutationObserver(() => {
  if (ends.hidden) sheet.close();
}).observe(ends, { attributeFilter: ["hidden"] });

/**
 * Presets within the cap, and the time at the current end on this phone's clock.
 * @param {PhonePage} c
 * @param {(view: PhoneView) => void} onView the phone's view as `POST /api/session/length` answers it
 */
export async function openLength(c, onView) {
  const view = c.view;
  if (!view?.endsAt || ends.hidden) return;
  max = view.maxMinutes;
  // Cut to the cap with no toast: the countdown and the screen's "Ends by itself at" line show the end it set.
  set = async (seconds) => {
    const res = await api.post("/api/session/length", { seconds }, c.pid);
    if (!res.ok) return failed(res.error);
    const next = res.value;
    // The socket's push is the truth: an older answer (an End meanwhile) is dropped.
    if (next.v > (c.view?.v ?? -1)) onView(next);
  };
  fitPresets(sheet.querySelector(".chips"), max);
  at.value = clock(new Date(view.endsAt - c.skew));
  refresh();
  await styled("/css/length.css");
  if (ends.hidden) return;
  sheet.showModal();
  clearInterval(tick);
  tick = setInterval(refresh, 1000);
  document.getElementById("length-h")?.focus();
}
