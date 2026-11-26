// Throwaway: landing hero screenshots at the check widths. Never merged.
import { test } from "@playwright/test";

const SIZES = [
  [320, 568],
  [390, 844],
  [430, 932],
  [844, 390],
  [834, 1112],
  [1440, 900],
] as const;
const TAG = process.env.SHOT_TAG ?? "x";

for (const [width, height] of SIZES) {
  test(`landing hero at ${width}x${height}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    await page.locator(".stage img").evaluate((img: HTMLImageElement) => img.decode());
    await page.screenshot({ path: `test-results/shots/${TAG}-${width}x${height}-top.png` });
    await page.evaluate(() => {
      const r = document.querySelector(".stage")?.getBoundingClientRect();
      if (r) window.scrollBy(0, r.top - Math.max(0, (innerHeight - r.height) / 2) + 0);
    });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `test-results/shots/${TAG}-${width}x${height}-stage.png` });
    await context.close();
  });
}
