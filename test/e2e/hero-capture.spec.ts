// Capture for the landing hero (docs/design.md, Hero stage): the demo viewer with Dog.jpg, desktop at 1440 x 828 and
// 2x, and the phone at 390 x 844 and 3x, in Chromium and WebKit.
// Run: HERO_CAPTURE=1 npx playwright test hero-capture --project=preview; the PNGs land in test-results/shots/.
import { type Browser, type BrowserContext, chromium, expect, type Page, test, webkit } from "@playwright/test";

test.skip(!process.env.HERO_CAPTURE, "capture only: set HERO_CAPTURE=1");

const ENGINES = { chromium, webkit } as const;
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

/** Nothing moving, no focus, no toast, the fonts and images in. */
async function settle(page: Page) {
  expect(await page.locator(".toast:not(.out)").count(), "a toast is up").toBe(0);
  await page.evaluate(`(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)));
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    document.activeElement?.blur();
  })()`);
  await expectRealFont(page);
  await page.waitForTimeout(800);
}

async function newContext(browser: Browser, baseURL: string | undefined, phone: boolean): Promise<BrowserContext> {
  return browser.newContext({
    ...(baseURL ? { baseURL } : {}),
    ...(phone
      ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 }
      : { viewport: { width: 1440, height: 828 }, deviceScaleFactor: 2 }),
  });
}

for (const [name, engine] of Object.entries(ENGINES)) {
  test(`${name}: the demo viewer with Dog.jpg at 1440 x 828 and 2x`, async ({ baseURL }) => {
    const browser = await engine.launch();
    const screenContext = await newContext(browser, baseURL, false);
    const screen = await screenContext.newPage();
    await screen.goto("/s?mode=demo");
    await expect(screen.locator("#qr")).toBeVisible();
    await expect(screen.locator("#qr-panel")).not.toHaveClass(/\bis-swapping\b/);
    await expect(screen.locator("#typed-code")).toHaveText(/^[A-Z0-9]{3} [A-Z0-9]{3}$/);
    const code = ((await screen.locator("#typed-code").textContent()) ?? "").replace(/\s/g, "");

    const phoneContext = await newContext(browser, baseURL, true);
    const phone = await phoneContext.newPage();
    await phone.goto(`/a?c=${code}`);
    await phone.getByRole("button", { name: "Approve" }).click();

    await expect(screen.getByRole("heading", { level: 1 })).toHaveText("Dog.jpg");
    await expect(screen.getByRole("img", { name: "Dog.jpg" })).toBeVisible();
    await expect(screen.getByRole("button", { name: "Present" })).toBeVisible();
    await settle(screen);
    await screen.screenshot({ path: `${SHOTS}/hero-${name}-2x.png` });
    // The list and the buttons at 100 percent of the device pixels (840 x 1656), where the type is judged.
    await screen.screenshot({
      path: `${SHOTS}/hero-${name}-ui-crop.png`,
      clip: { x: 0, y: 0, width: 420, height: 828 },
    });
    await browser.close();
  });

  test(`${name}: the demo viewer on a phone at 390 x 844 and 3x, Dog.jpg showing`, async ({ baseURL }) => {
    const browser = await engine.launch();
    const context = await newContext(browser, baseURL, true);
    const page = await context.newPage();
    await page.goto("/s?mode=demo");
    await page.getByRole("link", { name: "Approve on This Phone" }).click();
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dog.jpg");
    await expect(page.getByRole("img", { name: "Dog.jpg" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Present", exact: true })).toBeVisible();
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/hero-${name}-phone-3x.png` });
    await browser.close();
  });
}
