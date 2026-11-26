// Every site page at phone widths, as a touch phone lays it out (docs/design.md section 5, Phones, by eye). CI only.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "./mode.ts";

// An open article is a file in either folder: the open one wins, and Features exists only there.
const articles = (dirs: string[]) => [
  ...new Set(
    dirs.flatMap((dir) =>
      readdirSync(fileURLToPath(new URL(`../../content/${dir}`, import.meta.url)))
        .filter((f) => f.endsWith(".md") && f !== "index.md")
        .map((f) => `/articles/${f.slice(0, -3)}`),
    ),
  ),
];
const pages = (mode: "preview" | "open") => [
  "/",
  "/articles",
  ...articles(mode === "open" ? ["articles", "open/articles"] : ["articles"]),
  "/privacy",
  "/terms",
  "/security",
  "/accessibility",
  "/code",
  "/no-such-page",
];
const WIDTHS = [320, 360, 390] as const;

// Runs in the page. An element counts where it is drawn: an ancestor that clips (overflow other than visible)
// cuts its right edge, so a scroller's content or a clipped layer is not overflow. A link is a tap target unless
// it sits in running text (a p, li, td or th holding other words), where the line, not the box, is what a finger hits.
const SCAN = `(() => {
  const vw = innerWidth;
  const drawn = (el) => el.checkVisibility({ visibilityProperty: true }) && el.getClientRects().length > 0;
  const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).join(".") : "");
  const wide = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (el.closest(".sr") || !drawn(el)) continue;
    let right = el.getBoundingClientRect().right;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      if (getComputedStyle(a).overflowX !== "visible") right = Math.min(right, a.getBoundingClientRect().right);
    }
    if (Math.round(right) > vw) wide.push(name(el) + " " + Math.round(right));
  }
  const small = [];
  for (const el of document.body.querySelectorAll("button, input, summary, a[href]")) {
    if (el.closest(".sr") || !drawn(el)) continue;
    if (el.tagName === "A") {
      const box = el.closest("p, li, td, th");
      if (box && box.textContent.replace(el.textContent, "").trim() !== "") continue;
    }
    // A positioned ::after can grow the tap area past the box (legal.css a.num).
    const after = getComputedStyle(el, "::after");
    const grow = after.position === "absolute" ? -parseFloat(after.top) - parseFloat(after.bottom) || 0 : 0;
    const h = Math.round(el.getBoundingClientRect().height + Math.max(0, grow));
    if (h < 44) small.push(name(el) + " " + h);
  }
  return { inner: innerWidth, wide, small };
})()`;

for (const width of WIDTHS) {
  test.describe(`site pages at ${width}`, () => {
    test.use({ viewport: { width, height: 740 }, isMobile: true, hasTouch: true });

    // The list is built before a project's mode is known, so each mode's pages are listed and the other mode skips.
    for (const m of ["preview", "open"] as const) {
      for (const path of pages(m)) {
        test(`${m}: ${path} fits the width, and every tap target is 44 tall`, async ({ page, mode }) => {
          test.skip(mode !== m);
          await page.goto(path);
          await page.evaluate("document.fonts.ready");
          const { inner, wide, small } = (await page.evaluate(SCAN)) as {
            inner: number;
            wide: string[];
            small: string[];
          };
          expect(inner).toBe(width);
          expect(wide).toEqual([]);
          expect(small).toEqual([]);
        });
      }
    }
  });
}
