// Throwaway: /library screenshots for review (ci/l4p-modal-shots only, never merged). Saved under test-results/shots/.
import { type Page, test } from "@playwright/test";
import { type FileRow, seeder, signedIn } from "./library-seed.ts";

const now = Date.now();
const MB = 1024 * 1024;
const DAY = 86_400_000;
const files: FileRow[] = [
  ["f1", "Introduction to Corporate Financial Reporting Week 5.pptx", { bytes: 18 * MB, selected_at: now - 100 }],
  ["f2", "Reading list.pdf", { bytes: 2 * MB, selected_at: now - 50, updated_at: now - DAY * 20 }],
  ["f3", "Lecture 6 with a rather long title.pptx", { bytes: 22 * MB, selected_at: now - 20, updated_at: now - 1000 }],
  ["f4", "Seminar.docx", { bytes: MB, updated_at: now - DAY * 3 }],
  ["f5", "Results.xlsx", { bytes: 340 * 1024, updated_at: now - DAY * 5 }],
];
const SIZES: [number, number][] = [
  [320, 700],
  [390, 844],
  [430, 932],
  [640, 900],
  [844, 390],
  [1440, 900],
];
const fixtures = seeder(now);
const members = new Map(SIZES.flatMap(([w, h]) => [[`${w}x${h}`, fixtures.member(files)] as const]));
test.describe.configure({ mode: "default" });
test.beforeAll(() => fixtures.seed());

const shot = (page: Page, name: string, fullPage = false) =>
  page.screenshot({ path: `test-results/shots/${name}.png`, fullPage });

for (const [width, height] of SIZES) {
  const size = `${width}x${height}`;
  test(`shot ${size}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height } });
    await signedIn(context, members.get(size) ?? fixtures.member());
    const page = await context.newPage();
    await page.goto("/library");
    await page.locator("#file-list > li.lib-item").first().waitFor();
    await page.waitForTimeout(400);
    await shot(page, `list-${size}`, true);
    await page.locator("#present:visible, #present-card:visible").first().click();
    await page.waitForTimeout(400);
    await shot(page, `present-${size}`);
    await page.keyboard.press("Escape");
    // The Empty Trash confirm with a toast above it.
    await page.locator(".lib-more:visible").first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Move to Trash" }).click();
    await page.getByRole("button", { name: /^Trash · / }).click();
    await page.getByRole("button", { name: "Empty Trash" }).click();
    await page.getByRole("dialog", { name: "Empty the Trash?" }).waitFor();
    await page.locator(".toast:not(.out)").waitFor();
    await page.waitForTimeout(400);
    await shot(page, `confirm-toast-${size}`);
    await context.close();
  });
}
