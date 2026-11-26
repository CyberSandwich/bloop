// Throwaway: /library screenshots for review (ci/l2p-shots only, never merged). Saved under test-results/shots/.
import { expect, type Page, test } from "@playwright/test";
import { type FileRow, seeder, signedIn } from "./library-seed.ts";

const now = Date.now();
const MB = 1024 * 1024;
const DAY = 86_400_000;
const long = `${"A very long lecture title that keeps going and going for the shots ".repeat(2).slice(0, 115)}.pptx`;
const files: FileRow[] = [
  ["f1", "Lecture 5.pptx", { bytes: 18 * MB, selected_at: now - 100 }],
  ["f2", "Reading list.pdf", { bytes: 2 * MB, selected_at: now - 50, updated_at: now - DAY * 20 }],
  ["f3", "Lecture 6.pptx", { bytes: 22 * MB, updated_at: now - 1000 }],
  ["f4", "Seminar.docx", { bytes: MB, updated_at: now - DAY * 3 }],
  ["f5", "Results.xlsx", { bytes: 340 * 1024, updated_at: now - DAY * 5 }],
  ["f6", "Macro deck.pptm", { bytes: 5 * MB, updated_at: now - DAY * 6, refusal: "macros" }],
  ["f7", long, { bytes: 9 * MB, updated_at: now - DAY * 7 }],
  ["f8", "Dog.jpg", { bytes: 3 * MB, updated_at: now - DAY * 8, disabled_at: now }],
  ["t1", "Old talk.pptx", { bytes: 4 * MB, trashed_at: now, purge_after: now + DAY * 29 }],
];
const derived: [string, string, Record<string, string | number>?][] = [
  ["f3", "running"],
  ["f6", "failed"],
  ["f4", "done", { pages: 3, fonts_missing: '["Aptos","Grandview"]' }],
];

const SIZES: [number, number][] = [
  [320, 700],
  [390, 844],
  [430, 932],
  [844, 390],
  [834, 1112],
  [1440, 900],
  [1080, 1920],
];
const TOAST_SIZES = new Set(["390x844", "844x390", "1440x900"]);

const fixtures = seeder(now);
const full = () => fixtures.member(files, { used: 1.2 * 1024 * MB, derived });
const members = new Map(
  SIZES.flatMap(([w, h]) => [
    [`empty-${w}x${h}`, fixtures.member()],
    [`full-${w}x${h}`, full()],
    ...(TOAST_SIZES.has(`${w}x${h}`)
      ? [
          [
            `toast-${w}x${h}`,
            fixtures.member([["u1", "Big lecture.pptx", { bytes: 40 * MB, status: "checking" }], ...files], {
              used: 1.2 * 1024 * MB,
              derived,
            }),
          ] as const,
        ]
      : []),
  ]),
);
const quota = fixtures.member(files, { used: 4.6 * 1024 * MB, derived });
test.describe.configure({ mode: "default" });
test.beforeAll(() => fixtures.seed());

const shot = (page: Page, name: string, fullPage = false) =>
  page.screenshot({ path: `test-results/shots/${name}.png`, fullPage });

for (const [width, height] of SIZES) {
  const size = `${width}x${height}`;
  for (const state of ["empty", "full"] as const) {
    test(`shot ${state} ${size}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height } });
      await signedIn(context, members.get(`${state}-${size}`) ?? fixtures.member());
      const page = await context.newPage();
      await page.goto("/library");
      await page
        .locator(state === "full" ? "#file-list > li.lib-item" : "#empty:not([hidden])")
        .first()
        .waitFor();
      await page.waitForTimeout(400);
      await shot(page, `${state}-${size}`, true);
      if (state === "full" && (width === 390 || width === 1440)) {
        await page.getByRole("button", { name: "More for Lecture 5.pptx" }).first().click();
        await page.waitForTimeout(400);
        await shot(page, `menu-${width}`);
        await page.keyboard.press("Escape");
        await page.locator("#present:visible, #present-card:visible").first().click();
        await page.waitForTimeout(400);
        await shot(page, `present-${width}`);
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: /^Trash · / }).click();
        await page.waitForTimeout(600);
        await shot(page, `trash-${width}`, true);
      }
      await context.close();
    });
  }
  if (!TOAST_SIZES.has(size)) continue;
  test(`shot toast ${size}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height } });
    await signedIn(context, members.get(`toast-${size}`) ?? fixtures.member());
    const page = await context.newPage();
    await page.goto("/library");
    await page.locator("#file-list > li.lib-item").first().waitFor();
    // U's upload client has not landed, so the row on its way is a file the server is still checking.
    await expect(page.locator("#file-list")).toContainText("Big lecture.pptx");
    await page.getByRole("button", { name: "More for Reading list.pdf" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Move to Trash" }).click();
    await page.locator(".toast:not(.out)").waitFor();
    await page.waitForTimeout(400);
    await shot(page, `toast-panel-${size}`);
    const box = async (sel: string) => page.locator(sel).first().boundingBox();
    const [toast, panel] = [await box(".toast:not(.out)"), await box("#panel")];
    console.log(`toast ${size}: toast ${JSON.stringify(toast)} panel ${JSON.stringify(panel)}`);
    await page.locator("#present:visible, #present-card:visible").first().click();
    await page.waitForTimeout(400);
    await shot(page, `toast-present-${size}`);
    const sheet = await box("dialog[open] .lib-sheet-head");
    console.log(`toast ${size}: sheet head ${JSON.stringify(sheet)} toast ${JSON.stringify(await box(".toast"))}`);
    await context.close();
  });
}

test("shot near quota 390", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await signedIn(context, quota);
  const page = await context.newPage();
  await page.goto("/library");
  await page.locator("#file-list > li.lib-item").first().waitFor();
  await shot(page, "quota90-390");
  await context.close();
});
