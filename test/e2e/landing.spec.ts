// The landing against docs/design.md section 13 at the three check widths. CI only.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// The callbacks below run in the browser; the test tsconfig has no DOM library, so these names are
// declared here, for this file only.
interface El {
  getBoundingClientRect(): { top: number; bottom: number; width: number; height: number };
  textContent: string | null;
  closest(selector: string): El | null;
}
declare const document: {
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): Iterable<El>;
  documentElement: { scrollWidth: number };
  fonts?: { ready: Promise<unknown> };
};
declare const innerWidth: number;
declare const getComputedStyle: (el: El) => { visibility: string; lineHeight: string };

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900, touch: false },
  { name: "834", width: 834, height: 1112, touch: true },
  { name: "390", width: 390, height: 844, touch: true },
] as const;

for (const vp of VIEWPORTS) {
  test.describe(`landing at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.width === 390 });

    test("has no axe violations, no CSP violation and no robin", async ({ page }) => {
      const csp: string[] = [];
      const requests: string[] = [];
      page.on("request", (r) => requests.push(r.url()));
      page.on("console", (m) => {
        if (m.text().includes("Content Security Policy") || m.text().includes("TrustedHTML")) csp.push(m.text());
      });
      await page.goto("/");
      await page.waitForLoadState("load");
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(csp).toEqual([]);
      expect(requests.filter((u) => /robin/.test(u))).toEqual([]);
      expect((await page.content()).toLowerCase()).not.toContain("robin");
    });

    test("the h1 is one line, with no horizontal scroll and every target at least 44 px", async ({ page }) => {
      await page.goto("/");
      await page.evaluate(() => document.fonts?.ready);
      const lines = await page.evaluate(() => {
        const h1 = document.querySelector("h1");
        if (!h1) return 99;
        return Math.round(h1.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(h1).lineHeight));
      });
      expect(lines).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const small = await page.evaluate(() =>
        [...document.querySelectorAll("a, button, summary")]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return getComputedStyle(el).visibility !== "hidden" && r.width > 0 && el.closest(".skip, .faq p") === null;
          })
          .map((el) => ({ text: el.textContent?.trim(), h: Math.round(el.getBoundingClientRect().height) }))
          .filter((t) => t.h < 44),
      );
      expect(small).toEqual([]);
    });

    test("Try the demo is in the first view and opens the demo screen", async ({ page }) => {
      await page.goto("/");
      const demo = page.locator(".hero-actions").getByRole("link", { name: "Try the demo" });
      await expect(demo).toBeInViewport();
      await expect(demo).toHaveAttribute("href", "/s?mode=demo");
      await expect(page.locator(".hero-actions").getByRole("link", { name: "Get early access" })).toHaveAttribute(
        "href",
        /^mailto:ventures@saputra\.co\.uk/,
      );
    });

    test("the pill stays away over the hero, shows past it, and never covers the footer", async ({ page }) => {
      await page.goto("/");
      const pill = page.locator("#pill");
      await expect(pill).not.toHaveClass(/is-shown/);
      await expect(pill.getByRole("link", { name: "Try the demo" })).toBeHidden();
      await page.mouse.wheel(0, vp.height);
      await expect(pill).toHaveClass(/is-shown/);
      await expect(pill.getByRole("link", { name: "Try the demo" })).toBeVisible();
      await page.locator(".footer").scrollIntoViewIfNeeded();
      await page.mouse.wheel(0, 10_000);
      const pillTop = (await pill.boundingBox())?.y ?? 0;
      const footerLinks = await page.locator(".footer-links").boundingBox();
      expect((footerLinks?.y ?? 0) + (footerLinks?.height ?? 0)).toBeLessThanOrEqual(pillTop);
    });

    test("a question opens and closes", async ({ page }) => {
      await page.goto("/");
      const item = page.locator(".faq details").filter({ hasText: "What does the room PC keep?" });
      await item.locator("summary").click();
      await expect(item).toHaveAttribute("open", "");
      await expect(item.getByRole("link", { name: "See what can stay." })).toBeVisible();
      await item.locator("summary").click();
      await expect(item).not.toHaveAttribute("open", "");
    });
  });
}

test.describe("reel", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the pause control pauses the animation and says so", async ({ page }) => {
    await page.goto("/");
    const toggle = page.getByRole("button", { name: "Pause the animation" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#reel")).toHaveClass(/is-paused/);
  });
});

test.describe("reduced motion", () => {
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

  test("the reel shows its three frames side by side, captioned, with no pause control", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".frame")).toHaveCount(3);
    const tops = await page
      .locator(".frame")
      .evaluateAll((els) => els.map((el) => Math.round((el as unknown as El).getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);
    await expect(page.locator(".cap")).toHaveText(["Scan", "Approve", "Slides up"]);
    await expect(page.locator("#reel-toggle")).toBeHidden();
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
