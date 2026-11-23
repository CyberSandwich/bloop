// The pairing flow in two browser contexts: the room screen at 1440 and a phone at 390. Runs in CI only
// (headless Chrome cannot start in the local sandbox). The demo mode needs no account, so the whole
// flow is drivable; `npm run dev` runs with TEST_TIMING=1 here (playwright.config.ts), which skips the
// platform rate limits that ten fresh screens a minute would trip.
import AxeBuilder from "@axe-core/playwright";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";

const SCREEN = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

interface Opened {
  context: BrowserContext;
  page: Page;
  csp: string[];
}

async function open(browser: Browser, kind: "screen" | "phone", path: string): Promise<Opened> {
  const context = await browser.newContext(
    kind === "screen"
      ? { viewport: SCREEN }
      : { viewport: PHONE, hasTouch: true, isMobile: true, deviceScaleFactor: 3 },
  );
  const page = await context.newPage();
  const csp: string[] = [];
  page.on("console", (m) => {
    if (m.text().includes("Content Security Policy")) csp.push(m.text());
  });
  await page.goto(path);
  return { context, page, csp };
}

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const demoScreen = (browser: Browser) => open(browser, "screen", "/s?mode=demo");
/** A live screen on the mock source: the lectern path, which launches PowerPoint (ADR 0003). */
const liveScreen = (browser: Browser) => open(browser, "screen", "/s");
const DEMO_TITLE = "Open Sample deck.pptx here?";
const LIVE = { room: "Unregistered screen", title: "Open Sample deck.pptx on Unregistered screen?" };

async function typedCodeOf(page: Page): Promise<string> {
  await expect(page.locator("#typed-code")).toHaveText(/^[A-Z0-9]{3} [A-Z0-9]{3}$/);
  return ((await page.locator("#typed-code").textContent()) ?? "").replace(/\s/g, "");
}

async function scan(
  browser: Browser,
  screen: Page,
  expected = { room: "Demo room", title: DEMO_TITLE },
): Promise<{ phone: Opened; code: string; match: string }> {
  await expect(heading(screen)).toHaveText(expected.room);
  const code = await typedCodeOf(screen);
  const phone = await open(browser, "phone", `/a?c=${code}`);
  await expect(heading(phone.page)).toHaveText(expected.title);
  const match = ((await phone.page.locator("#match-digits").textContent()) ?? "").trim();
  return { phone, code, match };
}

/** A demo screen shows the sample deck in the page from the moment it is approved (DEMO-01). */
async function expectDemoSlides(page: Page) {
  await expect(heading(page)).toHaveText("Sample deck.pptx");
  await expect(page.locator("#line")).toHaveText("On a room PC this opens in PowerPoint.");
  await expect(page.getByRole("img", { name: "Slide 1 of 2" })).toBeVisible();
}

/** Records every window.open and every navigation away, so a test can assert the demo launches nothing. */
async function watchLaunches(page: Page): Promise<() => Promise<{ opened: number; left: string[] }>> {
  const left: string[] = [];
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame() && !f.url().includes("/s?mode=demo")) left.push(f.url());
  });
  type Watched = { __opened: number; open: () => null };
  await page.evaluate(() => {
    const w = globalThis as unknown as Watched;
    w.__opened = 0;
    w.open = () => {
      w.__opened++;
      return null;
    };
  });
  return async () => ({
    opened: await page.evaluate(() => (globalThis as unknown as Watched).__opened),
    left,
  });
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations).toEqual([]);
}

test.describe("pairing flow", () => {
  test("pair by QR link, match, approve", async ({ browser }) => {
    const screen = await demoScreen(browser);
    await expect(screen.page.locator("#qr-path")).toHaveAttribute("d", /^M/);
    await expectNoAxeViolations(screen.page);

    const { phone, match } = await scan(browser, screen.page);
    expect(match).toMatch(/^[0-9]{2}$/);
    // the code left the address bar and the history entry
    expect(new URL(phone.page.url()).search).toBe("");
    await expect(phone.page.locator("#room-name")).toHaveText("Demo room");
    await expectNoAxeViolations(phone.page);

    await expect(heading(screen.page)).toHaveText("Check your phone.");
    // The phone's title above means it has listed its files, so the screen is past scanned and in choosing
    // (design.md, screen page states); the match code stays beside the line.
    await expect(screen.page.locator("#line")).toHaveText("Choose a file, then tap Approve.");
    await expect(screen.page.locator("#match")).toHaveText(match);
    await expect(screen.page.locator("#chip")).toContainText("Scanned");
    await expect(screen.page.getByRole("button", { name: "Start Over" })).toBeVisible();
    await expectNoAxeViolations(screen.page);

    await phone.page.getByRole("button", { name: "Approve" }).click();
    // The demo screen fetches its own link, so the phone may already read Open.
    await expect(heading(phone.page)).toHaveText(/^(Opening on|Open on) Demo room\.$/);
    await expectDemoSlides(screen.page);
    await expect(screen.page.getByRole("button", { name: "Start Over" })).toBeHidden();

    expect([...screen.csp, ...phone.csp]).toEqual([]);
    await screen.context.close();
    await phone.context.close();
  });

  test("pair by typed code", async ({ browser }) => {
    const screen = await demoScreen(browser);
    await expect(heading(screen.page)).toHaveText("Demo room");
    const code = await typedCodeOf(screen.page);
    const phone = await open(browser, "phone", "/code");
    await expectNoAxeViolations(phone.page);

    const field = phone.page.getByLabel("Code");
    const go = phone.page.getByRole("button", { name: "Continue" });
    await expect(go).toBeDisabled();
    await field.fill(code.toLowerCase());
    await expect(field).toHaveValue(`${code.slice(0, 3)} ${code.slice(3)}`);
    await expect(go).toBeEnabled();
    await go.click();

    await expect(phone.page).toHaveURL(/\/a$/);
    await expect(heading(phone.page)).toHaveText(DEMO_TITLE);
    await expect(heading(screen.page)).toHaveText("Check your phone.");
    await screen.context.close();
    await phone.context.close();
  });

  test("a wrong typed code shows the error beside the field", async ({ browser }) => {
    const phone = await open(browser, "phone", "/code");
    await phone.page.getByLabel("Code").fill("222 222");
    await phone.page.getByRole("button", { name: "Continue" }).click();
    await expect(phone.page.locator("#code-error")).toContainText("Check the code on the screen and try again.");
    await expect(phone.page.getByLabel("Code")).toHaveAttribute("aria-invalid", "true");
    await expectNoAxeViolations(phone.page);
    await phone.context.close();
  });

  test("Start Over on the screen drops the claim and issues a new code", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const before = await typedCodeOf(screen.page);
    const phone = await open(browser, "phone", `/a?c=${before}`);
    await expect(heading(phone.page)).toHaveText(DEMO_TITLE);

    await screen.page.getByRole("button", { name: "Start Over" }).click();
    await expect(heading(screen.page)).toHaveText("Demo room");
    expect(await typedCodeOf(screen.page)).not.toBe(before);
    await expect(heading(phone.page)).toHaveText("This code has expired.");
    await expect(phone.page.getByRole("link", { name: "Enter a Code" })).toHaveAttribute("href", "/code");
    await expectNoAxeViolations(phone.page);
    await screen.context.close();
    await phone.context.close();
  });

  test("Cancel on the phone returns the screen to its code", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await phone.page.getByRole("button", { name: "Cancel" }).click();
    await expect(heading(phone.page)).toHaveText("Canceled.");
    await expect(phone.page.locator("#body")).toHaveText("Nothing was opened on the screen.");
    await expect(heading(screen.page)).toHaveText("Demo room");
    await screen.context.close();
    await phone.context.close();
  });

  test("replaying a used code is refused", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const { phone, code } = await scan(browser, screen.page);
    const replay = await open(browser, "phone", `/a?c=${code}`);
    await expect(heading(replay.page)).toHaveText("This code was already used.");
    await expect(replay.page.getByRole("link", { name: "Enter a Code" })).toBeVisible();
    // the first phone is unaffected
    await expect(heading(phone.page)).toHaveText(DEMO_TITLE);
    await expectNoAxeViolations(replay.page);
    await screen.context.close();
    await phone.context.close();
    await replay.context.close();
  });

  test("a code that never existed shows as expired on a scan", async ({ browser }) => {
    const phone = await open(browser, "phone", "/a?c=222222");
    await expect(heading(phone.page)).toHaveText("This code has expired.");
    expect(new URL(phone.page.url()).search).toBe("");
    await phone.context.close();
  });

  test("a phone page with no pairing says so", async ({ browser }) => {
    const phone = await open(browser, "phone", "/a");
    await expect(heading(phone.page)).toHaveText("This code has expired.");
    await phone.context.close();
  });

  test("ending shows Ended on both, and the screen's code returns", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expectDemoSlides(screen.page);

    await phone.page.getByRole("button", { name: "End" }).click();
    await expect(heading(phone.page)).toHaveText("Ended.");
    await expect(heading(screen.page)).toHaveText("Ended.");
    await expect(screen.page.locator("#line")).toHaveText("Scan the new code to present.");
    await expectNoAxeViolations(screen.page);
    await expectNoAxeViolations(phone.page);

    await expect(heading(screen.page)).toHaveText("Demo room", { timeout: 15_000 });
    await typedCodeOf(screen.page);

    await phone.page.getByRole("button", { name: "Done" }).click();
    await expect(phone.page).toHaveURL("/");
    await screen.context.close();
    await phone.context.close();
  });

  test("a reloaded screen and a reloaded phone resume their session", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await screen.page.reload();
    await expect(heading(screen.page)).toHaveText("Check your phone.");
    await phone.page.reload();
    await expect(heading(phone.page)).toHaveText(DEMO_TITLE);
    await screen.context.close();
    await phone.context.close();
  });
});

test.describe("guest drop", () => {
  const DECK = "test/fixtures/decks/sample-deck.pptx";

  /** Taps Choose File and answers the browser's file chooser. */
  async function chooseFile(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose File" }).click();
    await (await chooser).setFiles(file);
  }

  test("DEMO-01 flow: a guest sends a file, the screen offers it, and the Open click shows its card, with Download on click", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await expectNoAxeViolations(phone.page);

    await phone.page.getByRole("button", { name: "Send a File Instead" }).click();
    await expect(heading(phone.page)).toHaveText("Send a file to Demo room?");
    await expectNoAxeViolations(phone.page);

    // a wrong type is refused on the phone before a byte leaves it
    await chooseFile(phone.page, {
      name: "notes.exe",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("MZ"),
    });
    await expect(heading(phone.page)).toHaveText("This file can't be sent.");
    await expect(phone.page.locator("#body")).toHaveText("Choose a .pptx or .pdf file under 10 MB.");
    await expectNoAxeViolations(phone.page);

    await chooseFile(phone.page, DECK);
    await expect(heading(phone.page)).toHaveText("Send sample-deck.pptx to Demo room?");
    await expect(phone.page.locator("#body")).toHaveText("bloop deletes its copy when this ends.");
    await phone.page.getByRole("button", { name: "Send" }).click();

    await expect(heading(phone.page)).toHaveText("Sent to Demo room.");
    await expect(heading(screen.page)).toHaveText("sample-deck.pptx");
    await expect(screen.page.locator("#line")).toHaveText("Sent by a guest. Open it here when you're ready.");
    // nothing opens by itself
    await screen.page.waitForTimeout(1500);
    await expect(heading(screen.page)).toHaveText("sample-deck.pptx");
    await expectNoAxeViolations(screen.page);

    const launches = await watchLaunches(screen.page);
    await screen.page.getByRole("button", { name: "Open" }).click();
    await expect(heading(screen.page)).toHaveText("Your file reached the screen.");
    await expect(screen.page.locator(".file-card")).toContainText("sample-deck.pptx");
    await expect(screen.page.locator(".file-card")).toContainText(/\d+ KB/);
    await expect(screen.page.locator("#chip-text")).toHaveText("On Screen");
    await expect(screen.page.locator(".foot")).toBeHidden();
    await expect(heading(phone.page)).toHaveText(/^(Opening on|Open on) Demo room\.$/);
    expect(await launches()).toEqual({ opened: 0, left: [] });
    await expectNoAxeViolations(screen.page);

    // Download mints a fresh link on the click, so it never meets the 2 minute life of the one the screen fetched.
    const saved = screen.page.waitForEvent("download");
    await screen.page.getByRole("button", { name: "Download" }).click();
    expect((await saved).suggestedFilename()).toBe("sample-deck.pptx");
    await expect(heading(screen.page)).toHaveText("Your file reached the screen.");

    await phone.page.getByRole("button", { name: "End" }).click();
    await expect(heading(screen.page)).toHaveText("Ended.");
    await screen.context.close();
    await phone.context.close();
  });

  test("Cancel while the file is chosen returns the screen to its code", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await phone.page.getByRole("button", { name: "Send a File Instead" }).click();
    await phone.page.getByRole("button", { name: "Cancel" }).click();
    await expect(heading(phone.page)).toHaveText("Canceled.");
    await expect(heading(screen.page)).toHaveText("Demo room");
    await screen.context.close();
    await phone.context.close();
  });
});

test.describe("open path", () => {
  test("launch, the Download fallback after 5 s, the PDF view, and End clearing the screen's storage", async ({
    browser,
  }) => {
    const screen = await liveScreen(browser);
    const { phone } = await scan(browser, screen.page, LIVE);
    await phone.page.getByRole("button", { name: "Approve" }).click();

    // PowerPoint is not installed here: no fetch arrives, so after the launch timeout Download appears.
    await expect(heading(screen.page)).toHaveText("Opening Sample deck.pptx");
    await expect(screen.page.getByRole("button", { name: "End" })).toBeVisible();
    await expect(phone.page.getByRole("button", { name: "End" })).toBeVisible();
    const download = screen.page.getByRole("button", { name: "Download It Instead" });
    await expect(download).toBeHidden();
    await expect(download).toBeVisible({ timeout: 10_000 });
    await expectNoAxeViolations(screen.page);

    // The download is the first fetch of /f/: the session opens, as the fallback.
    const saved = screen.page.waitForEvent("download");
    await download.click();
    expect((await saved).suggestedFilename()).toBe("Sample-deck.pptx");
    await expect(heading(screen.page)).toHaveText("PowerPoint didn't open.");
    await expect(screen.page.getByRole("button", { name: "Show as PDF Instead" })).toBeVisible();
    await expect(heading(phone.page)).toHaveText("PowerPoint didn't open on the screen.");
    await expectNoAxeViolations(screen.page);

    // The labeled PDF view opens in a second window under the PDF route's own CSP.
    // Asserted on the request, not the popup's URL: headless Chromium has no PDF viewer, so the popup
    // downloads the file and never commits a navigation that would give it that URL.
    const pdf = screen.context.waitForEvent("request", (r) => r.url().includes("/f/"));
    await screen.page.getByRole("button", { name: "Show as PDF Instead" }).click();
    expect((await pdf).url()).toMatch(/\/f\/[A-Za-z0-9_-]{54}\/Sample-deck\.pdf$/);
    await expect(heading(screen.page)).toHaveText("Showing Sample deck.pptx as a PDF.");

    // End: the screen forgets its credential, and every link is dead.
    await screen.page.getByRole("button", { name: "End" }).click();
    await expect(heading(screen.page)).toHaveText("Ended.");
    expect(await screen.page.evaluate(() => sessionStorage.getItem("bloop.sid"))).toBeNull();
    await expect(heading(phone.page)).toHaveText("Ended.");
    await screen.context.close();
    await phone.context.close();
  });
});

test.describe("demo result", () => {
  test("DEMO-01 flow: the demo screen shows the sample deck in the page, launches nothing, and a reload still shows it", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    const launches = await watchLaunches(screen.page);
    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expectDemoSlides(screen.page);
    // The page's own fetch of the link stands in for PowerPoint's, so the session reaches open.
    await expect(heading(phone.page)).toHaveText("Open on Demo room.");
    expect(await launches()).toEqual({ opened: 0, left: [] });
    await expectNoAxeViolations(screen.page);

    // Click and the arrow keys step through the slides; Full Screen is there.
    await screen.page.getByRole("button", { name: "Next slide" }).click();
    await expect(screen.page.getByRole("img", { name: "Slide 2 of 2" })).toBeVisible();
    await screen.page.keyboard.press("ArrowLeft");
    await expect(screen.page.getByRole("img", { name: "Slide 1 of 2" })).toBeVisible();
    await expect(screen.page.getByRole("button", { name: "Full Screen" })).toBeVisible();

    await screen.page.reload();
    await expectDemoSlides(screen.page);

    await screen.page.getByRole("button", { name: "End" }).click();
    await expect(heading(screen.page)).toHaveText("Ended.");
    await expect(heading(phone.page)).toHaveText("Ended.");
    expect([...screen.csp, ...phone.csp]).toEqual([]);
    await screen.context.close();
    await phone.context.close();
  });

  test("DEMO-01 round trip: one phone-width tab approves on itself and comes back to the slides", async ({
    browser,
  }) => {
    const phone = await open(browser, "phone", "/s?mode=demo");
    await expect(heading(phone.page)).toHaveText("Demo room");
    await expect(phone.page.locator("#qr")).toBeHidden();
    await expectNoAxeViolations(phone.page);

    await phone.page.getByRole("link", { name: "Approve on This Device" }).click();
    await expect(phone.page).toHaveURL(/\/a$/);
    await expect(heading(phone.page)).toHaveText(DEMO_TITLE);
    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expect(heading(phone.page)).toHaveText(/^(Opening on|Open on) Demo room\.$/);

    await phone.page.getByRole("link", { name: "See It on the Screen" }).click();
    await expect(phone.page).toHaveURL(/\/s\?mode=demo$/);
    await expectDemoSlides(phone.page);
    await expectNoAxeViolations(phone.page);

    await phone.page.getByRole("button", { name: "End" }).click();
    await expect(heading(phone.page)).toHaveText("Ended.");
    expect(phone.csp).toEqual([]);
    await phone.context.close();
  });

  test("DEMO-01 isolation: a second tab of the same browser starts its own demo screen, never the first one's", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const first = await typedCodeOf(screen.page);
    const second = await screen.context.newPage();
    await second.goto("/s?mode=demo");
    expect(await typedCodeOf(second)).not.toBe(first);
    await screen.context.close();
  });
});

test.describe("screen page", () => {
  test("a phone-width window gets the redirect message and starts no session", async ({ browser }) => {
    const context = await browser.newContext({ viewport: PHONE });
    const page = await context.newPage();
    const created: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/screens")) created.push(r.url());
    });
    await page.goto("/s");
    await expect(page.getByText("Open this on the room's screen.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Enter a Code" })).toHaveAttribute("href", "/code");
    await expect(page.locator("#qr")).toBeHidden();
    await expectNoAxeViolations(page);
    expect(created).toEqual([]);
    await context.close();
  });

  test("F16 DEMO-02 a demo screen refused by the caps says so, and starts by itself once there is room", async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: SCREEN });
    const page = await context.newPage();
    await page.route("**/api/screens", (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/problem+json",
        body: JSON.stringify({ type: "about:blank", status: 429, code: "rate_limited" }),
      }),
    );
    await page.goto("/s?mode=demo");
    await expect(heading(page)).toHaveText("Too many demos open right now.");
    await expect(page.locator("#line")).toHaveText("Try again in a few minutes.");
    await page.unroute("**/api/screens");
    // The first retry waits 5 s.
    await expect(heading(page)).toHaveText("Demo room", { timeout: 10_000 });
    await context.close();
  });

  test("the QR is one path in a 41 module square with the required label", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const code = await typedCodeOf(screen.page);
    const svg = screen.page.locator("#qr");
    await expect(svg).toHaveAttribute("viewBox", "0 0 41 41");
    const label = (await svg.getAttribute("aria-label")) ?? "";
    expect(label).toContain("QR code. Scan it with your phone camera to open bloop.");
    expect(label).toContain([...code.slice(0, 3)].join(" "));
    expect(await screen.page.locator("#qr path").count()).toBe(1);
    const box = await svg.boundingBox();
    expect(box?.width).toBeGreaterThan(300);
    expect(Number.isInteger((box?.width ?? 0) / 41)).toBe(true);
    await screen.context.close();
  });

  test("SITE-01 frame: the page is not frameable", async ({ browser, baseURL }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    // The framing document is about:blank: setContent on one of our pages writes HTML, which their
    // Trusted Types policy refuses, and their own CSP would block the frame before the target's headers could.
    await page.setContent(`<iframe id="f" src="${new URL("/a", baseURL)}"></iframe>`);
    // a refused frame stays at about:blank, or an error document, and never shows the page
    await page.waitForTimeout(1000);
    const frame = page.frames().find((f) => f !== page.mainFrame());
    expect(await frame?.locator("#title").count()).toBe(0);
    await context.close();
  });
});
