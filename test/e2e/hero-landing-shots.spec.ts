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
    // The Why paragraph: its top at 85% of the view (just started), at 55%, and its bottom at the center (done).
    for (const [name, place] of [
      ["start", "innerHeight * 0.85"],
      ["mid", "innerHeight * 0.55"],
      ["end", "innerHeight / 2 - r.height"],
    ] as const) {
      await page.evaluate(`(() => {
        const r = document.querySelector(".why p").getBoundingClientRect();
        scrollBy(0, r.top - (${place}));
      })()`);
      await page.waitForTimeout(600);
      await page.screenshot({ path: `test-results/shots/${TAG}-${width}x${height}-why-${name}.png` });
    }
    await context.close();
  });
}
