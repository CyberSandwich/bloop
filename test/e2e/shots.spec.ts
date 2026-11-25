// Throwaway screenshots for the landing round's visual check; lives only on ci/landing-shots, never merged.
import { type Page, test } from "@playwright/test";

const SIZES = [
  [1440, 900],
  [834, 1112],
  [430, 932],
  [390, 844],
  [320, 640],
  [844, 390],
] as const;

const midWhy = (page: Page) =>
  page.evaluate(`(() => {
    const r = document.querySelector(".why p").getBoundingClientRect();
    scrollBy(0, r.top + r.height / 2 - innerHeight / 2);
  })()`);

for (const [w, h] of SIZES) {
  test.describe(`${w}x${h}`, () => {
    test.use({ viewport: { width: w, height: h }, hasTouch: w < 1000, isMobile: w < 500 });

    test("why mid-fill and the top of the page", async ({ page }) => {
      await page.goto("/");
      await page.evaluate("document.fonts.ready");
      await page.screenshot({ path: `test-results/shots/${w}x${h}-top.png` });
      await midWhy(page);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `test-results/shots/${w}x${h}-why.png` });
      await page.locator(".close").scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `test-results/shots/${w}x${h}-close.png` });
    });
  });
}

test.describe("sheen wrap", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("frames across the wrap", async ({ page }) => {
    await page.goto("/");
    await page.evaluate("document.fonts.ready");
    const box = await page.locator("h1").boundingBox();
    for (const t of [0, 500, 1000, 1500, 2000, 2500, 2900, 3000, 3100]) {
      await page.evaluate(`(() => {
        const a = document.querySelector(".sheen").getAnimations()[0];
        a.pause();
        a.currentTime = 300 + ${t};
      })()`);
      await page.screenshot({ path: `test-results/shots/sheen-${t}.png`, clip: box ?? undefined });
    }
  });
});

test.describe("nav without popover", () => {
  for (const [w, h] of [
    [390, 844],
    [320, 640],
  ] as const) {
    test(`at ${w}`, async ({ browser }) => {
      const page = await browser.newPage({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
      await page.route(/\/css\/site\.css$/, async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replaceAll(":popover-open", ":-x-popover-open") });
      });
      await page.route(/\/$/, async (route) => {
        const response = await route.fetch();
        const body = (await response.text()).replace(" popover>", ">").replace(/ popovertarget="[^"]+"/, "");
        await route.fulfill({ response, body });
      });
      await page.goto("/");
      await page.evaluate("document.fonts.ready");
      await page.screenshot({ path: `test-results/shots/nopopover-${w}.png` });
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `test-results/shots/nopopover-${w}-scrolled.png` });
      await page.close();
    });
  }
});

test.describe("forced colors", () => {
  test.use({ viewport: { width: 1440, height: 900 }, forcedColors: "active" });

  test("glass and pills", async ({ page }) => {
    await page.goto("/");
    await page.screenshot({ path: "test-results/shots/forced-top.png" });
    await page.locator(".how").scrollIntoViewIfNeeded();
    await page.screenshot({ path: "test-results/shots/forced-how.png" });
  });
});

test.describe("menu at 390", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("open sheet", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Menu" }).tap();
    await page.waitForTimeout(400);
    await page.screenshot({ path: "test-results/shots/menu-390.png" });
  });
});
