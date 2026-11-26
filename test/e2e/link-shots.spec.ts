import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

const SIZES = [
  [390, 844],
  [1440, 900],
  [844, 390],
] as const;

for (const [width, height] of SIZES) {
  test(`pill shot ${width}`, async ({ browser }) => {
    mkdirSync("test-results/shots", { recursive: true });
    const screenContext = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
    await screenContext.addInitScript("window.open = () => null;");
    const screen = await screenContext.newPage();
    await screen.goto("/s?mode=demo");
    await expect(screen.locator("#typed-code")).toHaveText(/^[A-Z0-9]{3} [A-Z0-9]{3}$/);
    const code = ((await screen.locator("#typed-code").textContent()) ?? "").replace(/\s/g, "");
    const phoneContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    });
    const phone = await phoneContext.newPage();
    await phone.goto(`/a?c=${code}`);
    await phone.getByRole("button", { name: /^Approve, code \d{2} on the screen$/ }).click();
    await expect(phone.getByRole("group", { name: "The Screen" })).toBeVisible();
    await phone.locator("#file-list").getByRole("link", { name: /^Vevox/ }).click();
    await expect(screen.locator("#b-link")).toBeVisible();
    await expect(phone.locator(".toast:not(.out)")).toContainText("Tap Open on the Screen");
    await screen.waitForTimeout(600);
    await screen.screenshot({ path: `test-results/shots/pill-screen-${width}x${height}.png` });
    if (width === 390) await phone.screenshot({ path: "test-results/shots/pill-phone-390.png" });
    await screenContext.close();
    await phoneContext.close();
  });
}
