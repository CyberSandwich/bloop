// Throwaway screenshots of the match pick, never merged.
import { type Browser, expect, type Page, test } from "@playwright/test";
import { choice, heading, open, shownMatch, typedCodeOf } from "./pairing.ts";

const VPS = [
  { w: 320, h: 568, phone: true },
  { w: 390, h: 844, phone: true },
  { w: 430, h: 932, phone: true },
  { w: 844, h: 390, phone: true },
  { w: 1440, h: 900, phone: false },
] as const;

const buttons = (page: Page) => page.locator("#pick").getByRole("button");

async function phoneAt(browser: Browser, vp: (typeof VPS)[number], code: string) {
  const context = await browser.newContext({
    viewport: { width: vp.w, height: vp.h },
    isMobile: vp.phone,
    hasTouch: vp.phone,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.goto(`/a?c=${code}`);
  await expect(heading(page)).toHaveText("This Screen");
  await expect(buttons(page)).toHaveCount(3);
  await page.evaluate("document.fonts.ready");
  return { context, page };
}

for (const vp of VPS) {
  test(`match pick shots ${vp.w}x${vp.h}`, async ({ browser }) => {
    test.setTimeout(90_000);
    const dir = `shots/${vp.w}x${vp.h}`;
    const screen = await open(browser, "screen", "/s");
    const code = await typedCodeOf(screen.page);
    const { context, page } = await phoneAt(browser, vp, code);
    await page.screenshot({ path: `${dir}/1-pending.png` });
    const shown = await shownMatch(screen.page);
    await page.route("**/api/match", () => {});
    await choice(page, shown).click();
    await expect(page.locator("#pick legend")).toHaveText("Approving...");
    await page.screenshot({ path: `${dir}/2-tapped.png` });
    await expect(page.locator("#pick .pick-slow")).toHaveText("Still approving. Keep this page open.", { timeout: 8000 });
    await page.screenshot({ path: `${dir}/3-slow.png` });
    await context.close();

    const screen2 = await open(browser, "screen", "/s");
    const second = await phoneAt(browser, vp, await typedCodeOf(screen2.page));
    const right = await shownMatch(screen2.page);
    await expect(buttons(second.page)).toHaveCount(3);
    const digits = await buttons(second.page).allTextContents();
    await choice(second.page, digits.map((d) => d.trim()).find((d) => d !== right) ?? "").click();
    await expect(heading(second.page)).toHaveText("That Wasn't the Screen's Number");
    await second.page.screenshot({ path: `${dir}/4-wrong.png` });
    await second.page.reload();
    await expect(heading(second.page)).toHaveText("Scan the Code");
    await second.page.screenshot({ path: `${dir}/5-pairing-invalid.png` });
    await second.context.close();
    await screen.context.close();
    await screen2.context.close();
  });
}
