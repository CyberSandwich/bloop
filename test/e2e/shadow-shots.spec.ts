// Throwaway: the demo viewer's bottom handle and /a's button panel at the check widths. Never merged.
import { expect, test } from "@playwright/test";

const SIZES = [
  [320, 700],
  [390, 844],
  [430, 932],
  [844, 390],
] as const;

for (const [width, height] of SIZES) {
  test(`viewer and approve at ${width}x${height}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 3 });
    const page = await context.newPage();
    await page.goto("/s?mode=demo");
    await page
      .getByRole("link", { name: /^Approve on This (Phone|Device)$/ })
      .filter({ visible: true })
      .first()
      .click();
    await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `test-results/shots/approve-${width}x${height}.png` });
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dog.jpg");
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `test-results/shots/viewer-${width}x${height}.png` });
    const bottom = Math.min(height, 160);
    await page.screenshot({
      path: `test-results/shots/viewer-${width}x${height}-bottom.png`,
      clip: { x: 0, y: height - bottom, width, height: bottom },
    });
    await context.close();
  });
}
