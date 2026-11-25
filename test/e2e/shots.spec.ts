// The screenshot tour: every surface in every state the app reaches, at seven viewports, as CI artifacts
// (test-results/shots/<surface>-<state>-<w>x<h>.png). Headless Chrome cannot run locally, so this is how a change is
// looked at by eye. Opt-in: set TOUR=1 (ci.yml sets it on `*-shots` branches); a normal run skips it.
// The page under test takes the viewport; the other side of a pairing keeps a fixed size (PHONE or SCREEN).
// Shots assert only what is needed to be in the state: the layout checks live in flow.spec.ts.

import { expect, type Page, test } from "@playwright/test";
import {
  addFile,
  demoScreenAt,
  deviceOf,
  heading,
  openAt,
  PHONE,
  revoke,
  SCREEN,
  scanAt,
  type Viewport,
} from "./pairing";

const VIEWPORTS: Viewport[] = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 844, height: 390 },
  { width: 834, height: 1194 },
  { width: 1080, height: 1920 },
  { width: 1440, height: 900 },
];

/** The screen page is a real screen from 600 wide; under it, the page asks for the room's screen. */
const SCREEN_MIN = 600;
/** The landing's links fold into the Menu button under 640. */
const NAV_MIN = 640;
const DECK = "test/fixtures/decks/sample-deck.pptx";

test.skip(!process.env.TOUR, "the screenshot tour runs only with TOUR=1");

for (const v of VIEWPORTS) {
  test.describe(`${v.width}x${v.height}`, () => {
    test.describe.configure({ timeout: 90_000 });
    test.use(deviceOf(v));

    /** One screenshot of the page under test, named for its surface and state; `full` takes the whole document. */
    const shoot = async (page: Page, name: string, full = false) => {
      await page.evaluate("document.fonts.ready");
      await page.waitForTimeout(500);
      await page.screenshot({
        path: `test-results/shots/${name}-${v.width}x${v.height}.png`,
        fullPage: full,
        animations: "disabled",
      });
    };

    test("landing", async ({ page }) => {
      await page.goto("/");
      await shoot(page, "landing-top");
      await page.evaluate("window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) / 2)");
      await shoot(page, "landing-mid");
      await page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)");
      await shoot(page, "landing-close");
      if (v.width < NAV_MIN) {
        await page.evaluate("window.scrollTo(0, 0)");
        await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Menu" }).click();
        await shoot(page, "landing-menu");
      }
    });

    test("documents", async ({ page }) => {
      for (const [name, path] of [
        ["articles", "/articles"],
        ["article", "/articles/how-bloop-works"],
        ["privacy", "/privacy"],
        ["terms", "/terms"],
        ["security", "/security"],
      ] as const) {
        await page.goto(path);
        await shoot(page, `${name}-top`);
        await shoot(page, `${name}-full`, true);
      }
    });

    test("code page", async ({ page }) => {
      await page.goto("/code");
      await shoot(page, "code-empty");
      const field = page.getByLabel("Code");
      await field.fill("K7M2PQ");
      await shoot(page, "code-typed");
      await field.fill("K7O");
      await expect(page.locator("#code-error")).toBeVisible();
      await shoot(page, "code-invalid");
      await field.fill("222 222");
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.locator("#code-error")).toContainText("Check the code on the screen.");
      await shoot(page, "code-refused");
    });

    test("error pages", async ({ page }) => {
      await page.goto("/no-such-page");
      await shoot(page, "error-404");
      await page.goto("/a");
      await expect(heading(page)).toHaveText("Scan the Code");
      await shoot(page, "a-scan");
      await page.goto("/a?c=222222");
      await expect(heading(page)).toHaveText("This Code Has Expired");
      await shoot(page, "a-expired");
      // The service refusing every call: the phone page's dead end for a code it cannot check.
      await page.route("**/api/**", (route) => route.fulfill({ status: 503, body: "" }));
      await page.goto("/a?c=222222");
      await shoot(page, "a-down");
    });

    test("screen page, no session", async ({ browser }) => {
      for (const [state, setup] of [
        [
          "capped",
          (p: Page) =>
            p.route("**/api/screens", (r) =>
              r.fulfill({
                status: 429,
                contentType: "application/problem+json",
                body: JSON.stringify({ type: "about:blank", status: 429, code: "rate_limited" }),
              }),
            ),
        ],
        ["down", (p: Page) => p.route("**/api/screens", (r) => r.fulfill({ status: 503, body: "" }))],
      ] as const) {
        const context = await browser.newContext(deviceOf(v));
        const page = await context.newPage();
        await setup(page);
        await page.goto("/s?mode=demo");
        await shoot(page, `s-${state}`);
        await context.close();
      }
      // Offline after the screen has its code: the live view drops and says so.
      if (v.width < SCREEN_MIN) {
        const narrow = await openAt(browser, v, "/s?mode=demo");
        await expect(narrow.page.getByText("Use the Room's Screen")).toBeVisible();
        await shoot(narrow.page, "s-narrow");
        await narrow.context.close();
        return;
      }
      const screen = await demoScreenAt(browser, v);
      await screen.context.setOffline(true);
      await screen.page.waitForTimeout(6000);
      await shoot(screen.page, "s-offline");
      await screen.context.close();
    });

    test("screen page, owner session", async ({ browser }) => {
      test.skip(v.width < SCREEN_MIN, "under 600 the screen page asks for the room's screen (s-narrow)");
      const screen = await demoScreenAt(browser, v);
      await shoot(screen.page, "s-code");
      const phone = await scanAt(browser, screen.page, PHONE);
      await expect(screen.page.locator("#match")).toBeVisible();
      await shoot(screen.page, "s-claimed");
      await phone.page.getByRole("button", { name: "Approve" }).click();
      await expect(screen.page.locator("#items > li .item")).toHaveCount(4);
      await shoot(screen.page, "s-viewer");
      await screen.page.getByRole("button", { name: "Present", exact: true }).click();
      await expect(screen.page.locator("body")).toHaveClass(/is-presenting/);
      await shoot(screen.page, "s-presenting");
      await screen.page.keyboard.press("Escape");
      await revoke(phone.page);
      await expect(heading(screen.page)).toHaveText("Session Ended");
      await shoot(screen.page, "s-ended");
      await screen.context.close();
      await phone.context.close();
    });

    test("screen page, guest offer", async ({ browser }) => {
      test.skip(v.width < SCREEN_MIN, "under 600 the screen page asks for the room's screen (s-narrow)");
      const screen = await demoScreenAt(browser, v);
      const phone = await scanAt(browser, screen.page, PHONE);
      await addFile(phone.page, DECK);
      await phone.page.getByRole("button", { name: "Send" }).click();
      await expect(heading(screen.page)).toHaveText("Sent by a Guest");
      await shoot(screen.page, "s-offer");
      await screen.page.getByRole("button", { name: "Open" }).click();
      await expect(screen.page.locator(".item-card")).toContainText("PowerPoint");
      await shoot(screen.page, "s-open-card");
      await screen.context.close();
      await phone.context.close();
    });

    test("phone page, owner session", async ({ browser }) => {
      const screen = await demoScreenAt(browser, SCREEN);
      const phone = await scanAt(browser, screen.page, v);
      const page = phone.page;
      await shoot(page, "a-offer");
      await page.getByRole("button", { name: "Approve" }).click();
      await expect(heading(page)).toHaveText("Approved for Demo Room");
      await expect(page.locator(".preview")).toBeVisible();
      await shoot(page, "a-approved");

      const bubbles = page.getByRole("group", { name: "The Screen" });
      await bubbles.getByRole("button", { name: "Present" }).click();
      await expect(screen.page.locator("body")).toHaveClass(/is-presenting/);
      await expect(bubbles.getByRole("button", { name: "Stop" })).toBeVisible();
      await shoot(page, "a-presenting");
      await bubbles.getByRole("button", { name: "Stop" }).click();
      await expect(screen.page.locator("body")).not.toHaveClass(/is-presenting/);

      await page.getByRole("button", { name: /Change the Session Expiry$/ }).click();
      await expect(page.getByRole("dialog", { name: "Session Expiry" })).toBeVisible();
      await shoot(page, "a-expiry");
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: "Revoke" }).click();
      await expect(page.getByRole("dialog", { name: "End This Session?" })).toBeVisible();
      await shoot(page, "a-revoke");
      await page
        .getByRole("dialog", { name: "End This Session?" })
        .getByRole("button", { name: "End Session" })
        .click();
      await expect(heading(page)).toHaveText("Session Ended");
      await shoot(page, "a-ended");
      await screen.context.close();
      await phone.context.close();
    });

    test("phone page, guest drop", async ({ browser }) => {
      const screen = await demoScreenAt(browser, SCREEN);
      const phone = await scanAt(browser, screen.page, v);
      const page = phone.page;
      await shoot(page, "a-choose");
      await addFile(page, { name: "notes.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
      await expect(page.getByRole("alert")).toContainText("This File Type Isn't Supported");
      await shoot(page, "a-toast");

      await addFile(page, DECK);
      await expect(heading(page)).toHaveText("Send sample-deck.pptx to Demo Room?");
      await shoot(page, "a-send");
      // Held until the shot is taken, so the in-between state is on the page.
      let release = () => {};
      const held = new Promise<void>((done) => {
        release = done;
      });
      await page.route("**/api/drop", async (route) => {
        await held;
        await route.continue();
      });
      await page.getByRole("button", { name: "Send" }).click();
      await expect(heading(page)).toHaveText("Sending sample-deck.pptx");
      await shoot(page, "a-sending");
      release();
      await expect(heading(page)).toHaveText("Sent to Demo Room");
      await shoot(page, "a-sent");
      await screen.context.close();
      await phone.context.close();
    });
  });
}
