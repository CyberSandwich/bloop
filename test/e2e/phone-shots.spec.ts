// Throwaway: the phone list with a long file name (shots branches only, never merged). Saved under test-results/shots/.
import { expect, test } from "@playwright/test";

for (const width of [320, 390]) {
  test(`shot phone list long name ${width}`, async ({ browser }) => {
    const screenContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const screen = await screenContext.newPage();
    await screen.goto("/s?mode=demo");
    await expect(screen.locator("#typed-code")).toHaveText(/^[A-Z0-9]{3} [A-Z0-9]{3}$/);
    const code = ((await screen.locator("#typed-code").textContent()) ?? "").replace(/\s/g, "");
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    });
    const phone = await context.newPage();
    await phone.goto(`/a?c=${code}`);
    await phone.locator("#file-list li:has(input) .row-name").first().waitFor();
    await phone.evaluate(
      `document.querySelector("#file-list li:has(input) .row-name .head").textContent = "Introduction to Corporate Financial Reporting Week 5 of the long module name"`,
    );
    await phone.waitForTimeout(300);
    await phone.screenshot({ path: `test-results/shots/phone-${width}.png`, fullPage: true });
    await context.close();
    await screenContext.close();
  });
}
