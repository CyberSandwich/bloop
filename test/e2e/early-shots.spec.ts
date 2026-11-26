// Throwaway: the landing hero's sheen at rest, while following a mouse and under keyboard focus. Never merged.
import { expect, test } from "@playwright/test";

const SIZES = [
  [320, 568],
  [390, 844],
  [430, 932],
  [844, 390],
] as const;

for (const [width, height] of SIZES) {
  test(`sheen at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await expect(page.locator(".sheen")).toBeVisible();
    await page.waitForTimeout(900);
    const hero = page.locator(".hero");
    await hero.screenshot({ path: `test-results/shots/sheen-${width}x${height}-rest.png` });
    const box = await page.locator(".sheen").boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
      await page.mouse.move(box.x + box.width * 0.32, box.y + box.height / 2);
      await page.waitForTimeout(800);
      await hero.screenshot({ path: `test-results/shots/sheen-${width}x${height}-follow.png` });
    }
    await page.mouse.move(0, height - 1);
    await page.waitForTimeout(800);
    await page.evaluate("document.querySelector('.hero a, .hero button')?.focus()");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(800);
    await hero.screenshot({ path: `test-results/shots/sheen-${width}x${height}-focus.png` });
  });
}
