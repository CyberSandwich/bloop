// Temporary: the 2 h preset and the Capped toast (never merge). Writes test-results/shots/<tag>-*.png.
import { expect, test } from "@playwright/test";

const TAG = process.env.SHOT_TAG ?? "shot";
const SIZES = [
  ["320", { width: 320, height: 640 }],
  ["390", { width: 390, height: 844 }],
  ["430", { width: 430, height: 932 }],
  ["844x390", { width: 844, height: 390 }],
] as const;

for (const [size, viewport] of SIZES) {
  test(`SHOTS Session Expiry 2 h and Capped toast at ${size}`, async ({ browser }) => {
    const sctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const screen = await sctx.newPage();
    await screen.goto("/s?mode=demo");
    await expect(screen.locator("#typed-code")).toHaveText(/^[A-Z0-9]{3} [A-Z0-9]{3}$/);
    const code = ((await screen.locator("#typed-code").textContent()) ?? "").replace(/\s/g, "");
    const pctx = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const phone = await pctx.newPage();
    await phone.goto(`/a?c=${code}`);
    await phone.getByRole("button", { name: "Approve" }).click();
    await expect(phone.locator("#ends-text")).toHaveText(/^Ends in /);
    await phone.route("**/api/session/length", async (route) => {
      const response = await route.fetch();
      const view = await response.json();
      await route.fulfill({ response, json: { ...view, endsAt: view.now + 3600_000 } });
    });
    await phone.getByRole("button", { name: /Change the Session Expiry$/ }).click();
    const sheet = phone.getByRole("dialog", { name: "Session Expiry" });
    await expect(sheet).toBeVisible();
    await phone.waitForTimeout(500);
    await phone.screenshot({ path: `test-results/shots/${TAG}-sheet-2h-open-${size}.png` });
    await sheet.getByRole("button", { name: "2 hours" }).click();
    await expect(phone.getByText(/^Capped at \d{2}:\d{2}$/)).toBeVisible();
    await phone.waitForTimeout(500);
    await phone.screenshot({ path: `test-results/shots/${TAG}-capped-toast-${size}.png` });
    await sctx.close();
    await pctx.close();
  });
}
