// Capture for the landing hero (docs/design.md, Hero stage): the demo viewer with the horizontal photo at 1440 x 828, 2x.
// Run: HERO_CAPTURE=1 npx playwright test hero-capture --project=preview; the PNG lands in test-results/shots/.
import { expect, test } from "@playwright/test";
import { DEMO_ITEMS } from "../../src/shared/demo-catalog.ts";

test.skip(!process.env.HERO_CAPTURE, "capture only: set HERO_CAPTURE=1");

test("the demo viewer with the horizontal photo, settled, at 1440 x 828 and 2x", async ({ browser }) => {
  const screenContext = await browser.newContext({ viewport: { width: 1440, height: 828 }, deviceScaleFactor: 2 });
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
    deviceScaleFactor: 3,
  });
  const phone = await phoneContext.newPage();
  await phone.goto(`/a?c=${code}`);
  await phone.getByRole("button", { name: "Approve" }).click();

  // The viewer opens on the deck; the capture is of the photo.
  await expect(screen.getByRole("heading", { level: 1 })).toHaveText(DEMO_ITEMS.deck.name);
  await screen.locator("#items").getByRole("button", { name: DEMO_ITEMS.horizontal.name }).click();
  await expect(screen.getByRole("heading", { level: 1 })).toHaveText(DEMO_ITEMS.horizontal.name);
  await expect(screen.getByRole("img", { name: DEMO_ITEMS.horizontal.name })).toBeVisible();
  await expect(screen.getByRole("button", { name: "Present" })).toBeVisible();
  expect(await screen.locator(".toast:not(.out)").count(), "a toast is up").toBe(0);
  await screen.evaluate(`(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)));
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    document.activeElement?.blur();
  })()`);
  await screen.waitForTimeout(800);
  await screen.screenshot({ path: "test-results/shots/hero-dog-2x.png" });
  await screenContext.close();
  await phoneContext.close();
});
