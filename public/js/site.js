// The landing (design.md section 6): the nav's scrolled look, the menu closing on a same-page link, the sprung stage
// tilt, and the FAQ height tween where CSS cannot. No inline style writes (the CSP test) and no scroll listener.

const nav = document.querySelector(".nav");
const sentinel = document.getElementById("sentinel");
if (nav && sentinel)
  new IntersectionObserver(([entry]) => nav.classList.toggle("is-scrolled", !entry?.isIntersecting)).observe(sentinel);

// A popover stays open over a same-page jump such as Features.
const menu = document.getElementById("nav-links");
menu?.addEventListener("click", (e) => {
  if (e.target instanceof Element && e.target.closest("a") && menu.matches(":popover-open")) menu.hidePopover();
});

// The CSS tilt's range (entry 0% to cover 30%) through a spring (k 120, c 30, m .4, implicit damping) into a paused
// animation, which outranks the CSS one; only while the stage is in view.
const stage = document.querySelector(".stage");
const tiltable = matchMedia("(prefers-reduced-motion: no-preference) and (min-width: 900px)");
if (stage && tiltable.matches) {
  const tilt = stage.animate({ transform: ["rotateX(24deg) scale(.9)", "none"] }, { duration: 1000, fill: "both" });
  tilt.pause();
  let x = -1;
  let v = 0;
  let last = 0;
  let frame = 0;
  /** @param {number} now */
  const step = (now) => {
    const r = stage.getBoundingClientRect();
    const goal = Math.min(1, Math.max(0, (innerHeight - r.top) / (0.3 * (innerHeight + r.height))));
    const dt = Math.min(now - last, 64) / 1000;
    last = now;
    if (x < 0) x = goal;
    v = (v - 300 * (x - goal) * dt) / (1 + 75 * dt);
    x += v * dt;
    tilt.currentTime = tiltable.matches ? x * 1000 : 1000;
    frame = requestAnimationFrame(step);
  };
  new IntersectionObserver(([entry]) => {
    cancelAnimationFrame(frame);
    last = performance.now();
    if (entry?.isIntersecting) frame = requestAnimationFrame(step);
  }).observe(stage);
}

const still = matchMedia("(prefers-reduced-motion: reduce)");
if (!CSS.supports("interpolate-size", "allow-keywords")) {
  for (const details of /** @type {NodeListOf<HTMLDetailsElement>} */ (document.querySelectorAll(".faq details"))) {
    // The asked state (`open` lags while a close runs); find in page opens one without a click.
    let opening = details.open;
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
      details.animate(
        { height: [`${from}px`, `${to}px`] },
        { duration: 380, easing: "cubic-bezier(.22,1,.36,1)" },
      ).onfinish = () => {
        details.open = opening;
      };
    });
  }
}
