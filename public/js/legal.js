// The doc pages (design.md section 6). No HTML sinks (Trusted Types): the glyph is built as DOM.
import { ICONS } from "./core/icons.js";
import { icon } from "./core/ui.js";

// The panel's drift runs only on screen in a visible tab, as site.js does for the landing's.
const panel = document.querySelector(".panel");
if (panel) {
  let on = true;
  const pause = () => panel.classList.toggle("is-paused", !on || document.hidden);
  // A batch can hold an enter and a leave; the last entry is the current state.
  new IntersectionObserver((es) => {
    for (const e of es) on = e.isIntersecting;
    pause();
  }).observe(panel);
  addEventListener("visibilitychange", pause);
}
const copied = document.getElementById("copied");
for (const a of document.querySelectorAll(".legal-text a.num")) a.prepend(icon(ICONS.link));

let hide = 0;
addEventListener("click", (e) => {
  const a = e.target instanceof Element ? e.target.closest(".legal-text a.num") : null;
  if (!(a instanceof HTMLAnchorElement) || !copied || !navigator.clipboard) return;
  navigator.clipboard.writeText(a.href).then(
    () => {
      // Emptied first, so a second copy of the same link is announced again.
      copied.textContent = "";
      requestAnimationFrame(() => {
        copied.textContent = "Link Copied";
      });
      clearTimeout(hide);
      hide = setTimeout(() => {
        copied.textContent = "";
      }, 2000);
    },
    () => {},
  );
});

// A jump's section until the reader scrolls on, else the last at the end, else the band's: short and last
// sections may never cross the band.
const links = new Map([...document.querySelectorAll(".toc a")].map((a) => [a.getAttribute("href")?.slice(1), a]));
const sections = [...document.querySelectorAll(".legal-text > section")];
const seen = new Set();
let atEnd = false;
/** @type {{ id: string, y: number } | null} */
let jumped = null;

const render = () => {
  if (jumped && Math.abs(scrollY - jumped.y) > 48) jumped = null;
  const id = jumped?.id ?? (atEnd ? sections.at(-1)?.id : sections.find((s) => seen.has(s))?.id);
  if (!id) return;
  for (const [key, a] of links) {
    if (key === id) a.setAttribute("aria-current", "location");
    else a.removeAttribute("aria-current");
  }
};
const land = () => {
  const target = location.hash ? document.getElementById(location.hash.slice(1)) : null;
  const section = target?.closest(".legal-text > section");
  if (!section) return;
  jumped = { id: section.id, y: scrollY };
  render();
};

const band = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) seen.add(e.target);
      else seen.delete(e.target);
    }
    render();
  },
  { rootMargin: "-30% 0px -60% 0px" },
);
for (const s of sections) band.observe(s);
const end = document.querySelector(".related");
if (end) {
  new IntersectionObserver(([e]) => {
    atEnd = !!e?.isIntersecting;
    render();
  }).observe(end);
}
addEventListener("hashchange", land);
// A second click on the same row changes no hash, so the click lands too, after the jump.
addEventListener("click", (e) => {
  if (e.target instanceof Element && e.target.closest(".toc a")) setTimeout(land);
});
addEventListener("load", () => setTimeout(land));
