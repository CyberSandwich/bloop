// The landing (design.md section 6). No inline style writes (the CSP) and no scroll listener.

const nav = document.querySelector(".nav");
const sentinel = document.getElementById("sentinel");
if (nav && sentinel)
  new IntersectionObserver(([entry]) => nav.classList.toggle("is-scrolled", !entry?.isIntersecting)).observe(sentinel);

// A popover stays open over a same-page jump such as Features.
const menu = document.getElementById("nav-links");
menu?.addEventListener("click", (e) => {
  if (e.target instanceof Element && e.target.closest("a") && menu.matches(":popover-open")) menu.hidePopover();
});

// The spring (k 120, c 30, m .4, implicit step) drives a paused animation that outranks the CSS tilt. Over the entry
// the visible share tracks the goal, so 1% thresholds wake the loop that stops once settled.
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
    const goal = Math.min(1, Math.max(0, (innerHeight - r.top) / Math.min(r.height, innerHeight)));
    const dt = Math.min(now - last, 64) / 1000;
    last = now;
    if (x < 0) x = goal;
    v = (v - 300 * (x - goal) * dt) / (1 + 75 * dt);
    x += v * dt;
    tilt.currentTime = tiltable.matches ? x * 1000 : 1000;
    frame = Math.abs(x - goal) + Math.abs(v) > 1e-3 ? requestAnimationFrame(step) : 0;
  };
  new IntersectionObserver(
    ([e]) => {
      cancelAnimationFrame(frame);
      last = performance.now();
      frame = e?.isIntersecting ? requestAnimationFrame(step) : 0;
    },
    { threshold: Array.from({ length: 101 }, (_, i) => i / 100) },
  ).observe(stage);
}

const still = matchMedia("(prefers-reduced-motion: reduce)");
if (!CSS.supports("interpolate-size", "allow-keywords")) {
  for (const details of /** @type {NodeListOf<HTMLDetailsElement>} */ (document.querySelectorAll(".faq details"))) {
    // The asked state: `open` lags while a close runs, and find in page opens one without a click.
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
