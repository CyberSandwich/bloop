import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

for (const path of ["/", "/no-such-page"]) {
  test.describe(path, () => {
    test("has no axe violations", async ({ page }) => {
      await page.goto(path);
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations).toEqual([]);
    });

    test("reports no CSP violation", async ({ page }) => {
      const violations: string[] = [];
      page.on("console", (message) => {
        if (message.text().includes("Content Security Policy")) violations.push(message.text());
      });
      await page.goto(path);
      expect(violations).toEqual([]);
    });
  });
}
