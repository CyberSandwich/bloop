// Throwaway: screenshots for ci/p1-tapfix, never merged.
import { expect, type Page, test } from "@playwright/test";
import { atRest, oneDevice, pick } from "./one-device.ts";

const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/shots/${name}.png` });

/** Holds the cross-fade at its middle frame. */
async function midFade(page: Page) {
  await expect
    .poll(() => page.evaluate('document.querySelectorAll("#frame > *").length'), { timeout: 5000 })
    .toBe(2);
  await page.evaluate(
    '(() => { for (const a of document.getAnimations()) { if (a.effect && a.effect.getTiming().duration === 200) { a.pause(); a.currentTime = 100; } } })()',
  );
}

for (const vp of [
  { width: 320, height: 640 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 844, height: 390 },
]) {
  test.describe(`${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp, hasTouch: true, isMobile: true });
    test("sheet, dismiss, mid cross-fade", async ({ page }) => {
      const n = `${vp.width}x${vp.height}`;
      if (vp.width < 600) await oneDevice(page);
      else {
        await page.goto("/s?mode=demo");
        await page.getByRole("link", { name: "Approve on This Device" }).tap();
        await page.getByRole("button", { name: "Approve" }).tap();
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dog.jpg");
      }
      await atRest(page.locator("main"));
      const rail = vp.width >= 760;
      if (!rail) await page.locator("#handle").tap();
      await page
        .locator("#items")
        .getByRole("button", { name: /^Sample deck\.pptx/ })
        .tap();
      await midFade(page);
      console.log(
        "MID",
        n,
        JSON.stringify(
          await page.evaluate(
            '[...document.querySelectorAll("#frame > *")].map((x) => { const f = x.localName === "picture" ? x.querySelector("img") : x; return [x.localName, x.className, x.inert, getComputedStyle(f).opacity, f.getAnimations().map((a) => a.playState + ":" + a.currentTime + "/" + a.effect.getTiming().duration)]; })',
          ),
        ),
      );
      await shot(page, `${n}-1-midfade-photo-to-deck`);
      await atRest(page.locator("main"));
      await page.waitForTimeout(300);
      if (rail) {
        await shot(page, `${n}-2-deck-settled`);
        return;
      }
      await page.locator("#handle").tap();
      await page.waitForTimeout(500);
      await shot(page, `${n}-2-sheet-open`);
      const box = await page.locator("#frame picture img").boundingBox();
      const side = await page.locator("#side").boundingBox();
      if (box && side) await page.touchscreen.tap(box.x + box.width * 0.9, (box.y + Math.min(box.y + box.height, side.y)) / 2);
      await page.waitForTimeout(500);
      await shot(page, `${n}-3-after-outside-tap`);
      await pick(page, "Sample deck.pdf");
      await atRest(page.locator("main"));
      await shot(page, `${n}-4-pdf-settled`);
    });
  });
}
