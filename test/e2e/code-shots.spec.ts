import { mkdirSync } from "node:fs";
import { test } from "@playwright/test";

const SIZES = [
  [320, 568],
  [390, 844],
  [430, 932],
  [1440, 900],
  [844, 390],
] as const;

for (const [width, height] of SIZES) {
  test(`shot ${width}`, async ({ browser }) => {
    mkdirSync("test-results/shots", { recursive: true });
    const context = await browser.newContext({
      viewport: { width, height },
      isMobile: width < 900,
      hasTouch: width < 900,
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.goto("/code");
    await page.evaluate("document.fonts.ready");
    await page.screenshot({ path: `test-results/shots/code-${width}x${height}-empty.png` });
    await page.locator("#code").fill("k7mq9x");
    await page.screenshot({ path: `test-results/shots/code-${width}x${height}-filled.png` });
    await page.locator("#code").fill("K7O");
    await page.screenshot({ path: `test-results/shots/code-${width}x${height}-error.png` });
    await context.close();
  });
}
