// The landing (design.md section 6). No inline style writes (the CSP) and no scroll listener.

const nav = document.querySelector(".nav");
const sentinel = document.getElementById("sentinel");
if (nav && sentinel)
  new IntersectionObserver(([entry]) => nav.classList.toggle("is-scrolled", !entry?.isIntersecting)).observe(sentinel);

// A jump leaves no hash and a reload opens at the top; Back and forward get the place saved on pagehide.
history.scrollRestoration = "manual";
const dropHash = () => history.replaceState(0, "", location.href.split("#")[0]);
addEventListener("click", (e) => {
  if (e.target instanceof Element && e.target.closest('a[href^="/#"], a[href^="#"]')) setTimeout(dropHash);
});
addEventListener("pagehide", () => history.replaceState({ y: scrollY }, ""));
const kept =
  /** @type {PerformanceNavigationTiming} */ (performance.getEntriesByType("navigation")[0])?.type === "back_forward" &&
  history.state?.y;
if (location.hash) addEventListener("load", () => setTimeout(dropHash));
else if (kept) addEventListener("load", () => scrollTo(0, kept));
else scrollTo(0, 0);

// The sheen and the backdrop drifts play only while on screen and the tab is visible.
const shown = new Map();
const pause = () => {
  for (const [el, on] of shown) el.classList.toggle("is-paused", !on || document.hidden);
};
const watch = new IntersectionObserver((es) => {
  for (const e of es) shown.set(e.target, e.isIntersecting);
  pause();
});
for (const el of document.querySelectorAll(".sheen, .frag, .panel, .close-panel")) watch.observe(el);
addEventListener("visibilitychange", pause);

// The Approve still's rows toggle their tick, as the phone's list does.
document.querySelector(".frag-list")?.addEventListener("click", (e) => {
  const row = e.target instanceof Element && e.target.closest("[aria-pressed]");
  if (row) row.setAttribute("aria-pressed", `${row.getAttribute("aria-pressed") === "false"}`);
});

// A link closes the sheet, which would cover a jump; Safari 15 and 16 have no popover, so no method.
const menu = document.getElementById("nav-links");
menu?.addEventListener("click", (e) => {
  if (e.target instanceof Element && e.target.closest("a")) menu.hidePopover?.();
});

// A spring (k 120, c 30, m .4, implicit step) drives a paused animation over the CSS tilt; 1% thresholds wake it.
const stage = document.querySelector(".stage");
const tiltable = matchMedia("(prefers-reduced-motion: no-preference)");
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

if (!CSS.supports("interpolate-size", "allow-keywords")) {
  for (const details of /** @type {NodeListOf<HTMLDetailsElement>} */ (document.querySelectorAll(".faq details"))) {
    // The asked state: `open` lags while a close runs, and find in page opens one without a click.
    let opening = details.open;
    details.addEventListener("toggle", () => {
      if (!details.getAnimations().length) opening = details.open;
    });
    details.querySelector("summary")?.addEventListener("click", (e) => {
      if (!tiltable.matches) return;
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
