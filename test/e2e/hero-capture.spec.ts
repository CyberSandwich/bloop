// Capture for the landing hero (docs/design.md, Hero stage): the demo room screen in Present mode, the horizontal photo
// at 1440 x 828 and 2x, the vertical photo on a phone at 390 x 844 and 3x.
// Run: HERO_CAPTURE=1 npx playwright test hero-capture --project=preview; the PNGs land in test-results/shots/.
import { type Browser, expect, type Page, test } from "@playwright/test";
import { DEMO_ITEMS } from "../../src/shared/demo-catalog.ts";

test.skip(!process.env.HERO_CAPTURE, "capture only: set HERO_CAPTURE=1");

const SHOTS = "test-results/shots";

/** The page's Inter face is loaded and is what the list and the buttons resolve to, never the Arial fallback. */
async function expectRealFont(page: Page) {
  const font = (await page.evaluate(`(async () => {
    await document.fonts.ready;
    const faces = [...document.fonts].filter((f) => f.family.replaceAll('"', "") === "Inter");
    const stack = (s) => getComputedStyle(document.querySelector(s)).fontFamily;
    return {
      statuses: faces.map((f) => f.status),
      check: ["400", "600"].map((w) => document.fonts.check(w + " 16px Inter")),
      item: stack("#items .item"),
      button: stack("button"),
    };
  })()`)) as { statuses: string[]; check: boolean[]; item: string; button: string };
  expect(font.statuses.length, "an Inter face is declared").toBeGreaterThan(0);
  expect(font.statuses, "every Inter face is loaded").toEqual(font.statuses.map(() => "loaded"));
  expect(font.check, "Inter 400 and 600 resolve").toEqual([true, true]);
  expect(font.item).toMatch(/^"?Inter"?,/);
  expect(font.button).toMatch(/^"?Inter"?,/);
}

/** Presenting, the item drawn, and nothing of the chrome left: no controls, no Stop Presenting mid-fade, no toast. */
async function presentAndSettle(page: Page, name: string) {
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
  await expect(page.locator("#frame :is(picture img, canvas, video)").first()).toBeVisible();
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator("body")).toHaveClass(/\bis-presenting\b/);
  for (const part of ["#controls", "#handle", ".bar", "#items"]) await expect(page.locator(part)).toBeHidden();
  // Stop Presenting follows the pointer and a tap shows it for 3 s: wait for it to be gone, then read it once.
  await expect(page.locator("#view")).not.toHaveClass(/\bis-awake\b/, { timeout: 8000 });
  await expect(page.locator("#b-stop")).toHaveCSS("opacity", "0");
  expect(await page.locator(".toast:not(.out)").count(), "a toast is up").toBe(0);
  await page.evaluate(`(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)));
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    document.activeElement?.blur();
  })()`);
  await page.waitForTimeout(800);
}

async function newContext(browser: Browser, phone: boolean) {
  return browser.newContext(
    phone
      ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 }
      : { viewport: { width: 1440, height: 828 }, deviceScaleFactor: 2 },
  );
}

test("the room screen presenting the horizontal photo at 1440 x 828 and 2x", async ({ browser }) => {
  const screenContext = await newContext(browser, false);
  const screen = await screenContext.newPage();
  await screen.goto("/s?mode=demo");
  await expect(screen.locator("#qr")).toBeVisible();
  await expect(screen.locator("#qr-panel")).not.toHaveClass(/\bis-swapping\b/);
  await expect(screen.locator("#typed-code")).toHaveText(/^[A-Z0-9]{3} [A-Z0-9]{3}$/);
  const code = ((await screen.locator("#typed-code").textContent()) ?? "").replace(/\s/g, "");

  const phoneContext = await newContext(browser, true);
  const phone = await phoneContext.newPage();
  await phone.goto(`/a?c=${code}`);
  await phone.getByRole("button", { name: "Approve" }).click();

  // The viewer opens on the deck; the font is read on the list, which Present then hides.
  await expect(screen.getByRole("heading", { level: 1 })).toHaveText(DEMO_ITEMS.deck.name);
  await expectRealFont(screen);
  await screen.locator("#items").getByRole("button", { name: DEMO_ITEMS.horizontal.name }).click();
  await presentAndSettle(screen, DEMO_ITEMS.horizontal.name);
  await screen.screenshot({ path: `${SHOTS}/hero-desktop-2x.png` });
  await screenContext.close();
  await phoneContext.close();
});

test("a phone presenting the vertical photo at 390 x 844 and 3x", async ({ browser }) => {
  const context = await newContext(browser, true);
  const page = await context.newPage();
  await page.goto("/s?mode=demo");
  await page.getByRole("link", { name: "Approve on This Phone" }).click();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(DEMO_ITEMS.deck.name);
  await expectRealFont(page);
  await page.locator("#handle").click();
  await page.locator("#items").getByRole("button", { name: DEMO_ITEMS.vertical.name }).click();
  await presentAndSettle(page, DEMO_ITEMS.vertical.name);
  await page.screenshot({ path: `${SHOTS}/hero-phone-3x.png` });
  await context.close();
});
