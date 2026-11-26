// Throwaway: screenshots of /s and /a for a by-eye look; never merged.
import { mkdirSync } from "node:fs";
import { type Browser, expect, test } from "@playwright/test";

const SCREENS = [
  [1180, 820],
  [1024, 768],
  [834, 1112],
  [1366, 1024],
  [1440, 900],
  [844, 390],
  [932, 430],
  [667, 330],
  [1080, 1920],
] as const;

const code = async (page: import("@playwright/test").Page) => {
  await expect(page.locator("#typed-code")).toHaveText(/^[A-Z0-9]{3} [A-Z0-9]{3}$/);
  return ((await page.locator("#typed-code").textContent()) ?? "").replace(/\s/g, "");
};

for (const [width, height] of SCREENS) {
  test(`shot s ${width}x${height}`, async ({ browser }) => {
    mkdirSync("test-results/shots", { recursive: true });
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto("/s?mode=demo");
    const c = await code(page);
    await page.evaluate("document.fonts.ready.then(() => true)");
    await page.waitForTimeout(400);
    await page.screenshot({ path: `test-results/shots/s-${width}x${height}-waiting.png` });
    const phone = await phoneAt(browser, 390, 844);
    await phone.goto(`/a?c=${c}`);
    await expect(page.locator("#match")).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `test-results/shots/s-${width}x${height}-claimed.png` });
    await phone.context().close();
    await context.close();
  });
}

async function phoneAt(browser: Browser, width: number, height: number) {
  const context = await browser.newContext({
    viewport: { width, height },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  return context.newPage();
}

for (const [width, height] of [
  [320, 640],
  [390, 844],
  [430, 932],
  [844, 390],
] as const) {
  test(`shot a ${width}x${height}`, async ({ browser }) => {
    mkdirSync("test-results/shots", { recursive: true });
    const screen = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await screen.goto("/s?mode=demo");
    const c = await code(screen);
    const phone = await phoneAt(browser, width, height);
    await phone.goto(`/a?c=${c}`);
    await phone.getByRole("button", { name: /^Approve, code/ }).click();
    await expect(phone.getByRole("button", { name: "Revoke" })).toBeVisible();
    await phone.evaluate("document.fonts.ready.then(() => true)");
    await phone.waitForTimeout(600);
    await phone.screenshot({ path: `test-results/shots/a-${width}x${height}-approved.png` });
    await phone.locator("#ends").click();
    await expect(phone.locator("#length")).toBeVisible();
    await phone.waitForTimeout(600);
    await phone.screenshot({ path: `test-results/shots/a-${width}x${height}-expiry.png` });
    await phone.context().close();
    await screen.context().close();
  });
}
