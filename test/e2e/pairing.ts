// Pairing helpers shared by the e2e specs: two browser contexts, the room screen at 1440 and a phone at 390.
import AxeBuilder from "@axe-core/playwright";
import { type Browser, type BrowserContext, expect, type Page } from "@playwright/test";

export const SCREEN = { width: 1440, height: 900 };
export const PHONE = { width: 390, height: 844 };

export interface Opened {
  context: BrowserContext;
  page: Page;
  csp: string[];
}

/** `prep` runs before the first load: a route, or an init script. */
export async function open(
  browser: Browser,
  kind: "screen" | "phone",
  path: string,
  prep?: (context: BrowserContext) => Promise<unknown>,
): Promise<Opened> {
  const context = await browser.newContext(
    kind === "screen"
      ? { viewport: SCREEN }
      : { viewport: PHONE, hasTouch: true, isMobile: true, deviceScaleFactor: 3 },
  );
  await prep?.(context);
  const page = await context.newPage();
  const csp: string[] = [];
  page.on("console", (m) => {
    if (m.text().includes("Content Security Policy")) csp.push(m.text());
  });
  await page.goto(path);
  return { context, page, csp };
}

export const heading = (page: Page) => page.getByRole("heading", { level: 1 });

export async function typedCodeOf(page: Page): Promise<string> {
  // A new code replaces the old one 150 ms into its swap: until then the card still reads the old, spent code.
  await expect(page.locator("#qr-panel")).not.toHaveClass(/\bis-swapping\b/);
  await expect(page.locator("#typed-code")).toHaveText(/^[A-Z0-9]{3} [A-Z0-9]{3}$/);
  return ((await page.locator("#typed-code").textContent()) ?? "").replace(/\s/g, "");
}

export async function expectNoAxeViolations(page: Page) {
  // axe blends text with its ancestors' opacity: a pane still fading in (380 ms) reads as low contrast. Wait for the
  // opacity fades only: the QR ring restarts a 1 s transition every second and the spinner never ends. page.evaluate,
  // not waitForFunction: the latter evals a string in the page, which the CSP refuses.
  type Animated = {
    document: { getAnimations(): { playState: string; effect: { getKeyframes(): object[] } | null }[] };
  };
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as unknown as Animated).document
            .getAnimations()
            .filter((a) => a.playState === "running" && a.effect?.getKeyframes().some((k) => "opacity" in k)).length,
      ),
    )
    .toBe(0);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations).toEqual([]);
}

/** The live pick (PAIR-14): reads the number the screen shows and taps it on the phone, as the person does. */
export async function pickMatch(phone: Page, screen: Page): Promise<string> {
  await expect(screen.locator("#match")).toHaveText(/^\d{2}$/);
  const match = ((await screen.locator("#match").textContent()) ?? "").trim();
  await choice(phone, match).click();
  return match;
}

/** One of the pick's three choices on the phone, by its digits. */
export const choice = (phone: Page, digits: string) =>
  phone.getByRole("group", { name: "Tap the Screen's Number" }).getByRole("button", { name: digits, exact: true });
