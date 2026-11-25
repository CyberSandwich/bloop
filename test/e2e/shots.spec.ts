// Throwaway font screenshots; lives only on ci/font-shots, never merged.
import { test } from "@playwright/test";

const SIZES = [
  [1440, 900],
  [390, 844],
] as const;

for (const [w, h] of SIZES) {
  test.describe(`${w}x${h}`, () => {
    test.use({ viewport: { width: w, height: h }, hasTouch: w < 1000, isMobile: w < 500 });

    for (const [name, path] of [
      ["landing", "/"],
      ["s", "/s"],
      ["a", "/a"],
    ] as const) {
      test(name, async ({ page }) => {
        await page.goto(path);
        await page.evaluate("document.fonts.ready");
        await page.waitForTimeout(800);
        await page.screenshot({ path: `test-results/shots/${name}-${w}.png` });
      });
    }

    test("glyph coverage and fallback", async ({ page }) => {
      await page.goto("/404.html");
      await page.evaluate("document.fonts.ready");
      await page.evaluate(`(() => {
        const lines = [
          "Café Zoë £5 €5 — “quotes” … ™ 12:05",
          "Q3 déjà vu 59:12 · 01:23:45 ↑ ↓ −",
          "報告書 2026 最終版.pptx",
          "Привет мир.pdf",
          "ملف العرض.pdf",
          "Résumé 🙂 final.pdf",
        ];
        document.body.replaceChildren();
        for (const [i, t] of lines.entries()) {
          const d = document.createElement("div");
          d.textContent = t;
          d.style.font = (i % 2 ? "600" : "400") + ' 28px/1.5 Inter, "Inter Fallback", Arial, sans-serif';
          d.style.margin = "16px";
          document.body.append(d);
        }
      })()`);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `test-results/shots/glyphs-${w}.png` });
    });
  });
}
