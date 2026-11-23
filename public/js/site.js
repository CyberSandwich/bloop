// The landing (docs/design.md section 6): the bottom pill, the reel's pause control, and the FAQ's open and
// close motion where CSS cannot animate to `height:auto`. Classes and properties only: the CSP test bans
// inline style writes here.

const byId = (/** @type {string} */ id) => document.getElementById(id);
const seen = (/** @type {Element} */ target, /** @type {(on: boolean) => void} */ fn) =>
  new IntersectionObserver(([entry]) => fn(!!entry?.isIntersecting)).observe(target);

// The pill stays away while the hero's own buttons are on screen, so one view never shows two.
const pill = byId("pill");
const heroActions = byId("hero-actions");
if (pill && heroActions)
  seen(heroActions, (on) => {
    pill.classList.toggle("is-shown", !on);
    pill.inert = on;
  });

// The reel is CSS keyframes; JS only pauses it, by the visitor's choice or while it is off screen.
const reel = byId("reel");
const toggle = byId("reel-toggle");
if (reel && toggle) {
  toggle.hidden = false;
  toggle.addEventListener("click", () =>
    toggle.setAttribute("aria-pressed", String(reel.classList.toggle("is-paused"))),
  );
  seen(reel, (on) => reel.classList.toggle("is-away", !on));
}

// Browsers without `interpolate-size` get the same open and close as a WAAPI height tween.
const still = matchMedia("(prefers-reduced-motion: reduce)");
if (!CSS.supports("interpolate-size", "allow-keywords")) {
  for (const details of document.querySelectorAll("details")) {
    // The state asked for, which `open` does not show while a close is still running.
    let opening = details.open;
    // Find in page opens a match without a click; follow it.
    details.addEventListener("toggle", () => {
      if (!details.getAnimations().length) opening = details.open;
    });
    details.querySelector("summary")?.addEventListener("click", (e) => {
      if (still.matches) return;
      e.preventDefault();
      const from = details.offsetHeight;
      for (const a of details.getAnimations()) a.cancel();
      opening = !opening;
      details.open = opening;
      const to = details.offsetHeight;
      details.open = true;
      const run = details.animate(
        { height: [`${from}px`, `${to}px`] },
        { duration: 380, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
      run.onfinish = () => {
        details.open = opening;
      };
    });
  }
}
