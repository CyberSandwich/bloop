// A phone that used bloop before still holds its pairing in storage (localStorage bloop.pid, sessionStorage
// bloop.sid, bloop.resume, bloop.nonce). After Approve on a new code the page must show content, never a blank
// body with only Back, and throw nothing. CI only.
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { heading, open, typedCodeOf } from "./pairing.ts";

const PID = "bloop.pid";

/** Page errors of one page, read after the walk. */
function errorsOf(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`${e.name}: ${e.message}`));
  return errors;
}

/** The approved page has words and a list, not only the Back link. */
async function expectApproved(page: Page, errors: string[]) {
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(heading(page)).toHaveText("Approved for Demo Room");
  await expect(page.locator("#file-list .row")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Revoke" })).toBeVisible();
  await expect(page.locator("body")).toHaveText(/Approved for Demo Room[\s\S]*Ends in/);
  expect(errors).toEqual([]);
}

/** A new phone tab in `context` on a fresh demo screen's code. */
async function scanFresh(browser: Parameters<typeof open>[0], context: BrowserContext) {
  const screen = await open(browser, "screen", "/s?mode=demo");
  const code = await typedCodeOf(screen.page);
  const page = await context.newPage();
  const errors = errorsOf(page);
  await page.goto(`/a?c=${code}`);
  return { screen, page, errors };
}

/** Pairs and approves one demo session in a new phone context, and leaves the context for a second visit. */
async function firstSession(browser: Parameters<typeof open>[0]) {
  const screen = await open(browser, "screen", "/s?mode=demo");
  const code = await typedCodeOf(screen.page);
  const phone = await open(browser, "phone", `/a?c=${code}`);
  const errors = errorsOf(phone.page);
  await expectApproved(phone.page, errors);
  expect(await phone.page.evaluate((k) => localStorage.getItem(k), PID)).not.toBeNull();
  return { screen, phone };
}

test.describe("a phone with storage from an earlier session", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a) after Revoke, a new code approves with content", async ({ browser }) => {
    const { phone } = await firstSession(browser);
    await phone.page.getByRole("button", { name: "Revoke" }).click();
    await phone.page
      .getByRole("dialog", { name: "End This Session?" })
      .getByRole("button", { name: "End Session" })
      .click();
    await expect(heading(phone.page)).not.toHaveText("Approved for Demo Room");
    const next = await scanFresh(browser, phone.context);
    await expectApproved(next.page, next.errors);
  });

  test("b) a pid left in localStorage, old screen closed, then a new code approves with content", async ({
    browser,
  }) => {
    const { screen, phone } = await firstSession(browser);
    await screen.context.close();
    await phone.page.close();
    const next = await scanFresh(browser, phone.context);
    await expectApproved(next.page, next.errors);
  });

  test("b2) the old tab reloaded after its screen is gone still shows content", async ({ browser }) => {
    const { screen, phone } = await firstSession(browser);
    await screen.context.close();
    await phone.page.reload();
    await expect(phone.page.locator("body")).not.toHaveText(/^\s*Back\s*$/);
    await expect(heading(phone.page)).toBeVisible();
    const next = await scanFresh(browser, phone.context);
    await expectApproved(next.page, next.errors);
  });

  const GARBAGE: [string, string][] = [
    ["malformed JSON", "{not json"],
    ["old pid shape", "legacy-pid-without-a-dot"],
    ["empty string", ""],
    ["JSON null", "null"],
    ["an expired kept claim", JSON.stringify({ code: "ABC123", key: "old-key", at: Date.now() - 3_600_000 })],
    ["a fresh kept claim for a dead code", JSON.stringify({ code: "ZZZ999", key: "k", at: Date.now() })],
    ["a kept claim with the wrong shape", JSON.stringify({ code: 7, key: null })],
  ];
  for (const [name, value] of GARBAGE) {
    test(`c) ${name} in every key, then a scan approves with content`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 3,
      });
      const seed = await context.newPage();
      await seed.goto("/code");
      await seed.evaluate(
        ([v]) => {
          localStorage.setItem("bloop.pid", v as string);
          for (const k of ["bloop.sid", "bloop.resume", "bloop.nonce"]) sessionStorage.setItem(k, v as string);
        },
        [value],
      );
      const screen = await open(browser, "screen", "/s?mode=demo");
      const code = await typedCodeOf(screen.page);
      const errors = errorsOf(seed);
      // Same tab, so the seeded sessionStorage is the page's own.
      await seed.goto(`/a?c=${code}`);
      await expectApproved(seed, errors);
    });
  }

  test("c2) a kept claim in the same tab with no code in the address is replayed or shown, never blank", async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const errors = errorsOf(page);
    await page.goto("/code");
    await page.evaluate(() =>
      sessionStorage.setItem("bloop.resume", JSON.stringify({ code: "ZZZ999", key: "k", at: Date.now() })),
    );
    await page.goto("/a");
    await expect(heading(page)).toBeVisible();
    await expect(page.locator("body")).not.toHaveText(/^\s*Back\s*$/);
    expect(errors).toEqual([]);
  });

  test("d) bare /a with a stale pid, then a new code approves with content", async ({ browser }) => {
    const { phone } = await firstSession(browser);
    await phone.page.getByRole("button", { name: "Revoke" }).click();
    await phone.page
      .getByRole("dialog", { name: "End This Session?" })
      .getByRole("button", { name: "End Session" })
      .click();
    const stale = await phone.context.newPage();
    const staleErrors = errorsOf(stale);
    await stale.goto("/a");
    await expect(heading(stale)).toBeVisible();
    await expect(stale.locator("body")).not.toHaveText(/^\s*Back\s*$/);
    expect(staleErrors).toEqual([]);
    const screen = await open(browser, "screen", "/s?mode=demo");
    const code = await typedCodeOf(screen.page);
    await stale.goto(`/a?c=${code}`);
    await expectApproved(stale, staleErrors);
  });

  test("e) the one-device walk with a stale sid in the tab: Approve leaves for the screen, never blank", async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const errors = errorsOf(page);
    await page.goto("/s?mode=demo");
    const code = await typedCodeOf(page);
    await page.evaluate(() => localStorage.setItem("bloop.pid", "stale.pid"));
    await page.goto(`/a?c=${code}`);
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page).toHaveURL(/\/s\?mode=demo/);
    await expect(heading(page)).toBeVisible();
    expect(errors).toEqual([]);
  });
});
