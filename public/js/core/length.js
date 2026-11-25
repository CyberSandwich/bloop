// The Session Length sheet (design.md section 7, Phone page), loaded on the first tap on "Ends in"; markup in a.html.
/** @import {PhoneView} from "../../../src/shared/protocol.ts" */
/** @import {PhonePage} from "../types.js" */
import { clampLength, minutesUntil } from "../shared/length.js";
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
const failed = refused("The Session Length Didn't Change");

function choose(/** @type {number} */ minutes) {
  sheet.close();
  set(clampLength(minutes, max), minutes);
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
 * The lengths the mode's cap allows, and Until at the current end on this phone's clock.
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
    // The socket's push is the truth: an answer older than the view it already brought (an End meanwhile) is dropped.
    if (next.now >= (c.view?.now ?? 0)) onView(next);
    // The cap (here, or approval plus it on the server) cut the choice short: say the end it set.
    if (next.state !== "ended" && next.endsAt && next.endsAt - c.skew < asked - MINUTE) {
      toast({
        title: `Ends at ${clock(new Date(next.endsAt - c.skew))}`,
        body: "That's the longest this session can run.",
      });
    }
  };
  for (const chip of sheet.querySelectorAll("[data-minutes]")) {
    /** @type {HTMLElement} */ (chip).hidden = Number(chip.getAttribute("data-minutes")) > max;
  }
  at.value = clock(new Date(view.endsAt - c.skew));
  await styled("/css/length.css");
  // The page may have moved on while the stylesheet loaded.
  if (!ends.hidden) sheet.showModal();
}
