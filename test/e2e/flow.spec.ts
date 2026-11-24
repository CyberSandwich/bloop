// The pairing flow in two browser contexts: the room screen at 1440 and a phone at 390. Runs in CI only
// (headless Chrome cannot start in the local sandbox). The demo mode needs no account, so the whole
// flow is drivable; `npm run dev` runs with TEST_TIMING=1 here (playwright.config.ts), which skips the
// platform rate limits that ten fresh screens a minute would trip. Selectors are roles and names first, ids where
// the page names a slot (docs/design.md section 7).
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
const DEMO = { room: "Demo Room", title: "Demo Room" };
const LIVE = { room: "Unregistered screen", title: "Unregistered screen" };
/** The demo catalog as the viewer orders it: files by name, then links by title. */
const CATALOG = ["Dog.jpg", "Sample deck.pdf", "Sample deck.pptx", "Vevox"];

async function typedCodeOf(page: Page): Promise<string> {
  await expect(page.locator("#typed-code")).toHaveText(/^[A-Z0-9]{3} [A-Z0-9]{3}$/);
  return ((await page.locator("#typed-code").textContent()) ?? "").replace(/\s/g, "");
}

async function scan(
  browser: Browser,
  screen: Page,
  expected = DEMO,
): Promise<{ phone: Opened; code: string; match: string }> {
  await expect(heading(screen)).toHaveText(expected.room);
  const code = await typedCodeOf(screen);
  const phone = await open(browser, "phone", `/a?c=${code}`);
  await expect(heading(phone.page)).toHaveText(expected.title);
  await expect(phone.page.getByRole("button", { name: "Approve" })).toBeEnabled();
  // The match digits ride on the Approve button: "Approve (42)", named "Approve, code 42 on the screen".
  const approve = phone.page.getByRole("button", { name: /^Approve, code \d{2} on the screen$/ });
  await expect(approve).toHaveText(/^Approve \(\d{2}\)$/);
  const label = (await approve.textContent()) ?? "";
  const match = label.match(/\d{2}/)?.[0] ?? "";
  return { phone, code, match };
}

/** A row's accessible name starts with the item's name, then its kind line. */
const startsWith = (name: string) => new RegExp(`^${name.replace(".", "\\.")}`);
const sidebarItem = (page: Page, name: string) =>
  page.locator("#items").getByRole("button", { name: startsWith(name) });

/** The demo viewer from approval: the sidebar with the whole catalog, and the first item (the photo) on the stage. */
async function expectViewer(page: Page) {
  await expect(page.locator("#items button")).toHaveCount(CATALOG.length);
  for (const name of CATALOG) await expect(sidebarItem(page, name)).toBeVisible();
  await expect(heading(page)).toHaveText("Dog.jpg");
  await expect(page.getByRole("img", { name: "Dog.jpg" })).toBeVisible();
  await expect(page.getByRole("button", { name: "End", exact: true })).toBeVisible();
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
    await expect(screen.page.getByText("Scan with your phone.")).toBeVisible();
    await expect(screen.page.getByText("Or enter the code at")).toBeVisible();
    await expectNoAxeViolations(screen.page);
    const titleBefore = await heading(screen.page).boundingBox();
    const cardBefore = await screen.page.locator("#qr-panel").boundingBox();

    const { phone, match } = await scan(browser, screen.page);
    expect(match).toMatch(/^[0-9]{2}$/);
    // the code left the address bar and the history entry
    expect(new URL(phone.page.url()).search).toBe("");
    await expect(phone.page.getByRole("list", { name: "Items" })).toBeVisible();
    await expect(phone.page.locator("#file-list input[type=checkbox]:checked")).toHaveCount(CATALOG.length);
    await expect(phone.page.locator("#file-list li:has(input) .row-name")).toHaveText(CATALOG);
    await expect(phone.page.getByRole("button", { name: "Add a File" })).toBeVisible();
    await expectNoAxeViolations(phone.page);

    await expect(heading(screen.page)).toHaveText(DEMO.room);
    await expect(screen.page.locator("#compare")).toHaveText(/^Your phone shows \d{2}\.$/);
    // The claim changes the state in place: the QR card stays where it was, dimmed under a phone glyph.
    await expect(screen.page.locator("#match")).toBeVisible();
    await expect(screen.page.locator("#qr-panel")).toHaveCSS("visibility", "visible");
    await expect(screen.page.locator("#line")).toHaveText(`Your phone shows ${match}.`);
    // The digits read across the room, in the hint's place; nothing else moves.
    const compare = screen.page.locator("#compare");
    await expect(compare).toHaveText(`Your phone shows ${match}.`);
    await expect(compare).toHaveCSS("font-size", "40px");
    expect(await heading(screen.page).boundingBox()).toEqual(titleBefore);
    expect(await screen.page.locator("#qr-panel").boundingBox()).toEqual(cardBefore);
    await expect(screen.page.getByRole("button", { name: "Back", exact: true })).toBeVisible();
    await expectNoAxeViolations(screen.page);

    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expect(heading(phone.page)).toHaveText("Approved for Demo Room");
    await expect(phone.page.locator("#ends")).toHaveText(/^Ends in \d+:\d{2}$/);
    await expect(phone.page.getByRole("button", { name: "Revoke" })).toBeVisible();
    // In a session Revoke is the phone's one way out.
    await expect(phone.page.getByRole("link", { name: "Back", exact: true })).toBeHidden();
    await expectViewer(screen.page);
    await expect(screen.page.getByRole("button", { name: "Back", exact: true })).toBeHidden();

    expect([...screen.csp, ...phone.csp]).toEqual([]);
    await screen.context.close();
    await phone.context.close();
  });

  test("pair by typed code", async ({ browser }) => {
    const screen = await demoScreen(browser);
    await expect(heading(screen.page)).toHaveText("Demo Room");
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
    await expect(heading(phone.page)).toHaveText(DEMO.title);
    await expect(screen.page.locator("#compare")).toHaveText(/^Your phone shows \d{2}\.$/);
    await screen.context.close();
    await phone.context.close();
  });

  test("a wrong typed code shows the error beside the field", async ({ browser }) => {
    const phone = await open(browser, "phone", "/code");
    // The error line keeps its row: the first bad letter never moves Continue.
    const before = await phone.page.getByRole("button", { name: "Continue" }).boundingBox();
    await phone.page.getByLabel("Code").fill("K7O");
    await expect(phone.page.locator("#code-error")).toBeVisible();
    expect(await phone.page.getByRole("button", { name: "Continue" }).boundingBox()).toEqual(before);
    await phone.page.getByLabel("Code").fill("222 222");
    await phone.page.getByRole("button", { name: "Continue" }).click();
    await expect(phone.page.locator("#code-error")).toContainText("Check the code on the screen and try again.");
    await expect(phone.page.getByLabel("Code")).toHaveAttribute("aria-invalid", "true");
    await expectNoAxeViolations(phone.page);
    // A look-alike the alphabet leaves out is named as soon as it is typed.
    await phone.page.getByLabel("Code").fill("K7O");
    await expect(phone.page.locator("#code-error")).toContainText("Codes don't use 0, 1, I, L, O or U.");
    await phone.context.close();
  });

  test("Back on the phone before approving lets go of the claim, and the screen shows its code again", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await expect(screen.page.locator("#compare")).toHaveText(/^Your phone shows \d{2}\.$/);
    await phone.page.getByRole("link", { name: "Back" }).click();
    await expect(phone.page).toHaveURL("/");
    await expect(heading(screen.page)).toHaveText("Demo Room");
    expect(await phone.page.evaluate(() => localStorage.getItem("bloop.pid"))).toBeNull();
    await screen.context.close();
    await phone.context.close();
  });

  test("Back on a waiting screen ends it first, so its code is dead at once, and opens no screen on its way out", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const code = await typedCodeOf(screen.page);
    let created = 0;
    screen.page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/api/screens") created += 1;
    });
    await screen.page.getByRole("link", { name: "Back", exact: true }).click();
    await expect(screen.page).toHaveURL("/");
    await screen.page.waitForLoadState("networkidle");
    expect(created).toBe(0);
    const phone = await open(browser, "phone", `/a?c=${code}`);
    await expect(heading(phone.page)).toHaveText("This Code Has Expired");
    await screen.context.close();
    await phone.context.close();
  });

  test("Back on a claimed screen drops the claim and issues a new code", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const before = await typedCodeOf(screen.page);
    const phone = await open(browser, "phone", `/a?c=${before}`);
    await expect(heading(phone.page)).toHaveText(DEMO.title);

    await screen.page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(heading(screen.page)).toHaveText("Demo Room");
    expect(await typedCodeOf(screen.page)).not.toBe(before);
    await expect(heading(phone.page)).toHaveText("This Code Has Expired");
    // One exit, a full button: no Back beside it.
    await expect(phone.page.getByRole("link", { name: "Enter the Code" })).toHaveAttribute("href", "/code");
    await expect(phone.page.getByRole("link", { name: "Enter the Code" })).toHaveClass(/\bprimary\b/);
    await expect(phone.page.getByRole("link", { name: "Back", exact: true })).toBeHidden();
    await expectNoAxeViolations(phone.page);
    await screen.context.close();
    await phone.context.close();
  });

  test("Cancel on the phone returns the screen to its code", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await phone.page.getByRole("button", { name: "Cancel" }).click();
    await expect(heading(phone.page)).toHaveText("Approval Canceled");
    await expect(phone.page.locator("#body")).toHaveText("Nothing was shared.");
    // A terminal state has one way out: Done, no Back.
    await expect(phone.page.getByRole("link", { name: "Back", exact: true })).toBeHidden();
    await expect(phone.page.getByRole("button", { name: "Done" })).toBeVisible();
    await expect(heading(screen.page)).toHaveText("Demo Room");
    await screen.context.close();
    await phone.context.close();
  });

  test("replaying a used code is refused", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const { phone, code } = await scan(browser, screen.page);
    const replay = await open(browser, "phone", `/a?c=${code}`);
    await expect(heading(replay.page)).toHaveText("This Code Was Already Used");
    await expect(replay.page.getByRole("link", { name: "Enter the Code" })).toBeVisible();
    // the first phone is unaffected
    await expect(heading(phone.page)).toHaveText(DEMO.title);
    await expectNoAxeViolations(replay.page);
    await screen.context.close();
    await phone.context.close();
    await replay.context.close();
  });

  test("a code that never existed shows as expired on a scan", async ({ browser }) => {
    const phone = await open(browser, "phone", "/a?c=222222");
    await expect(heading(phone.page)).toHaveText("This Code Has Expired");
    expect(new URL(phone.page.url()).search).toBe("");
    await phone.context.close();
  });

  test("a phone page with no pairing asks for a scan", async ({ browser }) => {
    const phone = await open(browser, "phone", "/a");
    await expect(heading(phone.page)).toHaveText("Scan the Code");
    await phone.context.close();
  });

  test("Back shows at 390 on /a and /code: the narrow-screen swap is the room screen's only", async ({ browser }) => {
    for (const path of ["/a", "/code"]) {
      const phone = await open(browser, "phone", path);
      await expect(phone.page.getByRole("link", { name: "Back", exact: true }), path).toBeVisible();
      await phone.context.close();
    }
  });

  test("Revoke on the phone shows Session Ended on the screen alone, then its code returns", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expectViewer(screen.page);

    await phone.page.getByRole("button", { name: "Revoke" }).click();
    await expect(heading(phone.page)).toHaveText("Session Ended");
    // PAIR-12: the ended view itself drops the pid; Done has not run yet.
    expect(await phone.page.evaluate(() => localStorage.getItem("bloop.pid"))).toBeNull();
    await expect(heading(screen.page)).toHaveText("Session Ended");
    // The demo says why it ended, the moment that proves Revoke.
    await expect(screen.page.locator("#line")).toHaveText("Revoked from the phone.");
    await expect(screen.page.locator("#items")).toBeHidden();
    await expect(screen.page.getByRole("button", { name: "End", exact: true })).toBeHidden();
    // The demo's one way on: the waitlist.
    await expect(screen.page.getByRole("link", { name: "Join the Waitlist" })).toBeVisible();
    // Session Ended sits at the true center of the viewport.
    const box = await heading(screen.page).boundingBox();
    const view = screen.page.viewportSize();
    expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) / 2 - (view?.width ?? 0) / 2)).toBeLessThan(2);
    expect(Math.abs((box?.y ?? 0) + (box?.height ?? 0) / 2 - (view?.height ?? 0) / 2)).toBeLessThan(40);
    await expectNoAxeViolations(screen.page);
    await expectNoAxeViolations(phone.page);

    // The demo holds Session Ended for 10 s (its waitlist link), then shows a code again.
    await expect(heading(screen.page)).toHaveText("Demo Room", { timeout: 20_000 });
    await typedCodeOf(screen.page);

    await phone.page.getByRole("button", { name: "Done" }).click();
    await expect(phone.page).toHaveURL("/");
    // With no pid, /a with no code asks for a scan.
    await phone.page.goto("/a");
    await expect(heading(phone.page)).toHaveText("Scan the Code");
    await screen.context.close();
    await phone.context.close();
  });

  test("PAIR-12 a phone that comes back to a session ended while it was away drops its pid", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expectViewer(screen.page);
    await phone.page.goto("about:blank");
    await screen.page.getByRole("button", { name: "End", exact: true }).click();
    await expect(heading(screen.page)).toHaveText("Session Ended");
    await phone.page.goto("/a");
    await expect(heading(phone.page)).toHaveText("Session Ended");
    expect(await phone.page.evaluate(() => localStorage.getItem("bloop.pid"))).toBeNull();
    await screen.context.close();
    await phone.context.close();
  });

  for (const viewport of [
    { width: 834, height: 1112 },
    { width: 1440, height: 900 },
  ]) {
    test(`a result at ${viewport.width} centers title, line and Done as one group, Done under the line`, async ({
      browser,
    }) => {
      const screen = await demoScreen(browser);
      const code = await typedCodeOf(screen.page);
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      await page.goto(`/a?c=${code}`);
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(heading(page)).toHaveText("Approval Canceled");
      const title = await heading(page).boundingBox();
      const done = await page.getByRole("button", { name: "Done" }).boundingBox();
      expect(done?.y ?? 0).toBeGreaterThan((title?.y ?? 0) + (title?.height ?? 0));
      // The group's center is the viewport's.
      const center = ((title?.y ?? 0) + (done?.y ?? 0) + (done?.height ?? 0)) / 2;
      expect(Math.abs(center - viewport.height / 2)).toBeLessThan(24);
      await context.close();
      await screen.context.close();
    });
  }

  test("a reloaded screen and a reloaded phone resume their session", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await screen.page.reload();
    await expect(screen.page.locator("#compare")).toHaveText(/^Your phone shows \d{2}\.$/);
    await phone.page.reload();
    await expect(heading(phone.page)).toHaveText(DEMO.title);
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

  test("DEMO-01 flow: a guest adds a file, the screen offers it, and the Open click shows its card, with Download on click", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await expectNoAxeViolations(phone.page);

    await phone.page.getByRole("button", { name: "Add a File" }).click();
    await expect(heading(phone.page)).toHaveText("Send a File to Demo Room?");
    await expectNoAxeViolations(phone.page);

    // a wrong type is refused on the phone before a byte leaves it
    await chooseFile(phone.page, {
      name: "notes.exe",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("MZ"),
    });
    await expect(heading(phone.page)).toHaveText("This File Can't Be Sent");
    await expect(phone.page.locator("#body")).toHaveText("Choose a .pptx or .pdf file under 10 MB.");
    await expectNoAxeViolations(phone.page);

    await chooseFile(phone.page, DECK);
    await expect(heading(phone.page)).toHaveText("Send sample-deck.pptx to Demo Room?");
    await expect(phone.page.locator("#body")).toHaveText("bloop deletes its copy when this ends.");
    await phone.page.getByRole("button", { name: "Send" }).click();

    await expect(heading(phone.page)).toHaveText("Sent to Demo Room");
    await expect(heading(screen.page)).toHaveText("Sent by a Guest");
    await expect(screen.page.locator("#line")).toHaveText("sample-deck.pptx. Open it here when you're ready.");
    // An offer keeps its line, visible and inside the window; only a claim's status moves to the hint's place.
    await expect(screen.page.locator("#line")).toBeVisible();
    await expect(screen.page.locator("#line")).toHaveCSS("clip-path", "none");
    await expect(screen.page.locator("#compare")).toBeEmpty();
    const lineBox = await screen.page.locator("#line").boundingBox();
    expect((lineBox?.x ?? -1) >= 0 && (lineBox?.x ?? 0) + (lineBox?.width ?? 0) <= SCREEN.width).toBe(true);
    // nothing opens by itself
    await screen.page.waitForTimeout(1500);
    await expect(heading(screen.page)).toHaveText("Sent by a Guest");
    await expectNoAxeViolations(screen.page);

    const launches = await watchLaunches(screen.page);
    await screen.page.getByRole("button", { name: "Open" }).click();
    // One item: no sidebar, the file's card on the stage.
    await expect(screen.page.locator(".item-card")).toContainText("PowerPoint");
    await expect(heading(screen.page)).toHaveText("sample-deck.pptx");
    await expect(screen.page.locator("#items")).toBeHidden();
    await expect(screen.page.locator(".foot")).toBeHidden();
    await expect(heading(phone.page)).toHaveText("Approved for Demo Room");
    expect(await launches()).toEqual({ opened: 0, left: [] });
    await expectNoAxeViolations(screen.page);

    // Download mints its own link on the first click, so it never meets the 2 minute life of the one the screen fetched.
    const saved = screen.page.waitForEvent("download");
    await screen.page.getByRole("button", { name: "Download" }).click();
    expect((await saved).suggestedFilename()).toBe("sample-deck.pptx");

    await phone.page.getByRole("button", { name: "Revoke" }).click();
    await expect(heading(screen.page)).toHaveText("Session Ended");
    await screen.context.close();
    await phone.context.close();
  });

  test("Cancel while the file is chosen returns the screen to its code", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await phone.page.getByRole("button", { name: "Add a File" }).click();
    await phone.page.getByRole("button", { name: "Cancel" }).click();
    await expect(heading(phone.page)).toHaveText("Approval Canceled");
    await expect(heading(screen.page)).toHaveText("Demo Room");
    await screen.context.close();
    await phone.context.close();
  });
});

test.describe("open path", () => {
  test("RES-01 storage: launch, the Download fallback after 5 s, the PDF view, and End leaving no sid", async ({
    browser,
  }) => {
    const screen = await liveScreen(browser);
    const { phone } = await scan(browser, screen.page, LIVE);
    // A live screen shows one file: the phone selects one, from files only.
    await expect(phone.page.locator("#file-list input[type=radio]").first()).toBeVisible();
    await expect(phone.page.locator("#file-list input[type=checkbox]")).toHaveCount(0);
    await expect(phone.page.locator("#file-list input:checked")).toHaveCount(1);
    await expect(phone.page.locator("#file-list").getByText("Vevox")).toHaveCount(0);
    await phone.page.getByRole("button", { name: "Approve" }).click();

    // PowerPoint is not installed here: no fetch arrives, so after the launch timeout Download appears.
    await expect(heading(screen.page)).toHaveText("Opening in PowerPoint");
    await expect(screen.page.locator("#line")).toContainText("Sample deck.pptx");
    await expect(screen.page.getByRole("button", { name: "End", exact: true })).toBeVisible();
    await expect(phone.page.getByRole("button", { name: "Revoke" })).toBeVisible();
    const download = screen.page.getByRole("button", { name: "Download It Instead" });
    await expect(download).toBeHidden();
    await expect(download).toBeVisible({ timeout: 10_000 });
    await expectNoAxeViolations(screen.page);

    // The download is the first fetch of /f/: the session opens, as the fallback.
    const saved = screen.page.waitForEvent("download");
    await download.click();
    expect((await saved).suggestedFilename()).toBe("Sample-deck.pptx");
    await expect(heading(screen.page)).toHaveText("PowerPoint Didn't Open");
    await expect(screen.page.getByText("The copy stays in this PC's Downloads.")).toBeVisible();
    await expect(screen.page.getByRole("button", { name: "Show as PDF Instead" })).toBeVisible();
    await expect(heading(phone.page)).toHaveText("PowerPoint Didn't Open");
    await expectNoAxeViolations(screen.page);

    // The labeled PDF view opens in a second window under the PDF route's own CSP.
    // Asserted on the request, not the popup's URL: headless Chromium has no PDF viewer, so the popup
    // downloads the file and never commits a navigation that would give it that URL.
    const pdf = screen.context.waitForEvent("request", (r) => r.url().includes("/f/"));
    await screen.page.getByRole("button", { name: "Show as PDF Instead" }).click();
    expect((await pdf).url()).toMatch(/\/f\/[A-Za-z0-9_-]{54}\/Sample-deck\.pdf$/);
    await expect(heading(screen.page)).toHaveText("Showing as a PDF");

    // End: the screen forgets its credential, and every link is dead.
    await screen.page.getByRole("button", { name: "End", exact: true }).click();
    await expect(heading(screen.page)).toHaveText("Session Ended");
    // What this PC may still hold: the PowerPoint it launched and the download it started, by its name in Downloads.
    await expect(screen.page.locator("#line")).toHaveText(
      "Close PowerPoint to take your slides off this PC. Delete Sample-deck.pptx from Downloads before you leave.",
    );
    expect(await screen.page.evaluate(() => sessionStorage.getItem("bloop.sid"))).toBeNull();
    await expect(heading(phone.page)).toHaveText("Session Ended");
    await screen.context.close();
    await phone.context.close();
  });
});

test.describe("demo viewer", () => {
  test("DEMO-01 flow: the sidebar holds 4 items, and each shows on the stage; nothing launches; a reload still shows it", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    const launches = await watchLaunches(screen.page);
    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expectViewer(screen.page);
    // The page's own fetch of the launched link (the photo's view) stands in for PowerPoint's, so the session opens.
    await expect(heading(phone.page)).toHaveText("Approved for Demo Room");
    await expect(phone.page.locator("#file-list .row")).toHaveCount(CATALOG.length);
    expect(await launches()).toEqual({ opened: 0, left: [] });
    await expectNoAxeViolations(screen.page);

    // The deck: next and prev on the stage, then the arrow keys.
    await sidebarItem(screen.page, "Sample deck.pptx").click();
    await expect(heading(screen.page)).toHaveText("Sample deck.pptx");
    await expect(sidebarItem(screen.page, "Sample deck.pptx")).toHaveAttribute("aria-current", "true");
    await expect(screen.page.getByRole("img", { name: "Slide 1 of 2" })).toBeVisible();
    await expect(screen.page.getByRole("button", { name: "Previous Slide" })).toBeHidden();
    await expect(screen.page.locator("#dots")).toHaveText("1 / 2");
    await screen.page.getByRole("button", { name: "Next Slide" }).click();
    await expect(screen.page.getByRole("img", { name: "Slide 2 of 2" })).toBeVisible();
    await expect(screen.page.locator("#dots")).toHaveText("2 / 2");
    await expect(screen.page.getByRole("button", { name: "Next Slide" })).toBeHidden();
    await screen.page.getByRole("button", { name: "Previous Slide" }).click();
    await expect(screen.page.getByRole("img", { name: "Slide 1 of 2" })).toBeVisible();
    await screen.page.keyboard.press("ArrowRight");
    await expect(screen.page.getByRole("img", { name: "Slide 2 of 2" })).toBeVisible();
    await expect(screen.page.getByRole("button", { name: "Present" })).toBeVisible();

    // The PDF: the same pages, named as pages.
    await sidebarItem(screen.page, "Sample deck.pdf").click();
    await expect(heading(screen.page)).toHaveText("Sample deck.pdf");
    await expect(screen.page.getByRole("img", { name: "Page 1 of 2" })).toBeVisible();

    // Download of the PDF mints that item's link.
    const saved = screen.page.waitForEvent("download");
    await screen.page.getByRole("button", { name: "Download" }).click();
    expect((await saved).suggestedFilename()).toMatch(/\.pdf$/);

    // The image, contained on the stage.
    await sidebarItem(screen.page, "Dog.jpg").click();
    await expect(screen.page.getByRole("img", { name: "Dog.jpg" })).toBeVisible();

    // The link: a card with the host and Open, a new tab with no opener, never a frame.
    await sidebarItem(screen.page, "Vevox").click();
    await expect(heading(screen.page)).toHaveText("Vevox");
    const openLink = screen.page.getByRole("link", { name: "Open vevox.com" });
    await expect(openLink).toHaveAttribute("href", "https://www.vevox.com/");
    await expect(openLink).toHaveAttribute("target", "_blank");
    await expect(openLink).toHaveAttribute("rel", "noopener noreferrer");
    await expect(screen.page.locator("iframe")).toHaveCount(0);
    await expect(screen.page.getByRole("button", { name: "Download" })).toBeHidden();
    await expectNoAxeViolations(screen.page);

    await screen.page.reload();
    await expectViewer(screen.page);

    await screen.page.getByRole("button", { name: "End", exact: true }).click();
    await expect(heading(screen.page)).toHaveText("Session Ended");
    await expect(heading(phone.page)).toHaveText("Session Ended");
    expect([...screen.csp, ...phone.csp]).toEqual([]);
    await screen.context.close();
    await phone.context.close();
  });

  test("a failed Download parks the viewer under the error: End stays, Back stays hidden, a key cannot bring it back", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expectViewer(screen.page);
    await sidebarItem(screen.page, "Sample deck.pdf").click();
    await expect(screen.page.getByRole("img", { name: "Page 1 of 2" })).toBeVisible();
    await screen.page.route("**/api/screen/link", (route) => route.fulfill({ status: 500, body: "" }));
    await screen.page.getByRole("button", { name: "Download" }).click();
    await expect(heading(screen.page)).toHaveText("Unable to Open Your File");
    await expect(screen.page.locator("#view")).toBeHidden();
    await expect(screen.page.locator("#items")).toBeHidden();
    await screen.page.keyboard.press("PageDown");
    await expect(screen.page.locator("#view")).toBeHidden();
    await expect(screen.page.getByRole("button", { name: "End", exact: true })).toBeVisible();
    await expect(screen.page.getByRole("link", { name: "Back", exact: true })).toBeHidden();
    await screen.page.unroute("**/api/screen/link");
    // The error clears by itself, and the viewer comes back where it was: the key moved nothing.
    await expect(heading(screen.page)).toHaveText("Sample deck.pdf", { timeout: 15_000 });
    await expect(screen.page.getByRole("img", { name: "Page 1 of 2" })).toBeVisible();
    await screen.context.close();
    await phone.context.close();
  });

  test("DEMO-01 links only: the session holds one link, shown as a lone centered card", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    for (const name of CATALOG.slice(0, 3)) {
      await phone.page.getByRole("checkbox", { name: startsWith(name) }).uncheck();
    }
    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expect(heading(phone.page)).toHaveText("Approved for Demo Room");
    await expect(heading(screen.page)).toHaveText("Vevox");
    await expect(screen.page.getByRole("link", { name: "Open vevox.com" })).toBeVisible();
    await expect(screen.page.locator("#items")).toBeHidden();
    await screen.context.close();
    await phone.context.close();
  });

  test("the bloop mark in the viewer asks in the page first, then ends the session and goes home", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expectViewer(screen.page);
    const question = screen.page.getByRole("dialog", { name: "End and Go Home?" });
    await screen.page.getByRole("button", { name: /^bloop/ }).click();
    await expect(question).toBeVisible();
    await expectNoAxeViolations(screen.page);
    await question.getByRole("button", { name: "Cancel" }).click();
    await expect(question).toBeHidden();
    await expectViewer(screen.page);
    await screen.page.getByRole("button", { name: /^bloop/ }).click();
    const sid = () => screen.page.evaluate(() => sessionStorage.getItem("bloop.sid"));
    const before = await sid();
    expect(before).not.toBeNull();
    await question.getByRole("button", { name: "End and Go Home" }).click();
    await expect(screen.page).toHaveURL("/");
    await expect(heading(phone.page)).toHaveText("Session Ended");
    // The page forgot the screen: the browser's Back opens a fresh one, never the ended session.
    await screen.page.goBack();
    await expect(heading(screen.page)).toHaveText("Demo Room");
    await typedCodeOf(screen.page);
    const after = await sid();
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    await screen.context.close();
    await phone.context.close();
  });

  test("DEMO-01 round trip: one phone-width tab approves on itself and comes back to the viewer", async ({
    browser,
  }) => {
    const phone = await open(browser, "phone", "/s?mode=demo");
    await expect(heading(phone.page)).toHaveText("Demo Room");
    await expect(phone.page.locator("#qr")).toBeHidden();
    await expectNoAxeViolations(phone.page);

    // Under 600 the phone is the approver: the code card and its hint step aside.
    await expect(phone.page.locator("#b-copy")).toBeHidden();
    await phone.page.getByRole("link", { name: "Approve on This Phone" }).click();
    await expect(phone.page).toHaveURL(/\/a$/);
    await expect(heading(phone.page)).toHaveText(DEMO.title);
    // One device has nothing to compare: the button is plain Approve. Approving sends the tab back to its screen.
    await expect(phone.page.getByRole("button", { name: "Approve" })).toHaveText("Approve");
    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expect(phone.page).toHaveURL(/\/s\?mode=demo$/);
    // Under 760 the sidebar is a bottom sheet behind a handle.
    await expect(heading(phone.page)).toHaveText("Dog.jpg");
    await expect(phone.page.locator("#items")).toBeHidden();
    await phone.page.locator("#handle").click();
    await sidebarItem(phone.page, "Vevox").click();
    await expect(heading(phone.page)).toHaveText("Vevox");
    await expect(phone.page.locator("#items")).toBeHidden();
    await expectNoAxeViolations(phone.page);

    await phone.page.getByRole("button", { name: "End", exact: true }).click();
    await expect(heading(phone.page)).toHaveText("Session Ended");
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

test.describe("stage 4 layout", () => {
  for (const viewport of [
    { width: 834, height: 1000 },
    { width: 1440, height: 900 },
  ]) {
    test(`the viewer's pill sits 16 under the item at ${viewport.width} x ${viewport.height}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      await page.goto("/s?mode=demo");
      const code = await typedCodeOf(page);
      const phone = await open(browser, "phone", `/a?c=${code}`);
      await phone.page.getByRole("button", { name: "Approve" }).click();
      for (const name of ["Sample deck.pptx", "Dog.jpg"]) {
        await sidebarItem(page, name).click();
        const item = page.locator("#frame img").first();
        await expect(item).toBeVisible();
        await expect(async () => {
          const box = await item.boundingBox();
          const pill = await page.locator("#controls").boundingBox();
          expect(Math.round((pill?.y ?? 0) - ((box?.y ?? 0) + (box?.height ?? 0)))).toBe(16);
        }).toPass();
      }
      await context.close();
      await phone.context.close();
    });
  }

  test("a reload into a claim keeps the card at its waiting size; the page's own actions are 52", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    await typedCodeOf(screen.page);
    const waiting = await screen.page.locator("#qr-panel").boundingBox();
    const { phone } = await scan(browser, screen.page);
    await screen.page.reload();
    await expect(screen.page.locator("#compare")).toHaveText(/^Your phone shows \d{2}\.$/);
    await expect(screen.page.locator("#awaiting")).toHaveText("Waiting for Approve.");
    expect(await screen.page.locator("#qr-panel").boundingBox()).toEqual(waiting);
    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expectViewer(screen.page);
    await screen.page.getByRole("button", { name: "End", exact: true }).click();
    await expect(screen.page.getByRole("link", { name: "Join the Waitlist" })).toHaveCSS("min-height", "52px");
    await screen.context.close();
    await phone.context.close();
  });

  test("the demo never shows the live footer or a Back before its first paint", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 834, height: 1000 } });
    const page = await context.newPage();
    await page.route("**/api/screens", async (route) => {
      await new Promise((done) => setTimeout(done, 1500));
      await route.continue();
    });
    await page.goto("/s?mode=demo");
    await expect(page.locator(".foot")).toBeHidden();
    await expect(page.locator("#b-back")).toHaveCSS("visibility", "hidden");
    await context.close();
  });

  test("a dead code centers title, line and Enter the Code as one group", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 834, height: 1112 } });
    const page = await context.newPage();
    await page.goto("/a?c=222222");
    await expect(heading(page)).toHaveText("This Code Has Expired");
    const title = await heading(page).boundingBox();
    const go = await page.getByRole("link", { name: "Enter the Code" }).boundingBox();
    const center = ((title?.y ?? 0) + (go?.y ?? 0) + (go?.height ?? 0)) / 2;
    expect(Math.abs(center - 1112 / 2)).toBeLessThan(24);
    await context.close();
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
    await expect(page.getByText("Use the Room's Screen")).toBeVisible();
    await expect(page.getByRole("link", { name: "Enter the Code" })).toHaveAttribute("href", "/code");
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
    await expect(heading(page)).toHaveText("Too Many Demos Right Now");
    await expect(page.locator("#line")).toHaveText("Trying again by itself.");
    await page.unroute("**/api/screens");
    // The first retry waits 5 s.
    await expect(heading(page)).toHaveText("Demo Room", { timeout: 10_000 });
    await context.close();
  });

  test("the wide waiting screen has the QR on the left of the room title, and the QR is one path in a 41 module square with the required label", async ({
    browser,
  }) => {
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
    const card = await screen.page.locator("#qr-panel").boundingBox();
    const title = await heading(screen.page).boundingBox();
    expect(title?.x ?? 0).toBeGreaterThan((card?.x ?? 0) + (card?.width ?? 0));
    // The card's padding is the QR's own quiet zone: the card is the QR.
    expect(Math.round(card?.width ?? 0)).toBe(Math.round(box?.width ?? 0));
    await screen.context.close();
  });

  test("New Code ends the waiting screen and shows a fresh code; Copy puts the code on the clipboard", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    await screen.context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const before = await typedCodeOf(screen.page);
    // The square's glyph is centered: the house frame's start inset is for a frame with a label.
    const square = await screen.page.getByRole("button", { name: "New Code" }).boundingBox();
    const glyph = await screen.page.locator("#b-new .icon").boundingBox();
    if (!square || !glyph) throw new Error("New Code is not on the page");
    expect(Math.abs(glyph.x + glyph.width / 2 - (square.x + square.width / 2))).toBeLessThan(1);
    expect(Math.abs(glyph.y + glyph.height / 2 - (square.y + square.height / 2))).toBeLessThan(1);
    await screen.page.getByRole("button", { name: "New Code" }).click();
    await expect.poll(() => typedCodeOf(screen.page)).not.toBe(before);
    await expect(screen.page.getByRole("button", { name: "New Code" })).toBeEnabled();
    // The old code is dead: its screen is gone.
    const stale = await open(browser, "phone", `/a?c=${before}`);
    await expect(heading(stale.page)).toHaveText("This Code Has Expired");

    const code = await screen.page.locator("#typed-code").textContent();
    await screen.page.getByRole("button", { name: /^Copy / }).click();
    expect(await screen.page.evaluate("navigator.clipboard.readText()")).toBe(code);
    await expect(screen.page.locator("#polite")).toHaveText("Copied");
    await screen.context.close();
    await stale.context.close();
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

test.describe("phone pages on a laptop and the way home", () => {
  test("/a on a laptop is two columns: the room and its buttons on the left, the list on the right", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const code = await typedCodeOf(screen.page);
    const laptop = await screen.context.browser()?.newContext({ viewport: SCREEN });
    const page = await laptop?.newPage();
    if (!page || !laptop) throw new Error("no laptop context");
    await page.goto(`/a?c=${code}`);
    await expect(heading(page)).toHaveText("Demo Room");
    const title = await heading(page).boundingBox();
    const list = await page.locator("#file-list").boundingBox();
    const approve = await page.getByRole("button", { name: /^Approve/ }).boundingBox();
    const cancel = await page.getByRole("button", { name: "Cancel" }).boundingBox();
    expect(list?.x ?? 0).toBeGreaterThan((title?.x ?? 0) + (title?.width ?? 0));
    // Side by side, Cancel then Approve.
    expect(approve?.y).toBe(cancel?.y);
    expect(approve?.x ?? 0).toBeGreaterThan(cancel?.x ?? 0);
    await expectNoAxeViolations(page);
    await laptop.close();
    await screen.context.close();
  });

  for (const path of ["/code", "/a"]) {
    test(`Back on ${path} goes home`, async ({ page }) => {
      await page.goto(path);
      await page.getByRole("link", { name: "Back", exact: true }).click();
      await expect(page).toHaveURL("/");
    });
  }

  for (const path of ["/privacy", "/security"]) {
    test(`the logo on ${path} goes home`, async ({ page }) => {
      await page.goto(path);
      await page.getByRole("link", { name: "bloop", exact: true }).first().click();
      await expect(page).toHaveURL("/");
    });
  }
});
