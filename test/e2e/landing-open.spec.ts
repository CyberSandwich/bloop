// The open-mode landing and its nav (ADR 0026), run by the `open` project. CI only.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./mode.ts";

const VIEWPORTS = [
  { width: 320, height: 640 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 844, height: 390 },
  { width: 834, height: 1112 },
  { width: 1440, height: 900 },
] as const;
const PAGES = [
  "/",
  "/privacy",
  "/terms",
  "/security",
  "/accessibility",
  "/articles",
  "/articles/features",
  "/no-such-page",
];
const SIGNED_IN = { name: "__Host-bloop_in", value: "1", url: "https://localhost:8787/" } as const;

// Runs in the page; the test tsconfig has no DOM library, so these are strings.
const BOX = (selector: string) => `(() => {
  const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
})()`;

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

test.describe("open pages are accessible", () => {
  for (const path of PAGES) {
    test(`${path} has no axe violations, no CSP violation and no horizontal scroll`, async ({ page }) => {
      const csp: string[] = [];
      page.on("console", (m) => {
        if (m.text().includes("Content Security Policy")) csp.push(m.text());
      });
      await page.goto(path);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(csp).toEqual([]);
      expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
    });
  }
});

for (const vp of VIEWPORTS) {
  test.describe(`open landing at ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp, hasTouch: vp.width < 900, isMobile: vp.width < 600 });

    test("the hero pair sits side by side or stacked, never overlapping, and inside the view", async ({ page }) => {
      await page.goto("/");
      await page.evaluate("document.fonts.ready");
      const a = (await page.evaluate(BOX(".hero .hero-actions .primary"))) as Box;
      const b = (await page.evaluate(BOX(".hero .hero-actions .secondary"))) as Box;
      const side = Math.round(a.top) === Math.round(b.top);
      if (side) expect(Math.round(a.right)).toBeLessThanOrEqual(Math.round(b.left));
      else expect(Math.round(a.bottom)).toBeLessThanOrEqual(Math.round(b.top));
      for (const box of [a, b]) {
        expect(Math.round(box.left)).toBeGreaterThanOrEqual(0);
        expect(Math.round(box.right)).toBeLessThanOrEqual(vp.width);
      }
    });

    test("the hint jumps to the waitlist block, whose heading lands below the nav", async ({ page }) => {
      await page.goto("/");
      await page.locator(".hint").click();
      // site.js drops the hash after a jump, so the scroll is the proof; it may still be moving when the click returns.
      const nav = (await page.evaluate(BOX(".nav"))) as Box;
      await expect
        .poll(async () => {
          const h2 = (await page.evaluate(BOX("#waitlist-h"))) as Box;
          return h2.top >= nav.bottom && h2.bottom <= vp.height;
        })
        .toBe(true);
    });

    test("the pill keeps the same two gaps with and without the Library hint", async ({ page, context }) => {
      test.skip(vp.width < 640, "the links fold into the menu");
      const gaps = async () => {
        await page.goto("/");
        await page.evaluate("document.fonts.ready");
        return (await page.evaluate(`(() => {
          const text = (s) => { const r = document.createRange(); r.selectNodeContents(document.querySelector(s)); return r.getBoundingClientRect(); };
          const t = text('.nav-links a[href="/terms"]'), p = text('.nav-links a[href="/privacy"]'), w = document.querySelector(".nav .account").getBoundingClientRect();
          return [t.left - p.right, w.left - t.right, w.width];
        })()`)) as number[];
      };
      const out = await gaps();
      await context.addCookies([SIGNED_IN]);
      const inn = await gaps();
      expect(Math.abs((inn[0] ?? 0) - (out[0] ?? 0))).toBeLessThanOrEqual(1);
      expect(Math.abs((inn[1] ?? 0) - (out[1] ?? 0))).toBeLessThanOrEqual(1);
      expect(Math.abs((inn[2] ?? 0) - (out[2] ?? 0))).toBeLessThanOrEqual(1);
    });
  });
}

test.describe("open landing actions", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Try the Demo opens the demo and Present Live goes to /s", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".hero .hero-actions .primary")).toHaveAttribute("href", "/demo");
    await page.locator(".hero .hero-actions .primary").click();
    await expect(page).toHaveURL(/\/s\?mode=demo$/);
    await page.goto("/");
    await page.locator(".hero .hero-actions .secondary").click();
    await expect(page).toHaveURL(/\/s$/);
  });

  test("the nav pill is Sign In to /signin, and Library to the library with the hint", async ({ page, context }) => {
    await page.goto("/");
    const pill = page.locator(".nav .account");
    await expect(pill).toHaveAttribute("href", "/signin");
    await expect(pill).toHaveAccessibleName("Sign In");
    await context.addCookies([SIGNED_IN]);
    await page.goto("/");
    await expect(pill).toHaveAccessibleName("Library");
    await expect(pill).not.toHaveAttribute("href", "/signin");
  });

  test("the waitlist block's button opens the form with its source", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#waitlist .primary")).toHaveAttribute("href", /\?source=landing-end$/);
  });

  test("the landing has no Features grid; the Features article is served", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#features")).toHaveCount(0);
    expect((await page.goto("/articles/features"))?.status()).toBe(200);
  });
});

test.describe("open menu on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the sheet holds Articles, Privacy and Terms, and the pill stays outside it", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Menu" }).tap();
    const nav = page.getByRole("navigation", { name: "Primary" });
    for (const name of ["Articles", "Privacy", "Terms"]) await expect(nav.getByRole("link", { name })).toBeVisible();
    expect(await page.locator("#nav-links .account").count()).toBe(0);
    await expect(page.locator(".nav .account")).toBeVisible();
  });
});

test.describe("open forced colors", () => {
  test.use({ viewport: { width: 1440, height: 900 }, forcedColors: "active" });

  test("the secondary button and the pill keep a border", async ({ page }) => {
    await page.goto("/");
    const borders = (await page.evaluate(`(() => {
      const of = (s) => { const c = getComputedStyle(document.querySelector(s)); return c.borderTopWidth + " " + c.borderTopStyle; };
      return [".hero .hero-actions .secondary", ".nav .account"].map(of);
    })()`)) as string[];
    expect(borders).toEqual(["1px solid", "1px solid"]);
  });
});

test.describe("open without popover (Safari 15, 16)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  // The next page's stylesheet request can still sit in a route.fetch when the last assertion passes.
  test.afterEach(({ page }) => page.unrouteAll({ behavior: "wait" }));

  test("the links show as a row, the pill is still there, and a link works", async ({ page }) => {
    await page.route(/\/css\/site\.css$/, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replaceAll(":popover-open", ":-x-popover-open") });
    });
    await page.route(/\/$/, async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(" popover>", ">").replace(/ popovertarget="[^"]+"/, "");
      await route.fulfill({ response, body });
    });
    await page.addInitScript(
      `for (const m of ["showPopover", "hidePopover", "togglePopover"]) delete HTMLElement.prototype[m];`,
    );
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("button", { name: "Menu" })).toBeHidden();
    for (const name of ["Articles", "Privacy", "Terms", "Sign In"])
      await expect(nav.getByRole("link", { name })).toBeVisible();
    await nav.getByRole("link", { name: "Privacy" }).click();
    await expect(page).toHaveURL(/\/privacy$/);
  });
});
