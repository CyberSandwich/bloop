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
    ["c", "Alpha.pptx"],
  ]),
  renameSpaces: fixtures.member([["a", "Alpha.pptx"]]),
  renameBad: fixtures.member([["a", "Alpha.pptx"]]),
  sample: fixtures.member(),
  preview: fixtures.member([["a", "Reading list.pdf"]]),
  drag: fixtures.member([
    ["a", "Lecture 1.pptx", { selected_at: now - 20 }],
    ["b", "Lecture 2.pptx", { selected_at: now - 10 }],
  ]),
  live: fixtures.member([["a", "Lecture 5.pptx"]], { derived: [["a", "queued"]] }),
  busy: fixtures.member(),
  race: fixtures.member([
    ["a", "Lecture 5.pptx"],
    ["b", "Reading list.pdf"],
  ]),
  focus: fixtures.member([
    ["a", "Lecture 5.pptx"],
    ["b", "Reading list.pdf"],
    ["c", "Seminar.docx"],
  ]),
  dragPoll: fixtures.member([
    ["a", "Lecture 1.pptx", { selected_at: now - 20 }],
    ["b", "Lecture 2.pptx", { selected_at: now - 10 }],
  ]),
  undo: fixtures.member([
    ["a", "Lecture 5.pptx", { selected_at: now - 10 }],
    ["b", "Reading list.pdf"],
  ]),
  long: fixtures.member(Array.from({ length: 12 }, (_, i): [string, string] => [`f${i}`, `Lecture ${i + 1}.pptx`])),
  wide: fixtures.member([
    ["a", "Introduction to Corporate Financial Reporting Week 5.pptx", { selected_at: now - 10 }],
  ]),
};

/** A refetch nobody asked for, as a poll, a socket frame or another tab would start one. */
const refetch = (page: Page) => page.evaluate('dispatchEvent(new Event("online"))');
const listGet = (page: Page) =>
  page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/library");
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
    // Newest First would put the renamed file first, and a plain string order would put Lecture 10 before Lecture 3.
    const names = page.locator("#file-list > li .row-name");
    await expect(names).toHaveText(["Alpha.pptx", "Lecture 3.pptx", "Lecture 10.pptx"]);

    await page.locator("#present:visible, #present-card:visible").first().click();
    const sheet = page.getByRole("dialog", { name: "Present on a Screen" });
    await expect(sheet).toContainText("Opens first: Lecture 10.pptx");
    await expect(sheet.getByRole("link", { name: "Enter the Code" })).toHaveAttribute("href", "/code");
    await axe(page);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  test("a typed name with a doubled and a no-break space is cleaned before it is sent, never refused", async ({
    page,
    context,
  }) => {
    await signedIn(context, members.renameSpaces);
    await page.goto("/library");
    await page.getByRole("button", { name: "More for Alpha.pptx" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Rename" }).click();
    const field = page.getByRole("textbox", { name: "Name" });
    await field.fill("  Alpha \u00a0 Beta\t");
    await field.press("Enter");
    await expect(page.locator("#file-list")).toContainText("Alpha Beta.pptx");
    await page.reload();
    await expect(page.locator("#file-list")).toContainText("Alpha Beta.pptx");
    await expectNoToast(page);
  });

  test("a name that cleans to nothing says so, and the field stays", async ({ page, context }) => {
    await signedIn(context, members.renameBad);
    await page.goto("/library");
    await page.getByRole("button", { name: "More for Alpha.pptx" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Rename" }).click();
    const field = page.getByRole("textbox", { name: "Name" });
    await field.fill("\u200b");
    await field.press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "That Name Can't Be Used" })).toBeVisible();
    await expect(field).toBeVisible();
    await expect(page.locator("#file-list")).toContainText("Alpha.pptx");
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

  test("on a phone, a toast sits above the bottom panel even when its buttons stack", async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signedIn(context, members.busy);
    await page.route("**/api/library/sample", (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "service_busy" }) }),
    );
    await page.goto("/library");
    await page.getByRole("button", { name: "Add the Sample Deck" }).click();
    const toast = page.locator(".toast:not(.out)");
    await expect(toast).toBeVisible();
    // The toast slides in; its resting place is what has to clear the panel.
    await page.waitForTimeout(400);
    const [t, p] = [await toast.boundingBox(), await page.locator("#panel").boundingBox()];
    expect(t && p && t.y + t.height <= p.y, `toast ${JSON.stringify(t)} over panel ${JSON.stringify(p)}`).toBe(true);
  });

  test("a file still preparing opens the library socket", async ({ page, context }) => {
    await signedIn(context, members.live);
    const socket = page.waitForEvent("websocket", (ws) => ws.url().endsWith("/api/library/ws"));
    await page.goto("/library");
    await expect(page.locator("#file-list > li")).toHaveCount(1);
    await socket;
  });

  test("a list read begun before a write cannot undo the write when it lands late", async ({ page, context }) => {
    await signedIn(context, members.race);
    await page.goto("/library");
    await expect(page.locator("#file-list > li")).toHaveCount(2);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    // The first read after this point is answered with the list as it was, and only once the write has landed.
    await page.route(
      (url) => url.pathname === "/api/library",
      async (route) => {
        if (held || route.request().method() !== "GET") return route.continue();
        held = true;
        const { "if-none-match": _, ...headers } = route.request().headers();
        const stale = await route.fetch({ headers });
        await gate;
        await route.fulfill({ response: stale });
      },
    );
    await refetch(page);
    await expect.poll(() => held).toBe(true);
    await page.getByRole("button", { name: "More for Lecture 5.pptx" }).click();
    const fresh = listGet(page);
    await page.getByRole("dialog").getByRole("button", { name: "Move to Trash" }).click();
    await fresh;
    const late = listGet(page);
    release();
    await late;
    await page.waitForTimeout(300);
    await expect(page.locator("#file-list > li")).toHaveCount(1);
  });

  test("focus survives a repaint: a menu closes back onto its More, a deleted row hands on to the next", async ({
    page,
    context,
  }) => {
    await signedIn(context, members.focus);
    await page.goto("/library");
    const more = page.getByRole("button", { name: "More for Reading list.pdf" });
    await more.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const got = listGet(page);
    await refetch(page);
    await got;
    await page.keyboard.press("Escape");
    await expect(more).toBeFocused();

    await page.locator("#file-list .lib-open").first().focus();
    await page.keyboard.press("Delete");
    await expect(page.locator("#file-list > li")).toHaveCount(2);
    await expect(page.locator("#file-list .lib-open").first()).toBeFocused();
  });

  test("a refetch during an Up Next drag does not drop the drag", async ({ page, context }) => {
    await signedIn(context, members.dragPoll);
    await page.goto("/library");
    const up = page.locator("#up-list > li");
    await expect(up).toHaveCount(2);
    const grip = (await up.first().locator(".lib-grip").boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
    const below = (await up.nth(1).boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await expect(page.locator("#up-list .is-dragging")).toHaveCount(1);
    const got = listGet(page);
    await refetch(page);
    await got;
    const stored = page.waitForResponse((r) => r.url().endsWith("/api/library/up-next") && r.status() < 300);
    await page.mouse.move(grip.x + grip.width / 2, below.y + below.height - 2, { steps: 8 });
    await page.mouse.up();
    await expect(up.first()).toContainText("Lecture 2.pptx");
    await stored;
    await page.reload();
    await expect(page.locator("#up-list > li").first()).toContainText("Lecture 2.pptx");
  });

  test("a row menu opened near the window's foot stays inside the window", async ({ page, context }) => {
    await signedIn(context, members.long);
    await page.goto("/library");
    await page.getByRole("button", { name: "More for Lecture 12.pptx" }).click();
    await expect(page.getByRole("dialog").getByRole("button", { name: "Move to Trash" })).toBeInViewport({ ratio: 1 });
  });

  test("a sheet blurs the page behind it, so no row or toast reads through its copy", async ({ page, context }) => {
    await signedIn(context, members.long);
    await page.goto("/library");
    await page.getByRole("button", { name: "More for Lecture 12.pptx" }).click();
    await expect(page.getByRole("dialog")).toHaveCSS("backdrop-filter", /blur/);
  });

  test("Download never replaces the library, even when the file shows inline", async ({ page, context }) => {
    await signedIn(context, members.preview);
    // A page on another origin, as the file host is, which the browser shows rather than saves: there `download` is
    // ignored, as it is for an inline PDF on FILE_ORIGIN.
    await page.route(
      (url) => url.pathname.endsWith("/preview"),
      (route) => route.fulfill({ json: { base: "http://127.0.0.1:8787/privacy", exp: Date.now() + 300_000 } }),
    );
    await page.goto("/library");
    await page.getByRole("button", { name: "More for Reading list.pdf" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Download" }).click();
    await page.waitForTimeout(1500);
    await expect(page).toHaveURL(/localhost:8787\/library$/);
    expect(context.pages()).toHaveLength(2);
  });

  test("a toast's Undo still works with the Present sheet open over the page", async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signedIn(context, members.undo);
    await page.goto("/library");
    await page.getByRole("button", { name: "More for Reading list.pdf" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Move to Trash" }).click();
    await expect(page.locator("#file-list > li")).toHaveCount(1);
    await page.locator("#present:visible, #present-card:visible").first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Undo" }).click({ timeout: 5000 });
    await expect(page.locator("#file-list > li")).toHaveCount(2);
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  for (const [width, list] of [
    [320, "#file-list"],
    [1440, "#up-list"],
  ] as const) {
    test(`a long name takes two lines and no more at ${width}`, async ({ page, context }) => {
      await page.setViewportSize({ width, height: 900 });
      await signedIn(context, members.wide);
      await page.goto("/library");
      const name = page.locator(`${list} .row-name`).first();
      await expect(name).toBeVisible();
      // A 15px line at 1.3 is 19.5 high: two lines, never three, never one.
      const box = await name.boundingBox();
      expect(Math.round((box?.height ?? 0) / 19.5), "lines").toBe(2);
      // The name stays clear of the tick beside it (More is hidden in Up Next on a fine pointer).
      const tick = await page.locator(`${list} .lib-tick`).first().boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0), "name right edge").toBeLessThanOrEqual(tick?.x ?? 0);
    });
  }

  test("a toast's Undo still works with the Empty Trash confirm open over the page", async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signedIn(context, members.undo);
    await page.goto("/library");
    await page.getByRole("button", { name: "More for Reading list.pdf" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Move to Trash" }).click();
    await page.getByRole("button", { name: /^Trash · 1$/ }).click();
    await page.getByRole("button", { name: "Empty Trash" }).click();
    await expect(page.getByRole("dialog", { name: "Empty the Trash?" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.getByRole("button", { name: "Undo" }).click({ timeout: 5000 });
    await expect(page.getByRole("dialog", { name: "Empty the Trash?" })).toBeVisible();
    await expectNoToast(page);
  });

  test("the Present sheet's buttons sit centered from 640", async ({ page, context }) => {
    await page.setViewportSize({ width: 700, height: 900 });
    await signedIn(context, members.undo);
    await page.goto("/library");
    await page.locator("#present:visible, #present-card:visible").first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const buttons = dialog.locator(".buttons > .btn");
    const [sheet, first, last] = [
      await dialog.boundingBox(),
      await buttons.first().boundingBox(),
      await buttons.last().boundingBox(),
    ];
    const left = Math.min(first?.x ?? 0, last?.x ?? 0);
    const right = Math.max((first?.x ?? 0) + (first?.width ?? 0), (last?.x ?? 0) + (last?.width ?? 0));
    expect(Math.abs((sheet?.x ?? 0) + (sheet?.width ?? 0) / 2 - (left + right) / 2)).toBeLessThan(2);
  });
});
