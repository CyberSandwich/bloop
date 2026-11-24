// The doc pages (design.md section 6, Legal pages). A clause or section number copies its link; the contents mark
// the section being read. No HTML sinks (Trusted Types): the glyph is built as DOM.
import { ICONS } from "./core/icons.js";
import { icon } from "./core/ui.js";

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

// The section crossing a band at about a third of the view is the one being read.
const links = new Map([...document.querySelectorAll(".toc a")].map((a) => [a.getAttribute("href")?.slice(1), a]));
const sections = [...document.querySelectorAll(".legal-text > section")];
const seen = new Set();
const spy = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) seen.add(e.target);
      else seen.delete(e.target);
    }
    const current = sections.find((s) => seen.has(s));
    if (!current) return;
    for (const [id, a] of links) {
      if (id === current.id) a.setAttribute("aria-current", "location");
      else a.removeAttribute("aria-current");
    }
  },
  { rootMargin: "-30% 0px -60% 0px" },
);
for (const s of sections) spy.observe(s);
