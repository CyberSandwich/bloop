// Throwaway: screenshots of the demo screen with the new sample deck and its PDF, and the phone's list. Never merged.
import { expect, test } from "@playwright/test";

const SIZES = [
  [1440, 900],
  [390, 844],
] as const;

for (const [width, height] of SIZES) {
  test(`the demo deck and PDF on the screen at ${width}`, async ({ browser }) => {
    const screenContext = await browser.newContext({ viewport: { width, height } });
    const screen = await screenContext.newPage();
    await screen.goto("/s?mode=demo");
    await expect(screen.locator("#qr")).toBeVisible();
    await expect(screen.locator("#qr-panel")).not.toHaveClass(/\bis-swapping\b/);
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
    await phone.getByRole("button", { name: "Approve" }).click();
    await expect(screen.locator("#items > li .item")).toHaveCount(4);

    const row = (name: string) => screen.locator("#items").getByRole("button", { name: new RegExp(`^${name}`) });
    await row("Sample deck.pptx").click();
    await expect(screen.getByRole("img", { name: /^Slide 1 of 7$/ })).toBeVisible();
    await screen.waitForTimeout(600);
    await screen.screenshot({ path: `test-results/shots/deck-${width}-slide1.png` });
    for (let n = 2; n <= 7; n++) {
      await screen.getByRole("button", { name: "Next Slide" }).click();
      await expect(screen.getByRole("img", { name: new RegExp(`^Slide ${n} of 7$`) })).toBeVisible();
      await screen.waitForTimeout(400);
      if (n === 4 || n === 7) await screen.screenshot({ path: `test-results/shots/deck-${width}-slide${n}.png` });
    }
    await row("Sample deck.pdf").click();
    await expect(screen.getByRole("img", { name: /^Page 1 of 7$/ })).toBeVisible();
    await screen.waitForTimeout(600);
    await screen.screenshot({ path: `test-results/shots/pdf-${width}.png` });

    if (width === 390) {
      await phone.waitForTimeout(600);
      await phone.screenshot({ path: "test-results/shots/phone-list-390.png" });
      await phone.screenshot({ path: "test-results/shots/phone-list-390-full.png", fullPage: true });
    }
    await screenContext.close();
    await phoneContext.close();
  });
}
