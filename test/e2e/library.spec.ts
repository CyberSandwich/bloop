// /library in a browser, against `npm run dev` (CI only: headless Chrome cannot start in the local sandbox).
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { seeder, signedIn } from "./library-seed.ts";

const now = Date.now();
// Every member is seeded in one execute before the first test (library-seed.ts), so the tests run in order in one worker.
const fixtures = seeder(now);
const members = {
  empty: fixtures.member(),
  full: fixtures.member([
    ["a", "Lecture 5.pptx", { selected_at: now - 10 }],
    ["b", "Reading list.pdf"],
    ["c", "Seminar.docx"],
  ]),
  trash: fixtures.member([
    ["a", "Lecture 5.pptx"],
    ["b", "Reading list.pdf"],
  ]),
  rename: fixtures.member([
    ["a", "Lecture 10.pptx", { selected_at: now - 10 }],
    ["b", "Lecture 2.pptx"],
  ]),
  sample: fixtures.member(),
  preview: fixtures.member([["a", "Reading list.pdf"]]),
  drag: fixtures.member([
    ["a", "Lecture 1.pptx", { selected_at: now - 20 }],
    ["b", "Lecture 2.pptx", { selected_at: now - 10 }],
  ]),
  live: fixtures.member([["a", "Lecture 5.pptx"]], { derived: [["a", "queued"]] }),
};
test.describe.configure({ mode: "default" });
test.beforeAll(() => fixtures.seed());

const expectNoToast = async (page: Page) =>
  expect(await page.locator(".toast:not(.out)").count(), "a toast is up").toBe(0);

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

test.describe("library", () => {
  test("signed out, /library is the 404 page in preview", async ({ page }) => {
    const res = await page.goto("/library");
    expect(res?.status()).toBe(404);
  });

  test("the empty state: Add Your First File, the sample deck, no Present; no axe or CSP violation", async ({
    page,
    context,
  }) => {
    const csp: string[] = [];
    page.on("console", (m) => m.text().includes("Content Security Policy") && csp.push(m.text()));
    await signedIn(context, members.empty);
    await page.goto("/library");
    await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Add Your First File" })).toBeVisible();
    await expect(page.locator("#quota")).toHaveText("0 of 5 GB used");
    await expect(page.getByRole("button", { name: "Add the Sample Deck" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add Files" })).toHaveClass(/primary/);
    await expect(page.locator("#present")).toBeHidden();
    await expect(page.getByRole("progressbar", { name: "Storage used" })).toHaveAttribute("aria-valuenow", "0");
    await axe(page);
    expect(csp).toEqual([]);
  });

  test("the full state: rows, Up Next in order, ticks, a refused file without one; no axe violation", async ({
    page,
    context,
  }) => {
    await signedIn(context, members.full);
    await page.goto("/library");
    const all = page.locator("#file-list > li");
    await expect(all).toHaveCount(3);
    await expect(page.locator("#up-list > li")).toHaveCount(1);
    await expect(page.locator("#up-list")).toContainText("Lecture 5.pptx");
    await expect(page.getByRole("checkbox", { name: "Up Next: Lecture 5.pptx" }).first()).toBeChecked();
    await expect(page.getByRole("button", { name: "More for Reading list.pdf" })).toBeVisible();
    await expect(page.locator("#present")).toBeEnabled();
    await axe(page);

    // A tick adds a copy to the end of Up Next and leaves the row where it is.
    await page.locator("#file-list").getByRole("checkbox", { name: "Up Next: Reading list.pdf" }).check();
    await expect(page.locator("#up-list > li")).toHaveCount(2);
    await expect(all.nth(1)).toContainText("Reading list.pdf");
    await page.reload();
    await expect(page.locator("#up-list > li")).toHaveCount(2);
    await expectNoToast(page);
  });

  test("Move to Trash leaves at once, Undo and Cmd+Z put it back, the trash view restores", async ({
    page,
    context,
  }) => {
    await signedIn(context, members.trash);
    await page.goto("/library");
    await page.getByRole("button", { name: "More for Lecture 5.pptx" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Move to Trash" }).click();
    await expect(page.locator("#file-list > li")).toHaveCount(1);
    await expect(page.getByRole("status").filter({ hasText: "Moved to Trash" })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.locator("#file-list > li")).toHaveCount(2);

    await page.getByRole("button", { name: "More for Reading list.pdf" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Move to Trash" }).click();
    await page.getByRole("button", { name: /^Trash · 1$/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Trash" })).toBeFocused();
    await expect(page.getByText("Deletes in 30 days")).toBeVisible();
    await axe(page);
    await page.getByRole("button", { name: "More for Reading list.pdf" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Restore" }).click();
    await expect(page.getByRole("heading", { name: "The Trash Is Empty" })).toBeVisible();
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.locator("#file-list > li")).toHaveCount(2);
  });

  test("rename keeps the extension; sort by name orders naturally; the Present sheet names the first file", async ({
    page,
    context,
  }) => {
    await signedIn(context, members.rename);
    await page.goto("/library");
    await page.getByRole("button", { name: "More for Lecture 2.pptx" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Rename" }).click();
    const field = page.getByRole("textbox", { name: "Name" });
    await expect(field).toHaveValue("Lecture 2");
    await field.fill("Lecture 3");
    await field.press("Enter");
    await expect(page.locator("#file-list")).toContainText("Lecture 3.pptx");

    await page.getByRole("button", { name: "Sort" }).click();
    await page.getByRole("menuitemradio", { name: "Name" }).click();
    await expect(page.locator("#file-list > li").first()).toContainText("Lecture 3.pptx");

    await page.locator("#present:visible, #present-card:visible").first().click();
    const sheet = page.getByRole("dialog", { name: "Present on a Screen" });
    await expect(sheet).toContainText("Opens first: Lecture 10.pptx");
    await expect(sheet.getByRole("link", { name: "Enter the Code" })).toHaveAttribute("href", "/code");
    await axe(page);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  test("Add the Sample Deck adds the deck as a row that a reload keeps", async ({ page, context }) => {
    await signedIn(context, members.sample);
    await page.goto("/library");
    await page.getByRole("button", { name: "Add the Sample Deck" }).click();
    await expect(page.locator("#file-list > li")).toHaveCount(1);
    await expect(page.locator("#file-list")).toContainText("Sample deck.pptx");
    await page.reload();
    await expect(page.locator("#file-list > li")).toHaveCount(1);
  });

  test("a row opens its preview sheet, named for the file, and Escape closes it", async ({ page, context }) => {
    await signedIn(context, members.preview);
    await page.goto("/library");
    await page.locator("#file-list .lib-open").first().click();
    const sheet = page.getByRole("dialog", { name: "Reading list.pdf" });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("PDF");
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  test("dragging an Up Next row by its grip stores the new order", async ({ page, context }) => {
    await signedIn(context, members.drag);
    await page.goto("/library");
    const up = page.locator("#up-list > li");
    await expect(up).toHaveCount(2);
    await expect(up.first()).toContainText("Lecture 1.pptx");
    const grip = (await up.first().locator(".lib-grip").boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
    const below = (await up.nth(1).boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
    const stored = page.waitForResponse((r) => r.url().endsWith("/api/library/up-next") && r.status() < 300);
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    // The drag module loads on this pointerdown; the moves after it are the ones it follows.
    await expect(page.locator("#up-list .is-dragging")).toHaveCount(1);
    await page.mouse.move(grip.x + grip.width / 2, below.y + below.height - 2, { steps: 8 });
    await page.mouse.up();
    await expect(up.first()).toContainText("Lecture 2.pptx");
    await stored;
    await page.reload();
    await expect(page.locator("#up-list > li").first()).toContainText("Lecture 2.pptx");
  });

  test("a file still preparing opens the library socket", async ({ page, context }) => {
    await signedIn(context, members.live);
    const socket = page.waitForEvent("websocket", (ws) => ws.url().endsWith("/api/library/ws"));
    await page.goto("/library");
    await expect(page.locator("#file-list > li")).toHaveCount(1);
    await socket;
  });
});
