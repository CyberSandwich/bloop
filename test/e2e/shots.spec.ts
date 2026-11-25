import { mkdirSync, writeFileSync } from "node:fs";
import { type Page, test } from "@playwright/test";

const VPS = [
  { w: 320, h: 568, phone: true },
  { w: 390, h: 844, phone: true },
  { w: 430, h: 932, phone: true },
  { w: 844, h: 390, phone: true },
  { w: 1440, h: 900, phone: false },
] as const;
const PAGES = [
  ["landing", "/"],
  ["article", "/articles/how-bloop-works"],
  ["privacy", "/privacy"],
  ["terms", "/terms"],
  ["accessibility", "/accessibility"],
] as const;

// The why with its top at the view's center (0), midway (0.5) and its bottom at the center (1).
const whyAt = async (page: Page, progress: number, path: string) => {
  await page.evaluate(`(() => {
    const r = document.querySelector(".why p").getBoundingClientRect();
    scrollBy(0, r.top - (innerHeight / 2 - ${progress} * r.height));
  })()`);
  await page.waitForTimeout(500);
  await page.screenshot({ path });
};

for (const vp of VPS) {
  test.describe(`shots ${vp.w}x${vp.h}`, () => {
    test.use({ viewport: { width: vp.w, height: vp.h }, isMobile: vp.phone, hasTouch: vp.phone, deviceScaleFactor: 2 });
    const dir = `test-results/shots/${vp.w}x${vp.h}`;
    for (const [name, path] of PAGES) {
      test(`${name}`, async ({ page }) => {
        await page.goto(path);
        await page.evaluate("document.fonts.ready");
        await page.screenshot({ path: `${dir}/${name}-top.png` });
        await page.screenshot({ path: `${dir}/${name}-full.png`, fullPage: true });
        if (name === "landing") {
          if (vp.w === 1440) {
            for (let k = 0; k < 5; k++) {
              await page.evaluate(
                `(() => { const a = document.querySelector(".sheen").getAnimations()[0]; a.pause(); a.currentTime = 300 + ${k} * 400; })()`,
              );
              await page.locator(".hero h1").screenshot({ path: `${dir}/sheen-${k}.png` });
            }
            const sizes = await page.evaluate(
              `(() => { const el = document.querySelector(".sheen"); return { word: el.getBoundingClientRect().width, tile: getComputedStyle(el).backgroundSize, font: getComputedStyle(el).fontSize }; })()`,
            );
            writeFileSync(`${dir}/sheen-sizes.json`, JSON.stringify(sizes));
            await page.evaluate(`document.querySelector(".sheen").getAnimations()[0].play()`);
          }
          await page.waitForLoadState("load");
          const imgs = await page.evaluate(
            `[...document.querySelectorAll("img")].map((i) => ({ file: i.src, currentSrc: i.currentSrc, loading: i.loading, top: Math.round(i.getBoundingClientRect().top), fold: innerHeight, dpr: devicePixelRatio }))`,
          );
          const log = JSON.stringify(imgs, null, 1);
          console.log(`IMAGES ${vp.w}x${vp.h} ${log}`);
          mkdirSync(dir, { recursive: true });
          writeFileSync(`${dir}/landing-images.json`, log);
          await page.locator(".steps").scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${dir}/landing-steps.png` });
          await page.locator("#features").screenshot({ path: `${dir}/landing-features.png` });
          await page.locator("#features .grid").scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${dir}/landing-features-view.png` });
          for (const [k, p] of [
            ["top", 0],
            ["mid", 0.5],
            ["bottom", 1],
          ] as const)
            await whyAt(page, p, `${dir}/landing-why-${k}.png`);
          await page.evaluate("scrollTo(0, 0)");
          const menu = page.getByRole("button", { name: "Menu" });
          if (await menu.isVisible()) {
            await menu.tap();
            await page.waitForTimeout(400);
            await page.screenshot({ path: `${dir}/landing-menu.png` });
          }
        }
        if (name === "privacy") {
          await page.locator("#processors").scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${dir}/privacy-processors.png` });
          await page.locator("#retention").scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${dir}/privacy-retention.png` });
        }
        if (name === "terms") {
          await page.locator('a.num[href="#8.3"]').scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${dir}/terms-clauses.png` });
        }
      });
    }
    if (vp.w < 760) {
      test("fallback nav", async ({ page }) => {
        await page.route(/\/css\/site\.css$/, async (route) => {
          const response = await route.fetch();
          await route.fulfill({
            response,
            body: (await response.text()).replaceAll(":popover-open", ":-x-popover-open"),
          });
        });
        await page.route(/\/$/, async (route) => {
          const response = await route.fetch();
          const body = (await response.text()).replace(" popover>", ">").replace(/ popovertarget="[^"]+"/, "");
          await route.fulfill({ response, body });
        });
        await page.goto("/");
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${dir}/fallback-nav-top.png` });
        await page.evaluate("scrollTo(0, 1400)");
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${dir}/fallback-nav-scrolled.png` });
      });
    }
  });
}
