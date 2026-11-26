// Throwaway: screenshots of the demo screen with each demo item, and the phone's list. Never merged.
import { expect, test } from "@playwright/test";

const SIZES = [
  [1440, 900],
  [390, 844],
] as const;

for (const [width, height] of SIZES) {
  test(`every demo item on the screen at ${width}`, async ({ browser }) => {
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
    if (width === 1440) {
      await phone.waitForTimeout(500);
      await phone.screenshot({ path: "test-results/shots/phone-choose-390.png", fullPage: true });
    }
    await phone.getByRole("button", { name: "Approve" }).click();
    await expect(screen.locator("#items > li .item")).toHaveCount(4);

    const pick = async (name: string) => {
      if (width < 760) await screen.locator("#handle").click();
      await screen.locator("#items").getByRole("button", { name: new RegExp(`^${name}`) }).click();
    };
    await screen.waitForTimeout(800);
    await screen.screenshot({ path: `test-results/shots/open-${width}.png` });
    if (width < 760) {
      await screen.locator("#handle").click();
      await screen.waitForTimeout(600);
      await screen.screenshot({ path: `test-results/shots/sheet-${width}.png` });
      await screen.locator("#handle").click();
    }
    await pick("Deck.pptx");
    await expect(screen.getByRole("img", { name: /^Slide 1 of 5$/ })).toBeVisible();
    await screen.waitForTimeout(600);
    await screen.screenshot({ path: `test-results/shots/deck-${width}-slide1.png` });
    for (let n = 2; n <= 5; n++) {
      await screen.getByRole("button", { name: "Next Slide" }).click();
      await expect(screen.getByRole("img", { name: new RegExp(`^Slide ${n} of 5$`) })).toBeVisible();
      await screen.waitForTimeout(400);
      if (n === 3 || n === 5) await screen.screenshot({ path: `test-results/shots/deck-${width}-slide${n}.png` });
    }
    await pick("Horizontal.jpg");
    await expect(screen.getByRole("img", { name: "Horizontal.jpg" })).toBeVisible();
    await screen.waitForTimeout(800);
    await screen.screenshot({ path: `test-results/shots/horizontal-${width}.png` });
    await pick("Vertical.jpg");
    await expect(screen.getByRole("img", { name: "Vertical.jpg" })).toBeVisible();
    await screen.waitForTimeout(1200);
    await screen.screenshot({ path: `test-results/shots/vertical-${width}.png` });
    await screen.getByRole("button", { name: "Present" }).click();
    await screen.waitForTimeout(800);
    await screen.screenshot({ path: `test-results/shots/vertical-${width}-present.png` });

    if (width === 390) {
      await phone.waitForTimeout(600);
      await phone.screenshot({ path: "test-results/shots/phone-list-390.png" });
      await phone.screenshot({ path: "test-results/shots/phone-list-390-full.png", fullPage: true });
    }
    await screenContext.close();
    await phoneContext.close();
  });
}
