// The landing (docs/design.md section 6): the nav's scrolled look, closing the menu on a same-page link, and the
// FAQ's open and close motion where CSS cannot animate to `height:auto`. Classes only: the CSP test bans inline
// style writes here.

// The nav firms up once the top sentinel leaves the view: an observer, never a scroll listener.
const nav = document.querySelector(".nav");
const sentinel = document.getElementById("sentinel");
if (nav && sentinel)
  new IntersectionObserver(([entry]) => nav.classList.toggle("is-scrolled", !entry?.isIntersecting)).observe(sentinel);

// A popover stays open over a same-page jump such as Features; any link in it closes it.
const menu = document.getElementById("nav-links");
menu?.addEventListener("click", (e) => {
  if (e.target instanceof Element && e.target.closest("a") && menu.matches(":popover-open")) menu.hidePopover();
});

// Browsers without `interpolate-size` get the same open and close as a WAAPI height tween.
const still = matchMedia("(prefers-reduced-motion: reduce)");
if (!CSS.supports("interpolate-size", "allow-keywords")) {
  for (const details of /** @type {NodeListOf<HTMLDetailsElement>} */ (document.querySelectorAll(".faq details"))) {
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
