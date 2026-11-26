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
  const polite = /** @type {HTMLElement} */ (document.getElementById("polite"));
  const buttons = (c.view?.choices ?? c.info?.choices ?? []).map((n) => {
    const b = document.createElement("button");
    b.className = "btn secondary choice";
    b.textContent = n;
    return b;
  });
  for (const skel of box.querySelectorAll(".skel")) skel.remove();
  legend.after(...buttons);
  // A live region is in the page, empty, before its words: one shown and filled in the same tick is often not read.
  line.hidden = false;
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  spinner.setAttribute("aria-hidden", "true");

  const pick = createPick(c, {
    ...io,
    // The Idempotency-Key rides on this one request; api.js stays as the room screen loads it.
    post: (path, body, auth, key) =>
      createApi({
        fetch: (url, init) => fetch(url, { ...init, headers: { ...init?.headers, "Idempotency-Key": key } }),
      }).post(path, body, auth),
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
      polite.textContent = tapped && SENDING;
      line.textContent = slow ? SLOW : "";
    },
    toast,
    // Android only; iOS has no web haptic, and none is faked.
    buzz: () => navigator.vibrate?.(12),
    later: (fn, ms) => setTimeout(fn, ms),
    stop: (timer) => clearTimeout(/** @type {number} */ (timer)),
  });
  // The click alone: a press on one number released on another clicks neither, and a wrong pick cannot be undone.
  // `touch-action: manipulation` (css/match.css) takes the tap delay away.
  box.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest(".choice") : null;
    if (b instanceof HTMLButtonElement && !b.disabled && b.textContent) void pick(b.textContent);
  });
}
