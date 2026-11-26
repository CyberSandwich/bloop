// Throwaway: screenshots of the states whose CSS the r5 trim moved (ci/p1-r5-shots only, never merged).
import { type Browser, expect, type Page, test } from "@playwright/test";
import { seeder, signedIn } from "./library-seed.ts";
import { heading, typedCodeOf } from "./pairing.ts";

const fixtures = seeder(Date.now());
const member = fixtures.member([["a", "Lecture 5.pptx"]]);
test.beforeAll(() => fixtures.seed());

const SIZES: [number, number][] = [
  [320, 700],
  [390, 844],
  [430, 932],
  [844, 390],
];

const settled = (page: Page) =>
  page.evaluate(async () => {
    const finite = () => document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    do await Promise.allSettled(finite().map((a) => a.finished));
    while (finite().some((a) => a.playState !== "finished"));
  });
const shot = async (page: Page, file: string) => {
  await settled(page);
  await page.screenshot({ path: `test-results/shots/${file}.png` });
};
const at = async (browser: Browser, w: number, h: number, path: string) => {
  const context = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto(path);
  return { context, page };
};
/** A 1x1 black PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

for (const [w, h] of SIZES) {
  const vp = `${w}x${h}`;

  test(`match legend ${vp}`, async ({ browser }) => {
    const screen = await at(browser, 1440, 900, "/s");
    const code = await typedCodeOf(screen.page);
    const phone = await at(browser, w, h, `/a?c=${code}`);
    const buttons = phone.page.locator("#pick").getByRole("button");
    await expect(buttons).toHaveCount(3);
    await phone.page.evaluate("document.fonts.ready");
    await shot(phone.page, `match-legend-${vp}`);
    await phone.page.route("**/api/match", () => {});
    await expect(screen.page.locator("#match")).toHaveText(/^\d{2}$/);
    const digits = ((await screen.page.locator("#match").textContent()) ?? "").trim();
    await phone.page.locator("#pick").getByRole("button", { name: digits, exact: true }).click();
    await expect(phone.page.locator("#pick legend")).toHaveText("Approving...");
    await phone.page.screenshot({ path: `test-results/shots/match-approving-${vp}.png` });
    await phone.context.close();
    await screen.context.close();
  });

  test(`length sheet and Session Ended ${vp}`, async ({ browser }) => {
    test.setTimeout(90_000);
    const screen = await at(browser, w, h, "/s?mode=demo");
    await expect(heading(screen.page)).toHaveText("Demo Room");
    const code = await typedCodeOf(screen.page);
    const phone = await at(browser, w, h, `/a?c=${code}`);
    await phone.page.getByRole("button", { name: /^Approve/ }).click();
    await expect(phone.page.locator("#ends-text")).toHaveText(/^Ends in /);
    await phone.page.evaluate("document.fonts.ready");
    await shot(phone.page, `approved-${vp}`);
    await phone.page.getByRole("button", { name: /Change the Session Expiry$/ }).click();
    await expect(phone.page.getByRole("dialog", { name: "Session Expiry" })).toBeVisible();
    await shot(phone.page, `length-sheet-${vp}`);
    await phone.page.keyboard.press("Escape");
    await expect(phone.page.getByRole("dialog", { name: "Session Expiry" })).toBeHidden();
    await phone.page.getByRole("button", { name: "Revoke" }).click();
    await phone.page
      .getByRole("dialog", { name: "End This Session?" })
      .getByRole("button", { name: "End Session" })
      .click();
    await expect(heading(phone.page)).toHaveText("Session Ended");
    await expect(heading(screen.page)).toHaveText("Session Ended");
    await shot(phone.page, `ended-phone-${vp}`);
    await shot(screen.page, `ended-screen-${vp}`);
    await phone.context.close();
    await screen.context.close();
  });

  test(`sending row loader sheen ${vp}`, async ({ browser }) => {
    const screen = await at(browser, 1440, 900, "/s?mode=demo");
    await expect(heading(screen.page)).toHaveText("Demo Room");
    const code = await typedCodeOf(screen.page);
    const phone = await at(browser, w, h, `/a?c=${code}`);
    await expect(phone.page.getByRole("button", { name: /^Approve/ })).toBeEnabled();
    await phone.page.route("**/api/drop", () => {});
    const chooser = phone.page.waitForEvent("filechooser");
    await phone.page.getByRole("button", { name: "Add a File" }).click();
    await (await chooser).setFiles({
      name: "A long holiday photo from the beach at sunset.png",
      mimeType: "image/png",
      buffer: PNG,
    });
    await phone.page.getByRole("button", { name: "Send" }).click();
    const row = phone.page.locator("#file-list .row.upload");
    await expect(row.getByRole("progressbar")).toBeVisible();
    await settled(phone.page);
    for (const t of [0, 400, 800]) {
      await phone.page.waitForTimeout(t ? 400 : 0);
      await phone.page.screenshot({ path: `test-results/shots/sheen-row-${vp}-${t}.png` });
    }
    await phone.context.close();
    await screen.context.close();
  });

  test(`upload pill name ${vp}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
    await signedIn(context, member);
    const page = await context.newPage();
    await page.route("**/api/library?*", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.switches = { ...body.switches, uploads: "on" };
      await route.fulfill({ response: res, json: body });
    });
    await page.route("**/api/uploads", (route) => (route.request().method() === "POST" ? undefined : route.continue()));
    await page.goto("/library");
    await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add Files" }).click();
    await (await chooser).setFiles({
      name: "A long lecture recording from the spring term.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: Buffer.alloc(4096, 1),
    });
    await expect(page.locator(".up-pill .up-title")).toBeVisible();
    await page.evaluate("document.fonts.ready");
    await shot(page, `pill-${vp}`);
    await context.close();
  });
}
