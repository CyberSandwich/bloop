// The Session Expiry sheet, loaded on the first tap on "Ends in"; markup in a.html.
/** @import {PhoneView} from "../../../src/shared/protocol.ts" */
/** @import {PhonePage} from "../types.js" */
import { canSet, clampLength, fitPresets, MIN_LENGTH_SECONDS, secondsUntil } from "../shared/length.js";
import { createApi } from "./api.js";
import { refused, styled } from "./lazy.js";

const api = createApi();
const sheet = /** @type {HTMLDialogElement} */ (document.getElementById("length"));
const at = /** @type {HTMLInputElement} */ (document.getElementById("length-at"));
const ends = /** @type {HTMLElement} */ (document.getElementById("ends"));
const setButton = /** @type {HTMLButtonElement} */ (sheet.querySelector("button[type=submit]"));
const hint = /** @type {HTMLElement} */ (document.getElementById("length-hint"));
/** The phone page the sheet is open for. @type {PhonePage} */
let page;
/** @type {(view: PhoneView) => void} */
let adopt = () => {};
/** @type {ReturnType<typeof setInterval> | undefined} */
let tick;

const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
const clock = (/** @type {Date} */ d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const failed = refused("The Session Expiry Didn't Change");
/** A server time on this phone's clock, as HH:MM. @param {number | null | undefined} at */
const clockOf = (at) => (at == null ? "" : clock(new Date(at - page.skew)));
/** Seconds the server still allows an end to move: it stops at approval plus the cap. */
const room = () => ((page.view?.latestEnd ?? Infinity) - page.skew - Date.now()) / 1000;

/** Set is usable only for a time at least a minute ahead and within what the server allows; the minute arriving disables it. */
const refresh = () => {
  const ok = canSet(at.value, room());
  setButton.disabled = !ok;
  if (ok) hint.hidden = true;
  else {
    void import("./length-extra.js").then((m) => {
      hint.textContent = m.hintText(
        at.value,
        secondsUntil(at.value) < MIN_LENGTH_SECONDS,
        clockOf(page.view?.latestEnd),
      );
      hint.hidden = !setButton.disabled;
    });
    // A disabled control cannot hold focus.
    if (document.activeElement === setButton) at.focus();
  }
};

async function choose(/** @type {number} */ seconds) {
  sheet.close();
  const res = await api.post("/api/session/length", { seconds }, page.pid);
  if (!res.ok) return failed(res.error);
  const next = res.value;
  // The socket's push is the truth: an older answer (an End meanwhile) is dropped.
  if (next.v > (page.view?.v ?? -1)) adopt(next);
  // The server stops at approval plus the cap: a silent cut would let "6 hours" look accepted.
  void import("./length-extra.js").then((m) => m.capped(next, seconds, clockOf(next.endsAt)));
}

sheet.addEventListener("click", (e) => {
  const t = e.target instanceof Element ? e.target : null;
  const chip = t?.closest("[data-minutes]");
  if (chip) choose(clampLength(Number(chip.getAttribute("data-minutes")) * 60, (page.view?.maxMinutes ?? 0) * 60));
  // Close is a plain button: a submit in the time's form would ask for a valid time first.
  else if (t === sheet || t?.closest(".sheet-x")) sheet.close();
});
sheet.querySelector("form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  // The Until path never clamps: out of range posts nothing, and the disabled Set says why. The minute the end already
  // falls in is no change, so the seconds it has left are not cut.
  if (!canSet(at.value, room())) return;
  if (at.value === clockOf(page.view?.endsAt)) sheet.close();
  else choose(secondsUntil(at.value));
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
  page = c;
  adopt = onView;
  fitPresets(sheet.querySelector(".chips"), view.maxMinutes);
  at.value = clockOf(view.endsAt);
  refresh();
  await styled("/css/length.css");
  if (ends.hidden) return;
  sheet.showModal();
  clearInterval(tick);
  tick = setInterval(refresh, 1000);
  document.getElementById("length-h")?.focus();
}
