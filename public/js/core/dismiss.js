// The one outside-tap dismiss for every popover (design.md section 6, Overlays), loaded by a page once one can open:
// from then on a tap outside an open popover only closes it, its pointer events and click reaching nothing else. The
// platform's light dismiss closes a popover but lets the tap's click land on whatever lies under it. A module runs once,
// so however often a page imports it, it listens once.

/**
 * A click this soon after the closing tap's pointerup, before the next pointerdown, is that tap's: iOS can send it
 * after a late touchend.
 */
const QUIET_MS = 350;
/** @type {HTMLElement | undefined} the popover the tap under way closes */
let shut;
let quiet = 0;
const eat = (/** @type {Event} */ e) => {
  e.preventDefault();
  e.stopImmediatePropagation();
};
addEventListener(
  "pointerdown",
  (e) => {
    const t = /** @type {Element} */ (e.target);
    const open = /** @type {HTMLElement[]} */ ([...document.querySelectorAll(":popover-open:not([popover=manual])")]);
    quiet = 0;
    // A tap in any open popover is that one's; its own invoker toggles it, so a tap there is no dismiss either.
    shut = open.some((p) => p.contains(t)) ? undefined : open.find((p) => !t.closest(`[popovertarget="${p.id}"]`));
    if (shut) eat(e);
  },
  true,
);
addEventListener(
  "pointerup",
  (e) => {
    if (!shut) return;
    eat(e);
    if (shut.matches(":popover-open")) shut.hidePopover();
    shut = undefined;
    quiet = e.timeStamp + QUIET_MS;
  },
  true,
);
addEventListener("click", (e) => e.timeStamp < quiet && eat(e), true);

export {};
