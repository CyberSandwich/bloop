// The typed-code page's layout and Paste button (docs/design.md section 7, Typed code page). CI only.
import { expect, type Page, test } from "@playwright/test";

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 1440, height: 900 },
  { width: 844, height: 390 },
] as const;

const box = async (page: Page, selector: string) => {
  const b = await page.locator(selector).boundingBox();
  if (!b) throw new Error(`${selector} has no box`);
  return b;
};

async function openCode(page: Page, init?: string) {
  if (init) await page.addInitScript(init);
  await page.goto("/code");
  await page.evaluate("document.fonts.ready");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Enter the Code");
}

for (const { width, height } of VIEWPORTS) {
  test.describe(`code page at ${width} x ${height}`, () => {
    test.use({ viewport: { width, height }, isMobile: width < 900, hasTouch: width < 900 });

    test("the block is centered in the viewport within 2 px, with no scrolling", async ({ page }) => {
      await openCode(page);
      expect(await page.evaluate("document.documentElement.scrollHeight <= innerHeight")).toBe(true);
      const top = (await box(page, "#title")).y;
      const go = await box(page, "#go");
      const middle = (top + go.y + go.height) / 2;
      expect(Math.abs(middle - height / 2)).toBeLessThanOrEqual(2);
    });

    test("Paste's right edge is Continue's, and Paste is a square of the field's height and look", async ({ page }) => {
      await openCode(page);
      const paste = await box(page, "#paste");
      const go = await box(page, "#go");
      const field = await box(page, "#code");
      expect(Math.abs(paste.x + paste.width - (go.x + go.width))).toBeLessThanOrEqual(1);
      expect(paste.height).toBeCloseTo(field.height, 0);
      expect(paste.width).toBeCloseTo(paste.height, 0);
      expect(Math.abs(go.x - field.x)).toBeLessThanOrEqual(1);
      const look = (selector: string) =>
        page.evaluate(
          `(() => { const s = getComputedStyle(document.querySelector("${selector}")); return [s.borderRadius, s.boxShadow, s.backgroundColor]; })()`,
        );
      expect(await look("#paste")).toEqual(await look("#code"));
    });

    test("the gaps are the design's: heading 16 to the field, then 8, the 24 error row, 8 to Continue", async ({
      page,
    }) => {
      await openCode(page);
      const title = await box(page, "#title");
      const field = await box(page, "#code");
      const error = await box(page, "#code-error");
      const go = await box(page, "#go");
      expect(Math.round(field.y - (title.y + title.height))).toBe(16);
      expect(Math.round(error.y - (field.y + field.height))).toBe(8);
      expect(Math.round(error.height)).toBe(24);
      expect(Math.round(go.y - (error.y + error.height))).toBe(8);
    });
  });
}

test.describe("code page, Paste and its label", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const reads = (text: string) =>
    `Object.defineProperty(navigator, "clipboard", { value: { readText: async () => ${JSON.stringify(text)} } });`;

  test("no visible Code label, and the field is named by the heading", async ({ page }) => {
    await openCode(page);
    await expect(page.locator("label")).toHaveCount(0);
    await expect(page.getByText("Code", { exact: true })).toHaveCount(0);
    await expect(page.locator("#code")).toHaveAttribute("aria-labelledby", "title");
    await expect(page.getByRole("textbox", { name: "Enter the Code" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Paste", exact: true })).toBeVisible();
  });

  test("Paste fills the field through the typed path, enables Continue and never submits", async ({ page }) => {
    const claims: string[] = [];
    page.on("request", (r) => r.url().includes("/api/claim") && claims.push(r.url()));
    await openCode(page, reads("  k7mq9x\n"));
    // What typing the same text leaves in the field, then back to empty.
    const field = page.getByRole("textbox", { name: "Enter the Code" });
    await field.fill("k7mq9x");
    const typed = await field.inputValue();
    await field.fill("");
    await expect(page.locator("#go")).toBeDisabled();
    await page.getByRole("button", { name: "Paste", exact: true }).click();
    await expect(page.locator("#code")).toHaveValue(typed);
    expect(typed).toBe("K7M Q9X");
    await expect(page.locator("#go")).toBeEnabled();
    await expect(page).toHaveURL(/\/code$/);
    expect(claims).toEqual([]);
  });

  test("Paste takes the last code-shaped run out of words around it", async ({ page }) => {
    await openCode(page, reads("Code: K7M Q9X"));
    await page.getByRole("button", { name: "Paste", exact: true }).click();
    await expect(page.locator("#code")).toHaveValue("K7M Q9X");
    await expect(page.locator("#go")).toBeEnabled();
  });

  test("Paste with no code in the text shows the one line and leaves the field alone", async ({ page }) => {
    await openCode(page, reads("hello there, K7O 123"));
    await page.getByRole("button", { name: "Paste", exact: true }).click();
    await expect(page.locator("#code-error")).toHaveText("Can't paste. Type the code.");
    await expect(page.locator("#code")).toHaveValue("");
    await expect(page.locator("#go")).toBeDisabled();
  });

  test("text typed while the read is out wins", async ({ page }) => {
    await openCode(
      page,
      `Object.defineProperty(navigator, "clipboard", { value: { readText: () => new Promise((done) => setTimeout(() => done("K7M Q9X"), 400)).then((text) => { window.__read = true; return text; }) } });`,
    );
    await page.getByRole("button", { name: "Paste", exact: true }).click();
    await page.getByRole("textbox", { name: "Enter the Code" }).fill("ab");
    // Not waitForFunction: it evaluates its predicate in the page, which the page's CSP refuses.
    await expect.poll(() => page.evaluate("window.__read === true")).toBe(true);
    // One more task: the click handler resumes in a microtask after the read settles.
    await page.evaluate("new Promise((done) => setTimeout(done, 0))");
    await expect(page.locator("#code")).toHaveValue("AB");
  });

  test("without the clipboard API Paste is hidden and Continue still ends the row", async ({ page }) => {
    await openCode(page, `Object.defineProperty(navigator, "clipboard", { value: undefined });`);
    await expect(page.locator("#paste")).toBeHidden();
    const field = await box(page, "#code");
    const go = await box(page, "#go");
    expect(Math.abs(field.x + field.width - (go.x + go.width))).toBeLessThanOrEqual(1);
  });

  test("Paste's module failing to load shows the one line, and typing still works", async ({ page }) => {
    await page.route("**/js/core/paste.js", (route) => route.abort());
    await openCode(page, reads("K7M Q9X"));
    await page.getByRole("button", { name: "Paste", exact: true }).click();
    await expect(page.locator("#code-error")).toHaveText("Can't paste. Type the code.");
    await page.getByRole("textbox", { name: "Enter the Code" }).fill("k7mq9x");
    await expect(page.locator("#go")).toBeEnabled();
  });

  test("a refused read shows one line and leaves the field alone", async ({ page }) => {
    await openCode(
      page,
      `Object.defineProperty(navigator, "clipboard", { value: { readText: () => Promise.reject(new DOMException("no", "NotAllowedError")) } });`,
    );
    const go = await box(page, "#go");
    await page.getByRole("button", { name: "Paste", exact: true }).click();
    await expect(page.locator("#code-error")).toHaveText("Can't paste. Type the code.");
    await expect(page.locator("#code")).toHaveValue("");
    await expect(page.locator("#go")).toBeDisabled();
    const after = await box(page, "#go");
    expect([after.x, after.y, after.width, after.height].map(Math.round)).toEqual(
      [go.x, go.y, go.width, go.height].map(Math.round),
    );
  });
});
