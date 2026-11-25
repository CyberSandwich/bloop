import { test } from "@playwright/test";

const VPS = [
  { w: 320, h: 568 },
  { w: 390, h: 844 },
  { w: 430, h: 932 },
  { w: 844, h: 390 },
] as const;
const PAGES = [
  ["landing", "/"],
  ["article", "/articles/how-bloop-works"],
  ["privacy", "/privacy"],
  ["terms", "/terms"],
] as const;

for (const vp of VPS) {
  test.describe(`shots ${vp.w}x${vp.h}`, () => {
    test.use({ viewport: { width: vp.w, height: vp.h }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    for (const [name, path] of PAGES) {
      test(`${name}`, async ({ page }) => {
        await page.goto(path);
        await page.evaluate("document.fonts.ready");
        const dir = `test-results/shots/${vp.w}x${vp.h}`;
        await page.screenshot({ path: `${dir}/${name}-top.png` });
        await page.screenshot({ path: `${dir}/${name}-full.png`, fullPage: true });
        if (name === "landing") {
          await page.locator(".steps").scrollIntoViewIfNeeded();
          await page.locator(".steps").screenshot({ path: `${dir}/landing-steps.png` });
          await page.evaluate("scrollTo(0, 0)");
          const menu = page.getByRole("button", { name: "Menu" });
          if (await menu.isVisible()) {
            await menu.tap();
            await page.waitForTimeout(400);
            await page.screenshot({ path: `${dir}/landing-menu.png` });
          }
        }
        if (name === "privacy") {
          await page.locator("#processors").scrollIntoViewIfNeeded();
          await page.locator("#processors").screenshot({ path: `${dir}/privacy-processors.png` });
          await page.locator("#data").screenshot({ path: `${dir}/privacy-data.png` });
        }
        if (name === "terms") {
          await page.locator("#guest-files").screenshot({ path: `${dir}/terms-guest-files.png` });
          await page.locator('a.num[href="#8.3"]').click();
          await page.waitForTimeout(300);
          await page.screenshot({ path: `${dir}/terms-copied.png` });
          await page.waitForTimeout(3500);
          await page.screenshot({ path: `${dir}/terms-copied-gone.png` });
        }
      });
    }
  });
}
