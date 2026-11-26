// A tap outside an open popover only closes it (design.md section 6, Overlays): on a touch phone the platform's light
// dismiss lets the tap's click land on what lies under it, so a tap beside the item sheet also turned the slide. CI only.
import { expect, type Page, test } from "@playwright/test";
import { DECK_PAGES, DEMO_ITEMS } from "../../src/shared/demo-catalog.ts";
import { atRest, oneDevice, PHONE } from "./one-device.ts";

test.use(PHONE);

const DECK = DEMO_ITEMS.deck.name;
const at = (n: number) => `${n} / ${DECK_PAGES}`;

/** The one-device demo showing the deck's landscape slides, on the first. */
async function deck(page: Page) {
  await oneDevice(page);
  await expect(page.locator("#dots")).toHaveText(at(1));
}

const open = (page: Page) => page.locator("#side").evaluate((n) => n.matches(":popover-open"));

/** A touch tap at a fraction of the slide's width, above the sheet's top edge so it is outside the sheet. */
async function tapSlide(page: Page, at: number) {
  const slide = page.locator("#frame picture img");
  await atRest(page.locator("main"));
  const box = await slide.boundingBox();
  const side = await page.locator("#side").boundingBox();
  if (!box) throw Error("no slide");
  const bottom = (await open(page)) && side ? Math.min(box.y + box.height, side.y) : box.y + box.height;
  const y = (box.y + bottom) / 2;
  expect(y, "the tap lands on the slide, clear of the sheet").toBeLessThan(bottom - 8);
  await page.touchscreen.tap(box.x + box.width * at, y);
}

/** Opens the item sheet from its handle, as a finger does. */
async function openSheet(page: Page) {
  await page.locator("#handle").tap();
  await expect.poll(() => open(page)).toBe(true);
}

/** Past the dismiss's quiet window (core/dismiss.js QUIET_MS), so a late click would have landed by now. */
const settle = (page: Page) => page.waitForTimeout(500);

test("a tap beside the open item sheet only closes it: no slide turns on either side, and a tap with it closed still turns", async ({
  page,
}) => {
  await deck(page);

  await openSheet(page);
  await tapSlide(page, 0.9);
  await settle(page);
  expect(await open(page), "the sheet closed").toBe(false);
  await expect(page.locator("#dots")).toHaveText(at(1));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(DECK);

  // Closed, the same tap turns the slide.
  await tapSlide(page, 0.9);
  await expect(page.locator("#dots")).toHaveText(at(2));

  await openSheet(page);
  await tapSlide(page, 0.1);
  await settle(page);
  expect(await open(page), "the sheet closed").toBe(false);
  await expect(page.locator("#dots")).toHaveText(at(2));

  await tapSlide(page, 0.1);
  await expect(page.locator("#dots")).toHaveText(at(1));
});

test("a tap on End beside the open logo question only closes the question: the session goes on", async ({ page }) => {
  await deck(page);
  await page.getByRole("button", { name: /^bloop/ }).tap();
  const question = page.getByRole("dialog", { name: "End This Session?" });
  await expect(question).toBeVisible();
  const end = page.getByRole("button", { name: "End", exact: true });
  await atRest(page.locator("body"));
  const box = await end.boundingBox();
  if (!box) throw Error("no End");
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await settle(page);
  await expect(question).toBeHidden();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(DECK);
});
