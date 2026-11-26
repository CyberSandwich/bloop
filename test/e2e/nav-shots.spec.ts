// Throwaway: nav screenshots at the check widths, menu open under 640, and the popover-less fallback at 320. Never merged.
import { test } from "@playwright/test";

const SIZES = [
  [320, 568],
  [390, 844],
  [430, 932],
  [844, 390],
  [834, 1112],
  [1440, 900],
] as const;

for (const [width, height] of SIZES) {
  test(`nav at ${width}x${height}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: `test-results/shots/nav-${width}x${height}.png`,
      clip: { x: 0, y: 0, width, height: Math.min(height, 200) },
    });
    if (width < 640) {
      await page.getByRole("button", { name: "Menu" }).click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `test-results/shots/nav-${width}x${height}-menu.png` });
    }
    await context.close();
  });
}

test("nav fallback row at 320", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.route(/\/$/, async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(" popover>", ">").replace(/ popovertarget="[^"]+"/, "");
    await route.fulfill({ response, body });
  });
  await page.addInitScript(
    `for (const m of ["showPopover", "hidePopover", "togglePopover"]) delete HTMLElement.prototype[m];`,
  );
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: "test-results/shots/nav-320-fallback.png",
    clip: { x: 0, y: 0, width: 320, height: 200 },
  });
  await context.close();
});
