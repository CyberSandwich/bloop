// The Session Expiry sheet, loaded on the first tap on "Ends in"; markup in a.html.
/** @import {PhoneView} from "../../../src/shared/protocol.ts" */
/** @import {PhonePage} from "../types.js" */
import { clampLength, fitPresets, minutesUntil } from "../shared/length.js";
import { createApi } from "./api.js";
import { refused, styled } from "./lazy.js";
import { toast } from "./toast.js";

const MINUTE = 60_000;
const api = createApi();
const sheet = /** @type {HTMLDialogElement} */ (document.getElementById("length"));
const at = /** @type {HTMLInputElement} */ (document.getElementById("length-at"));
const ends = /** @type {HTMLElement} */ (document.getElementById("ends"));
let max = 0;
/** @type {(minutes: number, wanted: number) => void} */
let set = () => {};

const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
const clock = (/** @type {Date} */ d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const failed = refused("The Session Expiry Didn't Change");

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
  set = async (minutes, wanted) => {
    const asked = Date.now() + wanted * MINUTE;
    const res = await api.post("/api/session/length", { minutes }, c.pid);
    if (!res.ok) return failed(res.error);
    const next = res.value;
    // The socket's push is the truth: an older answer (an End meanwhile) is dropped.
    if (next.v > (c.view?.v ?? -1)) onView(next);
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
  await styled("/css/length.css");
  if (ends.hidden) return;
  sheet.showModal();
  document.getElementById("length-h")?.focus();
}
