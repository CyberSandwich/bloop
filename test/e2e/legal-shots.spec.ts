// Temporary, ci/legal-v33 only: screenshots for the design walk while the local browser is unavailable.
import { test } from "@playwright/test";

for (const width of [1440, 834, 600, 390]) {
  test.describe(`shots ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });
    for (const path of ["/privacy", "/terms", "/security"]) {
      test(`${path} at ${width}`, async ({ page }) => {
        await page.goto(path);
        await page.evaluate("document.fonts.ready");
        await page.screenshot({ path: `test-results/legal-shots/${path.slice(1)}-${width}-full.png`, fullPage: true });
        await page.evaluate("scrollTo(0, 1400)");
        await page.waitForTimeout(300);
        await page.screenshot({ path: `test-results/legal-shots/${path.slice(1)}-${width}-mid.png` });
      });
    }
  });
}

test("hover, copied and print", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/terms#8.3");
  await page.locator('p[id="8.2"]').hover();
  await page.locator('a.num[href="#8.3"]').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/legal-shots/terms-hover-copied.png" });
  for (const p of ["privacy", "terms", "security"]) {
    await page.goto(`/${p}`);
    await page.pdf({ path: `test-results/legal-shots/${p}-print.pdf`, format: "A4" });
  }
});
