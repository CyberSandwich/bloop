// Temporary: screenshots for the site stream's CSS move (never merge). Writes test-results/shots/<tag>-*.png.
import { expect, test } from "@playwright/test";

const TAG = "after";
const SIZES = [
  ["320", { width: 320, height: 640 }],
  ["390", { width: 390, height: 844 }],
  ["430", { width: 430, height: 932 }],
  ["844x390", { width: 844, height: 390 }],
  ["834", { width: 834, height: 1112 }],
  ["1440", { width: 1440, height: 900 }],
] as const;

test.use({ reducedMotion: "reduce" });

for (const [path, name] of [
  ["/", "landing"],
  ["/privacy", "privacy"],
] as const) {
  test(`SHOTS preview ${name}`, async ({ page }) => {
    await page.goto(path);
    for (const [size, viewport] of SIZES) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `test-results/shots/${TAG}-${name}-${size}.png`, animations: "disabled" });
      if (name === "landing")
        await page.screenshot({
          path: `test-results/shots/${TAG}-${name}-full-${size}.png`,
          fullPage: true,
          animations: "disabled",
        });
    }
  });
}

test("SHOTS app pages at 390", async ({ browser }) => {
  const sctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const screen = await sctx.newPage();
  await screen.goto("/s?mode=demo");
  await expect(screen.locator("#typed-code")).toHaveText(/^[A-Z0-9]{3} [A-Z0-9]{3}$/);
  const code = ((await screen.locator("#typed-code").textContent()) ?? "").replace(/\s/g, "");
  const pctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
  });
  const phone = await pctx.newPage();
  await phone.goto(`/a?c=${code}`);
  await expect(phone.getByRole("button", { name: "Approve" })).toBeEnabled();
  await phone.waitForTimeout(500);
  await phone.screenshot({ path: `test-results/shots/${TAG}-phone-approve-390.png`, animations: "disabled" });
  await screen.setViewportSize({ width: 390, height: 844 });
  await screen.waitForTimeout(500);
  await screen.screenshot({ path: `test-results/shots/${TAG}-screen-390.png`, animations: "disabled" });
  await sctx.close();
  await pctx.close();
});
