// The landing against docs/design.md section 13 at the three check widths. CI only.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

// The callbacks below run in the browser; the test tsconfig has no DOM library, so these names are
// declared here, for this file only.
interface Rect {
  top: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}
interface El {
  getBoundingClientRect(): Rect;
  textContent: string | null;
  closest(selector: string): El | null;
}
declare const document: {
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): Iterable<El>;
  documentElement: { scrollWidth: number; clientWidth: number };
};
declare const innerWidth: number;
declare const innerHeight: number;
declare const getComputedStyle: (el: El) => { visibility: string; display: string; lineHeight: string };
type Element = El;

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 723, fine: true },
  { name: "834", width: 834, height: 1112, fine: false },
  { name: "390", width: 390, height: 844, fine: false },
] as const;

/** Area of the largest visible element box among the given selectors. */
async function largest(page: Page, selectors: string[]) {
  return page.evaluate((list) => {
    let best = { selector: "", area: 0 };
    for (const selector of list) {
      for (const el of document.querySelectorAll(selector)) {
        const r = el.getBoundingClientRect();
        const area = Math.max(0, Math.min(r.bottom, innerHeight * 2) - Math.max(r.top, 0)) * r.width;
        if (area > best.area) best = { selector, area };
      }
    }
    return best;
  }, selectors);
}

for (const vp of VIEWPORTS) {
  test.describe(`landing at ${vp.name}`, () => {
    test.use({
      viewport: { width: vp.width, height: vp.height },
      hasTouch: !vp.fine,
      isMobile: vp.width === 390,
    });

    test("has no axe violations and no CSP violation", async ({ page }) => {
      const csp: string[] = [];
      page.on("console", (m) => {
        if (m.text().includes("Content Security Policy") || m.text().includes("TrustedHTML")) csp.push(m.text());
      });
      await page.goto("/");
      await page.waitForLoadState("load");
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(csp).toEqual([]);
    });

    test("has no horizontal scroll and every target is at least 44 px", async ({ page }) => {
      await page.goto("/");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const small = await page.evaluate(() =>
        [...document.querySelectorAll("a, button, [role=slider]")]
          .filter((el) => {
            const style = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return style.visibility !== "hidden" && r.width > 0 && el.closest("[inert], .skip, .footer-brand") === null;
          })
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { text: el.textContent?.trim(), h: Math.round(r.height) };
          })
          .filter((t) => t.h < 44 && t.text !== "bloop"),
      );
      // The nav CTA is 36 tall with a 44 px hit area from its ::before inset.
      expect(small.filter((t) => !["Try the Demo", "Send Me the Link"].includes(t.text ?? ""))).toEqual([]);
    });

    test("the primary action sits in the first viewport; the nav CTA is hidden there", async ({ page }) => {
      await page.goto("/");
      const primary = page.locator(".hero-actions .btn.primary:visible").first();
      await expect(primary).toBeInViewport();
      await expect(page.locator("#nav-cta")).toHaveClass(/is-hidden/);
      await page.mouse.wheel(0, vp.height * 1.5);
      await expect(page.locator("#nav-cta")).not.toHaveClass(/is-hidden/);
    });

    test("the robin is the largest visual and big enough", async ({ page }) => {
      await page.goto("/");
      const robin = page.locator("#hero-robin");
      const box = await robin.boundingBox();
      expect(box).not.toBeNull();
      if (!box) return;
      if (vp.width === 1440) {
        expect(box.height).toBeGreaterThanOrEqual(0.4 * vp.height);
        expect(box.x + box.width / 2).toBeGreaterThan(vp.width / 2);
      } else {
        expect(Math.abs(box.x + box.width / 2 - vp.width / 2)).toBeLessThanOrEqual(2);
      }
      const big = await largest(page, ["#hero-robin", ".orbit-screen", ".orbit-phone", ".file-pill", "h1"]);
      expect(big.selector).toBe("#hero-robin");
    });

    test("the h1 holds its two beats in at most 3 lines", async ({ page }) => {
      await page.goto("/");
      const lines = await page.evaluate(() => {
        const h1 = document.querySelector("h1");
        if (!h1) return 99;
        return Math.round(h1.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(h1).lineHeight));
      });
      expect(lines).toBeLessThanOrEqual(3);
    });

    test("the explorer opens one step at a time from the keyboard", async ({ page }) => {
      await page.goto("/");
      const first = page.locator("#step-0");
      await first.focus();
      await page.keyboard.press("ArrowDown");
      await expect(page.locator("#step-1")).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator("#step-0")).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator("#step-1")).toBeFocused();
      await page.keyboard.press("End");
      await expect(page.locator("#step-3")).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Home");
      await expect(page.locator("#step-0")).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator(".step.is-open")).toHaveCount(1);
    });
  });
}

test.describe("nav centering", () => {
  test("pill and links sit within 1 px of the viewport center from 360 to 1920", async ({ page }) => {
    await page.goto("/");
    for (let width = 360; width <= 1920; width += 10) {
      await page.setViewportSize({ width, height: 800 });
      const off = await page.evaluate(() => {
        const center = document.documentElement.clientWidth / 2;
        const mid = (el: Element | null) => {
          const r = el?.getBoundingClientRect();
          return r ? r.left + r.width / 2 : Number.NaN;
        };
        const links = document.querySelector(".nav-links");
        const showsLinks = links && getComputedStyle(links).display !== "none";
        return {
          pill: Math.abs(mid(document.querySelector(".nav")) - center),
          links: showsLinks ? Math.abs(mid(links) - center) : 0,
        };
      });
      expect(off.pill, `pill at ${width}`).toBeLessThanOrEqual(1);
      expect(off.links, `links at ${width}`).toBeLessThanOrEqual(1);
    }
  });
});

test.describe("desktop robin", () => {
  test.use({ viewport: { width: 1440, height: 723 } });

  test("the renderer loads only after the load event, then fades in over the poster", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    await page.goto("/", { waitUntil: "domcontentloaded" });
    expect(requests.some((u) => u.endsWith("/js/robin.js"))).toBe(false);
    await page.waitForLoadState("load");
    await expect(page.locator("#hero-robin canvas")).toHaveClass(/is-live/, { timeout: 10_000 });
  });

  test("the explorer's drag control turns with keys and the Turn buttons, and eases back", async ({ page }) => {
    await page.goto("/");
    await page.locator("#how").scrollIntoViewIfNeeded();
    const control = page.locator("#how-robin[role=slider]");
    await expect(control).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#turn-row")).toBeVisible();
    await control.focus();
    await page.keyboard.press("ArrowRight");
    await expect(control).toHaveAttribute("aria-valuenow", "30");
    await page.locator("#turn-left").click();
    await expect(control).toHaveAttribute("aria-valuenow", "0");
  });
});

test.describe("reduced motion", () => {
  test.use({ viewport: { width: 1440, height: 723 }, reducedMotion: "reduce" });

  test("shows stills: no renderer, no pin, every step open with its still", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    await page.goto("/");
    await page.waitForLoadState("load");
    await page.waitForTimeout(2500);
    expect(requests.some((u) => u.endsWith("/js/robin.js") || u.endsWith("/robin.bin"))).toBe(false);
    await expect(page.locator("#how")).not.toHaveClass(/is-pinned|is-live/);
    await expect(page.locator(".step-panel:visible")).toHaveCount(4);
    await expect(page.locator(".step-still img:visible")).toHaveCount(4);
  });
});

test.describe("site pages", () => {
  for (const path of ["/it", "/privacy", "/no-such-page"]) {
    test(`${path} has no axe violations`, async ({ page }) => {
      await page.goto(path);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    });
  }
});
