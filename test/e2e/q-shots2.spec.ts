// Temporary: screenshots of the Session Expiry sheet (never merge). Writes test-results/shots/<tag>-*.png.
import { expect, test } from "@playwright/test";

const TAG = process.env.SHOT_TAG ?? "shot";
const SIZES = [
  ["320", { width: 320, height: 640 }],
  ["390", { width: 390, height: 844 }],
  ["430", { width: 430, height: 932 }],
  ["844x390", { width: 844, height: 390 }],
] as const;

test("SHOTS Session Expiry sheet: Set enabled and disabled", async ({ browser }) => {
  const sctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const screen = await sctx.newPage();
  await screen.goto("/s?mode=demo");
  await expect(screen.locator("#typed-code")).toHaveText(/^[A-Z0-9]{3} [A-Z0-9]{3}$/);
  const code = ((await screen.locator("#typed-code").textContent()) ?? "").replace(/\s/g, "");
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const phone = await pctx.newPage();
  await phone.goto(`/a?c=${code}`);
  await phone.getByRole("button", { name: "Approve" }).click();
  await expect(phone.locator("#ends-text")).toHaveText(/^Ends in /);
  await phone.getByRole("button", { name: /Change the Session Expiry$/ }).click();
  const sheet = phone.getByRole("dialog", { name: "Session Expiry" });
  await expect(sheet).toBeVisible();
  const clock = (minutes: number) =>
    phone.evaluate((m) => {
      const t = new Date();
      t.setSeconds(0, 0);
      t.setMinutes(t.getMinutes() + m);
      return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    }, minutes);
  for (const [state, minutes] of [
    ["set-enabled", 3],
    ["set-disabled-past", 0],
  ] as const) {
    await sheet.getByLabel("Expires At").fill(await clock(minutes));
    for (const [size, viewport] of SIZES) {
      await phone.setViewportSize(viewport);
      await phone.waitForTimeout(500);
      await phone.screenshot({ path: `test-results/shots/${TAG}-sheet-${state}-${size}.png` });
    }
  }
  await sctx.close();
  await pctx.close();
});
