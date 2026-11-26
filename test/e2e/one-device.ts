// The one-device demo at phone width, shared by the specs that drive its viewer by touch.
import { expect, type Locator, type Page } from "@playwright/test";
import { DEMO_ITEMS } from "../../src/shared/demo-catalog.ts";

export const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

/** Ends every animation under `locator` that has an end (a loader's sheen has none), so a box read next is at rest. */
export const atRest = (locator: Locator) =>
  locator.evaluate((el) => {
    for (const a of el.getAnimations({ subtree: true }))
      if (a.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY) a.finish();
  });

export const heading = (page: Page) => page.getByRole("heading", { level: 1 });

/** Picks a file from the item sheet, opened from its handle, as a finger does. */
export async function pick(page: Page, name: string) {
  await page.locator("#handle").tap();
  await page
    .locator("#items")
    .getByRole("button", { name: new RegExp(`^${name.replace(".", "\\.")}`) })
    .tap();
  await expect(heading(page)).toHaveText(name);
}

/** The demo approved on the phone itself, showing its first file, the deck. */
export async function oneDevice(page: Page) {
  await page.goto("/s?mode=demo");
  await page.getByRole("link", { name: "Approve on This Phone" }).tap();
  await page.getByRole("button", { name: "Approve" }).tap();
  await expect(heading(page)).toHaveText(DEMO_ITEMS.deck.name);
}
