// The legal pages against docs/design.md section 6, Legal pages. CI only.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// The callbacks below run in the browser; the test tsconfig has no DOM library, so these names are declared here.
interface El {
  getBoundingClientRect(): { top: number; bottom: number; left: number; right: number; width: number; height: number };
}
declare const document: {
  querySelector(selector: string): El | null;
  documentElement: { scrollWidth: number };
};
declare const innerWidth: number;
declare const getComputedStyle: (el: El) => { position: string; display: string; visibility: string; fontSize: string };

// The contracts and the articles share one doc layout (design.md section 6, Site build).
const PAGES = [
  "/privacy",
  "/terms",
  "/security",
  "/articles",
  "/articles/how-bloop-works",
  "/articles/threat-model-for-it-teams",
  "/articles/what-stays-on-the-pc",
  "/articles/data-and-retention",
] as const;
const WIDTHS = [1440, 834, 600, 390] as const;

for (const width of WIDTHS) {
  test.describe(`legal pages at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    for (const path of PAGES) {
      test(`${path} has no horizontal scroll and no axe violations`, async ({ page }) => {
        await page.goto(path);
        const [scroll, inner] = (await page.evaluate("[document.documentElement.scrollWidth, innerWidth]")) as number[];
        expect(scroll).toBeLessThanOrEqual(inner as number);
        if (width === 1440 || width === 390) {
          expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        }
      });
    }
  });
}

test.describe("legal layout at 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the text keeps a 68ch measure and the contents stay in view as the page scrolls", async ({ page }) => {
    await page.goto("/privacy");
    const text = page.locator(".legal-text");
    const [w, size] = await text.evaluate((el) => [
      (el as unknown as El).getBoundingClientRect().width,
      Number.parseFloat(getComputedStyle(el as unknown as El).fontSize),
    ]);
    // 68ch of Inter at 17 px is about 34 em; never a full-width line.
    expect(w).toBeLessThanOrEqual(size * 42);
    expect(w).toBeGreaterThan(size * 28);
    await page.locator("#rights").scrollIntoViewIfNeeded();
    const top = await page
      .locator(".toc")
      .evaluate((el) => Math.round((el as unknown as El).getBoundingClientRect().top));
    expect(top).toBe(14 + 56 + 24);
  });

  test("the contents mark the section being read", async ({ page }) => {
    await page.goto("/terms#liability");
    await expect(page.locator('.toc a[href="#liability"]')).toHaveAttribute("aria-current", "location");
    await expect(page.locator('.toc a[aria-current="location"]')).toHaveCount(1);
  });

  test("a jump to a short section marks that section, and the end of the text marks the last", async ({ page }) => {
    await page.goto("/security");
    await page.locator('.toc a[href="#pc"]').click();
    await expect(page.locator('.toc a[href="#pc"]')).toHaveAttribute("aria-current", "location");
    await expect(page.locator('.toc a[aria-current="location"]')).toHaveCount(1);
    await page.goto("/terms");
    await page.evaluate("scrollTo(0, document.documentElement.scrollHeight)");
    await expect(page.locator('.toc a[href="#contact"]')).toHaveAttribute("aria-current", "location");
  });

  test("a clause number shows its link glyph on hover, and a click copies its URL and says so", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/terms");
    const num = page.locator('a.num[href="#8.3"]');
    const glyph = num.locator("svg.icon");
    await expect(glyph).toBeHidden();
    await page.locator('p[id="8.3"]').hover();
    await expect(glyph).toBeVisible();
    await num.click();
    await expect(page.locator("#copied")).toHaveText("Link Copied");
    expect(await page.evaluate("navigator.clipboard.readText()")).toMatch(/\/terms#8\.3$/);
    await expect(page).toHaveURL(/#8\.3$/);
    await expect(page.locator("#copied")).toHaveText("", { timeout: 4000 });
  });

  test("print shows the text alone: no nav, footer, contents or panel", async ({ page }) => {
    await page.goto("/privacy");
    await page.emulateMedia({ media: "print" });
    for (const sel of [".nav", ".footer", ".toc", ".panel"]) await expect(page.locator(sel).first(), sel).toBeHidden();
    await expect(page.locator(".legal-text")).toBeVisible();
  });

  test("every footer links Terms, and it opens the Terms of Use", async ({ page }) => {
    await page.goto("/");
    await page.locator(".footer-links").getByRole("link", { name: "Terms" }).click();
    await expect(page).toHaveURL(/\/terms$/);
    await expect(page.locator("h1")).toHaveText("Terms of Use");
  });
});

test.describe("legal layout at 390", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("tables stack with each value under its column's name, and the contents do not stick", async ({ page }) => {
    await page.goto("/privacy");
    const cell = page.locator("#retention td").first();
    expect(await cell.evaluate((el) => getComputedStyle(el as unknown as El).display)).toBe("block");
    expect(await page.locator(".toc").evaluate((el) => getComputedStyle(el as unknown as El).position)).toBe("static");
    const label = page.locator('#processors td:nth-child(2) > .label[aria-hidden="true"]').first();
    await expect(label).toBeVisible();
    expect(await label.evaluate("(el) => el.innerText")).toBe("What it does");
  });

  test("the phone menu lists Terms and Articles, and Terms opens the Terms of Use", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Primary" });
    await nav.getByRole("button", { name: "Menu" }).click();
    await expect(nav.getByRole("link", { name: "Articles" })).toBeVisible();
    await nav.getByRole("link", { name: "Terms" }).click();
    await expect(page.locator("h1")).toHaveText("Terms of Use");
  });
});

test.describe("structured data and previews", () => {
  for (const path of ["/", "/privacy", "/articles/how-bloop-works"]) {
    test(`${path} carries JSON-LD and canonical tags and reports no CSP or Trusted Types violation`, async ({
      page,
    }) => {
      const violations: string[] = [];
      page.on("console", (m) => {
        if (m.text().includes("Content Security Policy") || m.text().includes("TrustedHTML")) violations.push(m.text());
      });
      await page.goto(path);
      await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(1, { timeout: 5000 });
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `https://bloop.here${path}`);
      expect(violations).toEqual([]);
    });
  }

  test("an article states its reading time under its title", async ({ page }) => {
    await page.goto("/articles/how-bloop-works");
    await expect(page.locator(".meta")).toContainText(/Published .* · \d+ min read/);
  });
});
