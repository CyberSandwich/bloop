// Reaching a paired state in two browser contexts: shared by the screenshot tour. flow.spec.ts keeps its own copies of
// open, typedCodeOf and scan; moving it onto these is a follow-up for whoever owns that file.

import { type Browser, type BrowserContext, expect, type Page } from "@playwright/test";

export interface Viewport {
  width: number;
  height: number;
}

export interface Opened {
  context: BrowserContext;
  page: Page;
}

/** What a device of this size reports: phones (short side under 500) are mobile, tablets only touch. */
export function deviceOf({ width, height }: Viewport) {
  const short = Math.min(width, height);
  return { viewport: { width, height }, hasTouch: short < 1000 && width < 1000, isMobile: short < 500 };
}

export async function openAt(browser: Browser, viewport: Viewport, path: string): Promise<Opened> {
  const context = await browser.newContext(deviceOf(viewport));
  const page = await context.newPage();
  await page.goto(path);
  return { context, page };
}

export const SCREEN: Viewport = { width: 1440, height: 900 };
export const PHONE: Viewport = { width: 390, height: 844 };

export const heading = (page: Page) => page.getByRole("heading", { level: 1 });

export async function typedCodeOf(page: Page): Promise<string> {
  // A new code replaces the old one 150 ms into its swap: until then the card still reads the old, spent code.
  await expect(page.locator("#qr-panel")).not.toHaveClass(/\bis-swapping\b/);
  await expect(page.locator("#typed-code")).toHaveText(/^[A-Z0-9]{3} [A-Z0-9]{3}$/);
  return ((await page.locator("#typed-code").textContent()) ?? "").replace(/\s/g, "");
}

/** A demo room's screen at the given size, showing its code. */
export async function demoScreenAt(browser: Browser, viewport: Viewport): Promise<Opened> {
  const screen = await openAt(browser, viewport, "/s?mode=demo");
  await expect(heading(screen.page)).toHaveText("Demo Room");
  return screen;
}

/** The phone at the given size opens the screen's code link: it holds the claim, Approve is ready. */
export async function scanAt(browser: Browser, screen: Page, viewport: Viewport): Promise<Opened> {
  const code = await typedCodeOf(screen);
  const phone = await openAt(browser, viewport, `/a?c=${code}`);
  await expect(heading(phone.page)).toHaveText("Demo Room");
  await expect(phone.page.getByRole("button", { name: "Approve" })).toBeEnabled();
  return phone;
}

/** Revoke, then End Session in the question it asks first. */
export async function revoke(page: Page) {
  await page.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("dialog", { name: "End This Session?" }).getByRole("button", { name: "End Session" }).click();
}

/** Taps Add a File, which opens the native picker at once, and answers the browser's file chooser. */
export async function addFile(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add a File" }).click();
  await (await chooser).setFiles(file);
}
