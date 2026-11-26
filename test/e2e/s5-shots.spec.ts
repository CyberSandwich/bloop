// Temporary: screenshots for the open-mode site pages (never merge). Writes test-results/shots/<mode>-<in|out>-<page>-<size>.png.
import { test } from "./mode.ts";

const SIZES = [
  ["320", { width: 320, height: 640 }],
  ["390", { width: 390, height: 844 }],
  ["430", { width: 430, height: 932 }],
  ["844x390", { width: 844, height: 390 }],
  ["834", { width: 834, height: 1112 }],
  ["1440", { width: 1440, height: 900 }],
] as const;
const PAGES = {
  preview: [["/", "landing"]],
  open: [
    ["/", "landing"],
    ["/articles/features", "features"],
    ["/security", "security"],
    ["/privacy", "privacy"],
    ["/terms", "terms"],
    ["/articles", "articles"],
    ["/no-such-page", "404"],
  ],
} as const;

test.use({ reducedMotion: "reduce" });

for (const signedIn of [false, true]) {
  test(`SHOTS ${signedIn ? "in" : "out"}`, async ({ page, context, mode }) => {
    test.skip(signedIn && mode === "preview", "preview has no pill to compare");
    if (signedIn) await context.addCookies([{ name: "__Host-bloop_in", value: "1", url: "https://localhost:8787/" }]);
    for (const [path, name] of PAGES[mode]) {
      await page.goto(path);
      for (const [size, viewport] of SIZES) {
        await page.setViewportSize(viewport);
        await page.waitForTimeout(400);
        const file = `test-results/shots/${mode}-${signedIn ? "in" : "out"}-${name}-${size}`;
        await page.screenshot({ path: `${file}.png`, animations: "disabled" });
        if (name === "landing")
          await page.screenshot({ path: `${file}-full.png`, fullPage: true, animations: "disabled" });
      }
    }
  });
}

test("SHOTS forced colors", async ({ browser, mode }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, forcedColors: "active" });
  const page = await ctx.newPage();
  await page.goto("/");
  await page.screenshot({ path: `test-results/shots/${mode}-forced-landing-1440.png`, animations: "disabled" });
  await ctx.close();
});
