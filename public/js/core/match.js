// The live match pick (present-live.md 3.2 and 3.3): the person taps the number the screen shows. A right one confirms
// the claim; a wrong one cancels it server side (PAIR-14), so a second guess never turns three choices into a coin
// toss. Markup: a.html's #pick, whose skeleton pills hold the boxes until this lands; its look: css/match.css; its
// state: core/pick.js.
/** @import {PhoneView} from "../../../src/shared/protocol.ts" */
/** @import {PickCtx, PickIo} from "./pick.js" */
import { createApi } from "./api.js";
import { styled } from "./lazy.js";
import { createPick, LEGEND, SENDING, SLOW } from "./pick.js";
import { toast } from "./toast.js";

/**
 * Draws the three choices over the skeleton pills and takes the taps.
 * @param {PickCtx & {view: PhoneView | null, info: {choices: string[] | null} | null}} c
 * @param {PickIo} io
 */
export async function mount(c, io) {
  await styled("/css/match.css");
  const box = /** @type {HTMLFieldSetElement} */ (document.getElementById("pick"));
  const legend = /** @type {HTMLLegendElement} */ (box.querySelector("legend"));
  const line = /** @type {HTMLElement} */ (box.querySelector(".pick-slow"));
  const buttons = (c.view?.choices ?? c.info?.choices ?? []).map((n) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn secondary choice";
    b.textContent = n;
    return b;
  });
  for (const skel of box.querySelectorAll(".skel")) skel.remove();
  legend.after(...buttons);
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  spinner.setAttribute("aria-hidden", "true");

  const pick = createPick(c, {
    ...io,
    post: createApi().post,
    // The tapped choice fills ink at once, the other two go to disabled; the legend says it is sending.
    paint: (tapped, slow) => {
      for (const b of buttons) {
        const on = b.textContent === tapped;
        b.classList.toggle("primary", on);
        b.classList.toggle("secondary", !on);
        b.disabled = tapped !== null && !on;
      }
      legend.replaceChildren(...(tapped === null ? [LEGEND] : [spinner, SENDING]));
      if (tapped === null) box.removeAttribute("aria-busy");
      else box.setAttribute("aria-busy", "true");
      line.textContent = slow ? SLOW : "";
      line.hidden = !slow;
    },
    toast,
    // Android only; iOS has no web haptic, and none is faked.
    buzz: () => navigator.vibrate?.(12),
    later: (fn, ms) => setTimeout(fn, ms),
    stop: (timer) => clearTimeout(/** @type {number} */ (timer)),
  });
  const choiceOf = (/** @type {Event} */ e) => {
    const b = e.target instanceof Element ? e.target.closest(".choice") : null;
    return b instanceof HTMLButtonElement && !b.disabled ? b.textContent : null;
  };
  // The tap is the pointerup: a drag that scrolls ends in pointercancel instead, so it picks nothing.
  box.addEventListener("pointerup", (e) => {
    const n = e.isPrimary ? choiceOf(e) : null;
    if (n) void pick(n);
  });
  // A key or assistive tech clicks with no pointer (detail 0); a pointer's own click follows its pointerup.
  box.addEventListener("click", (e) => {
    const n = e.detail === 0 ? choiceOf(e) : null;
    if (n) void pick(n);
  });
}
