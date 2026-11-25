// The pairing flow in two browser contexts: the room screen at 1440 and a phone at 390. Runs in CI only
// (headless Chrome cannot start in the local sandbox). The demo mode needs no account, so the whole
// flow is drivable; `npm run dev` runs with TEST_TIMING=1 here (playwright.config.ts), which skips the
// platform rate limits that ten fresh screens a minute would trip. Selectors are roles and names first, ids where
// the page names a slot (docs/design.md section 7).

import { crc32, deflateSync } from "node:zlib";
import AxeBuilder from "@axe-core/playwright";
import { type Browser, type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";

/** The item on the stage: a page's picture, or the photo's canvas (never the loader's thumbnail). */
const STAGED = "#frame :is(picture img, canvas)";

/** A black PNG of the given size: the photo's stand-in for a test (the viewer decodes raster bytes, not SVG). */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8; // bit depth; color type 0 (gray) and the rest stay 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(Buffer.alloc((width + 1) * height))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** An MP4 as an Android phone writes one: ftyp, a moov whose udta holds the `©xyz` location, then mdat. */
function androidMp4(location: string): Buffer {
  const box = (type: string, ...body: Buffer[]) => {
    const inner = Buffer.concat(body);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(8 + inner.length);
    return Buffer.concat([size, Buffer.from(type, "latin1"), inner]);
  };
  const xyz = box("\u00a9xyz", Buffer.from([0, location.length, 0x15, 0xc7]), Buffer.from(location, "latin1"));
  return Buffer.concat([
    box("ftyp", Buffer.from("isom"), Buffer.alloc(4), Buffer.from("isom")),
    box("moov", box("mvhd", Buffer.alloc(20, 5)), box("udta", xyz)),
    box("mdat", Buffer.alloc(64, 7)),
  ]);
}

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
  // A new code replaces the old one 150 ms into its swap: until then the card still reads the old, spent code.
  await expect(page.locator("#qr-panel")).not.toHaveClass(/\bis-swapping\b/);
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
/** A file row is a button; a link row is a link that opens a new tab and leaves the stage as it is. */
const sidebarItem = (page: Page, name: string) =>
  page.locator("#items").getByRole("button", { name: startsWith(name) });
const sidebarLink = (page: Page, name: string) => page.locator("#items").getByRole("link", { name: startsWith(name) });

/** The demo viewer from approval: the sidebar with the whole catalog, and the first item (the photo) on the stage. */
async function expectViewer(page: Page) {
  await expect(page.locator("#items > li .item")).toHaveCount(CATALOG.length);
  await expect(sidebarLink(page, "Vevox")).toBeVisible();
  for (const name of CATALOG.slice(0, 3)) await expect(sidebarItem(page, name)).toBeVisible();
  await expect(heading(page)).toHaveText("Dog.jpg");
  await expect(page.getByRole("img", { name: "Dog.jpg" })).toBeVisible();
  await expect(page.getByRole("button", { name: "End", exact: true })).toBeVisible();
}

/** The page's one inset (10 under 640, 12 from it): the edge distance and the gap between floating parts. */
const insetOf = async (page: Page) =>
  (await page.evaluate("parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--inset'))")) as number;

/** The viewer's pill rides one inset under the item on the stage. */
async function expectPillUnder(page: Page, item: Locator) {
  await expect(item).toBeVisible();
  const inset = await insetOf(page);
  await expect(async () => {
    const box = await item.boundingBox();
    const pill = await page.locator("#controls").boundingBox();
    expect(Math.abs((pill?.y ?? 0) - ((box?.y ?? 0) + (box?.height ?? 0)) - inset)).toBeLessThanOrEqual(1);
  }).toPass();
}

/** The pill is as wide as its contents: "1 / 2" stays one line and the pill keeps its 60. */
async function expectOneLinePill(page: Page) {
  await expect(page.locator("#dots")).toHaveText("1 / 2");
  const dots = await page.locator("#dots").boundingBox();
  const pill = await page.locator("#controls").boundingBox();
  expect(dots?.height ?? 99).toBeLessThanOrEqual(24);
  // Boxes are sub-pixel (59.99997 on CI runners): compare to the nearest pixel, never exactly.
  expect(Math.round(pill?.height ?? 0)).toBe(60);
  expect(
    (dots?.y ?? 0) >= (pill?.y ?? 0) - 0.5 && (dots?.y ?? 0) + (dots?.height ?? 0) <= (pill?.y ?? 0) + 60 + 0.5,
  ).toBe(true);
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

test.describe("pairing flow", () => {
  test("pair by QR link, match, approve", async ({ browser }) => {
    const screen = await demoScreen(browser);
    await expect(screen.page.locator("#qr-path")).toHaveAttribute("d", /^M/);
    // The hint's two lines carry no periods.
    await expect(screen.page.locator("#hint p")).toHaveText([
      "Scan with your phone",
      /^Or enter the code at \S+\/code$/,
    ]);
    await expect(screen.page.locator("#qr")).toHaveAttribute(
      "aria-label",
      /^QR code, scan with your phone, or enter the code \w \w \w, \w \w \w at \S+ slash code$/,
    );
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
    // The claim changes the state in place: the QR card stays where it was, blank of its QR.
    await expect(screen.page.locator("#match")).toBeVisible();
    await expect(screen.page.locator("#qr-panel")).toHaveCSS("visibility", "visible");
    // The status is the screen reader's alone: the title and the number stand by themselves.
    await expect(screen.page.locator("#line")).toHaveText(`Waiting for Approval. Your phone shows ${match}.`);
    await expect(screen.page.locator("#line")).toHaveCSS("clip-path", "inset(50%)");
    await expect(screen.page.locator("#awaiting")).toBeHidden();
    await expect(screen.page.locator("#hint")).toHaveCSS("visibility", "hidden");
    // The digits sit in the card, in monospace; the card does not move; the title moves to the card's middle.
    await expect(screen.page.locator("#match")).toHaveText(match);
    await expect(screen.page.locator("#match")).toHaveCSS("font-family", /monospace/);
    expect(await screen.page.locator("#qr-panel").boundingBox()).toEqual(cardBefore);
    await expect(async () => {
      const title = await heading(screen.page).boundingBox();
      const card = cardBefore ?? { x: 0, y: 0, width: 0, height: 0 };
      expect(Math.round(title?.x ?? 0)).toBe(Math.round(titleBefore?.x ?? -1));
      expect(Math.abs((title?.y ?? 0) + (title?.height ?? 0) / 2 - (card.y + card.height / 2))).toBeLessThanOrEqual(1);
    }).toPass();
    await expect(screen.page.getByRole("button", { name: "Back", exact: true })).toBeVisible();
    await expectNoAxeViolations(screen.page);

    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expect(heading(phone.page)).toHaveText("Approved for Demo Room");
    await expect(phone.page.locator("#ends")).toHaveText(/^Ends in \d+:\d{2}$/);
    // The approved items are a record, not controls: no ticks.
    await expect(phone.page.locator("#file-list .row")).toHaveCount(4);
    await expect(phone.page.locator("#file-list .tick")).toHaveCount(0);
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
    await expect(screen.page.locator("#line")).toHaveText(/^Waiting for Approval\. Your phone shows \d{2}\.$/);
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
    await expect(phone.page.locator("#code-error")).toContainText("Check the code on the screen.");
    // One line at 390: the refusal does not move Continue either.
    expect(await phone.page.getByRole("button", { name: "Continue" }).boundingBox()).toEqual(before);
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
    await expect(screen.page.locator("#line")).toHaveText(/^Waiting for Approval\. Your phone shows \d{2}\.$/);
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
    // Session Ended stands alone: no reason line.
    await expect(screen.page.locator("#line")).toBeEmpty();
    await expect(screen.page.locator("#items")).toBeHidden();
    await expect(screen.page.getByRole("button", { name: "End", exact: true })).toBeHidden();
    // The demo's one way on: the waitlist.
    await expect(screen.page.getByRole("link", { name: "Join the Waitlist" })).toBeVisible();
    // Session Ended, its line and the waitlist link sit at the true center of the viewport, as one group.
    // The group settles with the stage's fade, so it is polled.
    await expect(async () => {
      const box = await heading(screen.page).boundingBox();
      const last = await screen.page.getByRole("link", { name: "Join the Waitlist" }).boundingBox();
      const view = screen.page.viewportSize();
      expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) / 2 - (view?.width ?? 0) / 2)).toBeLessThan(2);
      expect(
        Math.abs(((box?.y ?? 0) + (last?.y ?? 0) + (last?.height ?? 0)) / 2 - (view?.height ?? 0) / 2),
      ).toBeLessThan(4);
    }).toPass();
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

  test("a tap anywhere on Session Ended, or Enter, brings a fresh code at the server's floor; Join the Waitlist still leaves", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const page = screen.page;
    /** Ends a fresh session from the screen's End and returns when Session Ended shows. */
    const endOne = async () => {
      const { phone } = await scan(browser, page);
      await phone.page.getByRole("button", { name: "Approve" }).click();
      await expectViewer(page);
      await page.getByRole("button", { name: "End", exact: true }).click();
      await expect(heading(page)).toHaveText("Session Ended");
      return phone;
    };
    // The demo holds Session Ended 10 s on its own; a tap cuts it to the 3 s the server keeps it at least.
    let phone = await endOne();
    let since = Date.now();
    await page.evaluate(
      `window.__asks = 0; const send = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { if (String(d).includes('"code.next"')) window.__asks++; return send.call(this, d); }`,
    );
    // Past the floor, a burst of taps (and the repaints between them) asks for one code, not one each.
    await page.waitForTimeout(3300);
    for (let i = 0; i < 3; i++) {
      await page.mouse.click(SCREEN.width / 2, 80);
      await page.waitForTimeout(100);
    }
    await expect(heading(page)).toHaveText(DEMO.room, { timeout: 6000 });
    expect(Date.now() - since).toBeLessThan(6000);
    expect(await page.evaluate("window.__asks")).toBe(1);
    await typedCodeOf(page);
    await phone.context.close();

    phone = await endOne();
    // Inside the grace a press is the tail of the one that ended the session: the 10 s hold stands past the floor.
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3500);
    await expect(heading(page)).toHaveText("Session Ended");
    since = Date.now();
    await page.keyboard.press("Enter");
    await expect(heading(page)).toHaveText(DEMO.room, { timeout: 6000 });
    expect(Date.now() - since).toBeLessThan(6000);
    await phone.context.close();

    phone = await endOne();
    await page.route("https://tally.so/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<title>Waitlist</title>" }),
    );
    await page.getByRole("link", { name: "Join the Waitlist" }).click();
    await expect(page).toHaveURL(/^https:\/\/tally\.so\//);
    await phone.context.close();
    await screen.context.close();
  });

  test("PAIR-12 a Revoke that fails offline keeps Revoke alone and the pid, and shows no Back that would strand the session", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expectViewer(screen.page);
    await phone.page.route("**/api/end", (route) => route.abort());
    await phone.page.getByRole("button", { name: "Revoke" }).click();
    await expect(heading(phone.page)).toHaveText("You're Offline");
    await expect(phone.page.getByRole("button", { name: "Revoke" })).toBeVisible();
    // Revoke alone retries its own failure.
    await expect(phone.page.getByRole("button", { name: "Try Again" })).toHaveCount(0);
    await expect(phone.page.getByRole("link", { name: "Back", exact: true })).toBeHidden();
    expect(await phone.page.evaluate(() => localStorage.getItem("bloop.pid"))).not.toBeNull();
    await phone.page.unroute("**/api/end");
    await phone.page.getByRole("button", { name: "Revoke" }).click();
    await expect(heading(screen.page)).toHaveText("Session Ended");
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
    await expect(screen.page.locator("#line")).toHaveText(/^Waiting for Approval\. Your phone shows \d{2}\.$/);
    await phone.page.reload();
    await expect(heading(phone.page)).toHaveText(DEMO.title);
    await screen.context.close();
    await phone.context.close();
  });
});

test.describe("guest drop", () => {
  const DECK = "test/fixtures/decks/sample-deck.pptx";

  /** Taps Add a File, which opens the native picker at once, and answers the browser's file chooser. */
  async function addFile(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add a File" }).click();
    await (await chooser).setFiles(file);
  }
  const EXE = { name: "notes.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") };

  test("DEMO-01 flow: a guest adds a file, the screen offers it, and the Open click shows its card, with Download on click", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await expectNoAxeViolations(phone.page);

    // a wrong type is refused on the phone before a byte leaves it, as a toast over the same page
    await addFile(phone.page, EXE);
    await expect(phone.page.getByRole("alert")).toContainText("This File Type Isn't Supported");
    await expect(heading(phone.page)).toHaveText("Demo Room");
    await expectNoAxeViolations(phone.page);
    // over this server's demo cap (10 MB here), which the toast reads from the claim
    await addFile(phone.page, { name: "big.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(11 * 1024 * 1024) });
    await expect(phone.page.getByRole("alert")).toContainText("The demo takes files up to 10 MB.");
    await expect(heading(phone.page)).toHaveText("Demo Room");
    // a video over the cap is told as recording time (about 1 MB a second), with the cap itself
    await addFile(phone.page, { name: "clip.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(11 * 1024 * 1024) });
    await expect(phone.page.getByRole("alert")).toContainText("Video Too Long");
    await expect(phone.page.getByRole("alert")).toContainText(
      "The demo takes videos up to about 10\u00a0seconds (10 MB).",
    );
    // a HEIC this browser cannot decode is never sent: its offer goes, and the toast asks for a JPEG
    await addFile(phone.page, { name: "IMG_1.HEIC", mimeType: "image/heic", buffer: Buffer.from("x") });
    await expect(heading(phone.page)).toHaveText("Send IMG_1.HEIC to Demo Room?");
    await phone.page.getByRole("button", { name: "Send" }).click();
    await expect(phone.page.getByRole("alert")).toContainText("This HEIC Photo Can't Be Converted");
    await expect(heading(phone.page)).toHaveText("Demo Room");

    await addFile(phone.page, DECK);
    await expect(heading(phone.page)).toHaveText("Send sample-deck.pptx to Demo Room?");
    await expect(phone.page.locator("#body")).toHaveText("bloop deletes its copy when this ends.");
    await phone.page.getByRole("button", { name: "Send" }).click();

    await expect(heading(phone.page)).toHaveText("Sent to Demo Room");
    await expect(heading(screen.page)).toHaveText("Sent by a Guest");
    await expect(screen.page.locator("#line")).toHaveText("sample-deck.pptx. Open it here when you're ready.");
    // An offer keeps its line, visible and inside the window; only a claim's status moves to the hint's place.
    await expect(screen.page.locator("#line")).toBeVisible();
    await expect(screen.page.locator("#line")).toHaveCSS("clip-path", "none");
    await expect(screen.page.locator("#awaiting")).toBeHidden();
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
    await expectPillUnder(screen.page, screen.page.locator(".item-card"));
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

  test("Done on a refused upload lets go of the claim, so the screen shows its code again at once", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await phone.page.route("**/api/drop", (route) =>
      route.fulfill({
        status: 507,
        contentType: "application/problem+json",
        body: JSON.stringify({ type: "about:blank", status: 507, code: "storage_full" }),
      }),
    );
    await addFile(phone.page, DECK);
    await phone.page.getByRole("button", { name: "Send" }).click();
    await expect(heading(phone.page)).toHaveText("bloop Can't Take Files Now");
    await expect(screen.page.locator("#match")).toBeVisible();
    const cancel = phone.page.waitForRequest((r) => r.url().endsWith("/api/cancel"));
    await phone.page.getByRole("button", { name: "Done" }).click();
    await cancel;
    await expect(phone.page).toHaveURL("/");
    // Well inside the claim's own timeout, which would otherwise hold the screen.
    await expect(screen.page.locator("#match")).toBeHidden({ timeout: 5000 });
    await typedCodeOf(screen.page);
    expect(await phone.page.evaluate(() => localStorage.getItem("bloop.pid"))).toBeNull();
    await screen.context.close();
    await phone.context.close();
  });

  test("Cancel on the offer reached from the list goes back to the list; the column is centered at 834", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const code = await typedCodeOf(screen.page);
    const context = await browser.newContext({ viewport: { width: 834, height: 828 } });
    const page = await context.newPage();
    await page.goto(`/a?c=${code}`);
    await expect(page.locator("#file-list")).toBeVisible();
    /** The column's visible block, centered in the viewport from 640. */
    const center = async () => {
      const title = await heading(page).boundingBox();
      const last = await page.locator(".actions").boundingBox();
      return ((title?.y ?? 0) + (last?.y ?? 0) + (last?.height ?? 0)) / 2;
    };
    await addFile(page, DECK);
    await expect(heading(page)).toHaveText("Send sample-deck.pptx to Demo Room?");
    expect(Math.abs((await center()) - 828 / 2)).toBeLessThan(24);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(heading(page)).toHaveText("Demo Room");
    await expect(page.locator("#file-list")).toBeVisible();
    // The browser's Back and the corner Back do what Cancel does.
    await addFile(page, DECK);
    await page.goBack();
    await expect(heading(page)).toHaveText("Demo Room");
    await addFile(page, DECK);
    await page.getByRole("link", { name: "Back" }).click();
    await expect(heading(page)).toHaveText("Demo Room");
    // A file refused on the phone is a toast; the list stays.
    await addFile(page, EXE);
    await expect(page.getByRole("alert")).toContainText("This File Type Isn't Supported");
    await expect(heading(page)).toHaveText("Demo Room");
    await expect(screen.page.locator("#line")).toHaveText(/^Waiting for Approval\. Your phone shows \d{2}\.$/);
    await context.close();
    await screen.context.close();
  });

  test("Cancel on the offer goes back to the list; the list's Cancel then returns the screen to its code", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await addFile(phone.page, DECK);
    await phone.page.getByRole("button", { name: "Cancel" }).click();
    await expect(heading(phone.page)).toHaveText("Demo Room");
    await expect(screen.page.locator("#line")).toHaveText(/^Waiting for Approval\. Your phone shows \d{2}\.$/);
    await phone.page.getByRole("button", { name: "Cancel" }).click();
    await expect(heading(phone.page)).toHaveText("Approval Canceled");
    await expect(heading(screen.page)).toHaveText("Demo Room");
    await screen.context.close();
    await phone.context.close();
  });

  /** The script modules this page has fetched so far, by path. */
  const modules = (page: Page) =>
    page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((e) => new URL(e.name).pathname)
        .filter((path) => path.startsWith("/js/core/")),
    );
  /** Keeps the body XMLHttpRequest sends, so a test reads the bytes that left the phone. */
  type Sending = { sent: File; XMLHttpRequest: { prototype: { send: (this: unknown, body: unknown) => void } } };
  const keepSent = (page: Page) =>
    page.evaluate(() => {
      const w = globalThis as unknown as Sending;
      const send = w.XMLHttpRequest.prototype.send;
      w.XMLHttpRequest.prototype.send = function (body) {
        w.sent = body as File;
        send.call(this, body);
      };
    });
  const sent = (page: Page) =>
    page.evaluate(async () => {
      const body = (globalThis as unknown as Sending).sent;
      return { name: body.name, bytes: [...new Uint8Array(await body.arrayBuffer())] };
    });

  test("a photo loads photo.js only when it is sent, shows its row on the loader, and leaves as a JPEG", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    expect(await modules(phone.page)).not.toContain("/js/core/photo.js");
    await keepSent(phone.page);
    // Held until the row is read, so the in-between state is on the page.
    let release = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    await phone.page.route("**/api/drop", async (route) => {
      await held;
      await route.continue();
    });

    await addFile(phone.page, { name: "shot.png", mimeType: "image/png", buffer: png(3000, 2000) });
    await expect(heading(phone.page)).toHaveText("Send shot.png to Demo Room?");
    expect(await modules(phone.page)).not.toContain("/js/core/photo.js");
    await phone.page.getByRole("button", { name: "Send" }).click();
    await expect(heading(phone.page)).toHaveText("Sending shot.png");
    const row = phone.page.locator("#file-list .row.upload");
    await expect(row.getByRole("progressbar", { name: "Sending shot.png" })).toBeVisible();
    await expect(row.locator(".small")).toHaveText(/^(Compressing|\d+% sent|Finishing)$/);
    await expect(phone.page.locator("progress")).toHaveCount(0);
    release();

    await expect(heading(phone.page)).toHaveText("Sent to Demo Room");
    const modulesNow = await modules(phone.page);
    expect(modulesNow).toContain("/js/core/photo.js");
    expect(modulesNow).not.toContain("/js/core/video.js");
    // Re-encoded on the phone: a JPEG (SOI, then a JFIF APP0 from the canvas), named .jpg, its long side at 2560.
    const out = await sent(phone.page);
    expect(out.name).toBe("shot.jpg");
    expect(out.bytes.slice(0, 3)).toEqual([0xff, 0xd8, 0xff]);
    await expect(heading(screen.page)).toHaveText("Sent by a Guest");
    await screen.context.close();
    await phone.context.close();
  });

  test("VID-04 a video loads video.js only when it is sent and leaves with its location blanked in place", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await keepSent(phone.page);
    const where = "+37.3861-122.0839/";
    const clip = androidMp4(where);

    await addFile(phone.page, { name: "clip.mp4", mimeType: "video/mp4", buffer: clip });
    expect(await modules(phone.page)).not.toContain("/js/core/video.js");
    await phone.page.getByRole("button", { name: "Send" }).click();
    await expect(heading(phone.page)).toHaveText("Sent to Demo Room");
    const modulesNow = await modules(phone.page);
    expect(modulesNow).toContain("/js/core/video.js");
    expect(modulesNow).not.toContain("/js/core/photo.js");
    const out = await sent(phone.page);
    expect(out.name).toBe("clip.mp4");
    expect(out.bytes.length).toBe(clip.length);
    expect(Buffer.from(out.bytes).includes(Buffer.from(where, "latin1"))).toBe(false);
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

    // The link row: a new tab with no opener or referrer, never a frame; the stage keeps the photo.
    const vevox = sidebarLink(screen.page, "Vevox");
    await expect(vevox).toHaveAttribute("href", "https://www.vevox.com/");
    await expect(vevox).toHaveAttribute("target", "_blank");
    await expect(vevox).toHaveAttribute("rel", "noopener noreferrer");
    await expect(screen.page.locator("iframe")).toHaveCount(0);
    await expect(heading(screen.page)).toHaveText("Dog.jpg");
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
    const question = screen.page.getByRole("dialog", { name: "End This Session?" });
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
    await question.getByRole("button", { name: "End Session" }).click();
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
    // A phone can be the share screen: the QR stays, whole inside the window, and nothing scrolls.
    await expect(phone.page.locator("#qr")).toBeVisible();
    const qr = await phone.page.locator("#qr").boundingBox();
    expect((qr?.x ?? -1) >= 0 && (qr?.y ?? -1) >= 0 && (qr?.x ?? 0) + (qr?.width ?? 0) <= PHONE.width).toBe(true);
    expect((qr?.y ?? 0) + (qr?.height ?? 0) <= PHONE.height).toBe(true);
    expect(await phone.page.evaluate("document.scrollingElement.scrollHeight <= innerHeight")).toBe(true);
    await expectNoAxeViolations(phone.page);

    // Under 600 the code row stays under the QR; Approve on This Phone sits under it.
    await expect(phone.page.locator("#b-copy")).toBeVisible();
    await phone.page.getByRole("link", { name: "Approve on This Phone" }).click();
    await expect(phone.page).toHaveURL(/\/a$/);
    await expect(heading(phone.page)).toHaveText(DEMO.title);
    // One device has nothing to compare: the button is plain Approve. Approving sends the tab back to its screen.
    await expect(phone.page.getByRole("button", { name: "Approve" })).toHaveText("Approve");
    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expect(phone.page).toHaveURL(/\/s\?mode=demo$/);
    // Under 760 the sidebar is a bottom sheet behind a handle.
    await expect(heading(phone.page)).toHaveText("Dog.jpg");
    await expectPillUnder(phone.page, phone.page.locator(STAGED).first());
    await expect(phone.page.locator("#items")).toBeHidden();
    await phone.page.locator("#handle").click();
    await sidebarItem(phone.page, "Sample deck.pptx").click();
    await expect(heading(phone.page)).toHaveText("Sample deck.pptx");
    await expect(phone.page.locator("#items")).toBeHidden();
    await expectOneLinePill(phone.page);
    await expectNoAxeViolations(phone.page);

    await phone.page.getByRole("button", { name: "End", exact: true }).click();
    await expect(heading(phone.page)).toHaveText("Session Ended");
    expect(phone.csp).toEqual([]);
    await phone.context.close();
  });

  test("at 360 the logo's question stacks its buttons, the rose on top, each label inside its own padding", async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 360, height: 780 } });
    const page = await context.newPage();
    await page.goto("/s?mode=demo");
    await page.getByRole("link", { name: "Approve on This Phone" }).click();
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(heading(page)).toHaveText("Dog.jpg");
    await page.getByRole("button", { name: /^bloop/ }).click();
    const question = page.getByRole("dialog", { name: "End This Session?" });
    await expect(question).toBeVisible();
    const fit = await page.evaluate(`(() => {
      const end = document.getElementById("b-leave");
      const cancel = end.parentElement.querySelector("[popovertarget]");
      const range = document.createRange();
      range.selectNodeContents(end);
      const text = range.getBoundingClientRect();
      const box = end.getBoundingClientRect();
      const pad = parseFloat(getComputedStyle(end).paddingLeft);
      return {
        inside: text.left >= box.left + pad - 0.5 && text.right <= box.right - pad + 0.5,
        roseOnTop: box.bottom <= cancel.getBoundingClientRect().top,
        fullWidth: Math.round(box.width) === Math.round(cancel.getBoundingClientRect().width),
      };
    })()`);
    expect(fit).toEqual({ inside: true, roseOnTop: true, fullWidth: true });
    await context.close();
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

test.describe("screen and phone layout", () => {
  for (const viewport of [
    { width: 834, height: 1000 },
    { width: 1440, height: 900 },
  ]) {
    test(`the viewer's pill sits 16 under each page and the photo, its count on one line, at ${viewport.width} x ${viewport.height}`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      await page.goto("/s?mode=demo");
      const code = await typedCodeOf(page);
      const phone = await open(browser, "phone", `/a?c=${code}`);
      await phone.page.getByRole("button", { name: "Approve" }).click();
      for (const name of ["Sample deck.pptx", "Sample deck.pdf", "Dog.jpg"]) {
        await sidebarItem(page, name).click();
        await expectPillUnder(page, page.locator(STAGED).first());
      }
      await sidebarItem(page, "Sample deck.pptx").click();
      await expectOneLinePill(page);
      await context.close();
      await phone.context.close();
    });
  }

  test("New Code keeps one x at 1440 whatever the code's width", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const xs = new Set<number>();
    let code = await typedCodeOf(screen.page);
    for (let i = 0; i < 4; i++) {
      xs.add(Math.round((await screen.page.locator("#b-new").boundingBox())?.x ?? -1));
      await screen.page.locator("#b-new").click();
      await expect.poll(() => typedCodeOf(screen.page)).not.toBe(code);
      code = await typedCodeOf(screen.page);
    }
    expect(xs.size).toBe(1);
    // New Code comes first, then the code card.
    const order = await screen.page.locator(".code-row > *").evaluateAll((els) => els.map((e) => e.id));
    expect(order).toEqual(["b-new", "b-copy"]);
    await screen.context.close();
  });

  for (const viewport of [PHONE, { width: 1280, height: 720 }]) {
    test(`/s never scrolls the page, at ${viewport.width} x ${viewport.height}: waiting, claimed, viewer, presenting, ended`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const still = async () => {
        await page.mouse.move(viewport.width / 2, viewport.height / 2);
        await page.mouse.wheel(0, 600);
        expect(await page.evaluate("document.scrollingElement.scrollHeight <= innerHeight")).toBe(true);
        expect(await page.evaluate("scrollY")).toBe(0);
      };
      await page.goto("/s?mode=demo");
      const code = await typedCodeOf(page);
      await still();
      const phone = await open(browser, "phone", `/a?c=${code}`);
      await expect(page.locator("#match")).toBeVisible();
      await still();
      await phone.page.getByRole("button", { name: "Approve" }).click();
      await expect(heading(page)).toHaveText("Dog.jpg");
      await still();
      await page.getByRole("button", { name: "Present", exact: true }).click();
      await expect(page.locator("body")).toHaveClass(/is-presenting/);
      await still();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "End", exact: true }).click();
      await expect(heading(page)).toHaveText("Session Ended");
      await still();
      await context.close();
      await phone.context.close();
    });
  }

  test("a live screen under 600 keeps the room's-screen card and does not scroll", async ({ browser }) => {
    const context = await browser.newContext({ viewport: PHONE });
    const page = await context.newPage();
    await page.goto("/s");
    await expect(page.locator(".narrow-title")).toBeVisible();
    expect(await page.evaluate("document.scrollingElement.scrollHeight <= innerHeight")).toBe(true);
    await context.close();
  });

  /** The demo photo's answer, swapped for a portrait picture before the viewer asks for it. */
  const PORTRAIT = png(600, 900);

  /** A demo screen with its viewer open on the 4-item list, the photo swapped for `body` when given. */
  async function viewerWith(browser: Browser, body?: Buffer) {
    const screen = await demoScreen(browser);
    if (body) await screen.page.route("**/f/**", (route) => route.fulfill({ contentType: "image/png", body }));
    const code = await typedCodeOf(screen.page);
    const phone = await open(browser, "phone", `/a?c=${code}`);
    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expect(heading(screen.page)).toHaveText("Dog.jpg");
    await expect(screen.page.locator(STAGED)).toBeVisible();
    return { screen, phone, pane: screen.page.locator("#pane") };
  }
  const box = async (page: Page, sel: string) => {
    const b = await page.locator(sel).boundingBox();
    if (!b) throw new Error(`${sel} has no box`);
    return b;
  };

  /** Square and portrait pictures standing in for the photo. */
  const SQUARE = png(900, 900);
  const WIDE = png(1500, 1000);

  /** Where the controls went, and the boxes that say so. */
  async function slotOf(page: Page) {
    const [pill, img, view, side] = await Promise.all([
      box(page, "#controls"),
      box(page, STAGED),
      box(page, "#view"),
      box(page, "#side"),
    ]);
    const inset = await insetOf(page);
    return { pill, img, view, side, inset };
  }

  test("slot 1: a wide image on a tall stage keeps the pill under it, the two centered as one block", async ({
    browser,
  }) => {
    const { screen, phone, pane } = await viewerWith(browser);
    await expect(pane).toHaveClass(/is-under/);
    await expect(async () => {
      const { pill, img, view, inset } = await slotOf(screen.page);
      // The item fills the stage's width: the controls never shrink it.
      expect(Math.round(img.width)).toBeGreaterThanOrEqual(Math.round(view.width) - 1);
      expect(Math.abs(pill.y - (img.y + img.height) - inset)).toBeLessThanOrEqual(1);
      // Item and pill are centered together between the stage's top and bottom.
      const above = img.y - view.y;
      const below = view.y + view.height - (pill.y + pill.height);
      expect(Math.abs(above - below)).toBeLessThanOrEqual(2);
      expect(Math.abs(pill.x + pill.width / 2 - (view.x + view.width / 2))).toBeLessThanOrEqual(1);
    }).toPass();
    await screen.context.close();
    await phone.context.close();
  });

  test("slot 2: a portrait image takes the column at the stage's bottom right, beside it", async ({ browser }) => {
    const { screen, phone, pane } = await viewerWith(browser, PORTRAIT);
    await expect(pane).toHaveClass(/is-stacked/);
    await expect(async () => {
      const { pill, img, view, side } = await slotOf(screen.page);
      expect(Math.abs(pill.x + pill.width - (view.x + view.width))).toBeLessThanOrEqual(1);
      expect(Math.abs(pill.y + pill.height - (view.y + view.height))).toBeLessThanOrEqual(1);
      expect(pill.x).toBeGreaterThanOrEqual(img.x + img.width);
      // The item still fills the stage's height, centered; the column sits right of the list's column.
      expect(Math.round(img.height)).toBeGreaterThanOrEqual(Math.round(view.height) - 1);
      expect(pill.x).toBeGreaterThan(side.x + side.width);
    }).toPass();
    await screen.context.close();
    await phone.context.close();
  });

  test("slot 3: with no room beside or under the item, the column goes under the list, right-aligned to it", async ({
    browser,
  }) => {
    const { screen, phone, pane } = await viewerWith(browser, SQUARE);
    await expect(pane).toHaveClass(/is-stacked/);
    await expect(async () => {
      const { pill, img, view, side, inset } = await slotOf(screen.page);
      expect(Math.abs(pill.x + pill.width - (side.x + side.width))).toBeLessThanOrEqual(1);
      // Anchored to the rail's foot: its bottom edge on End's, clear of the list above.
      const endBox = await box(screen.page, "#b-end");
      expect(Math.abs(pill.y + pill.height - (endBox.y + endBox.height))).toBeLessThanOrEqual(1);
      expect(pill.y).toBeGreaterThanOrEqual(side.y + side.height + inset - 1);
      // The list's cap reserves the stack, so a list that grows scrolls above it and never runs under it.
      const cap = Number.parseFloat(
        await screen.page.evaluate("getComputedStyle(document.getElementById('side')).maxHeight"),
      );
      expect(side.y + cap + inset).toBeLessThanOrEqual(pill.y + 1);
      expect(pill.x + pill.width).toBeLessThanOrEqual(img.x);
      expect(Math.round(img.height)).toBeGreaterThanOrEqual(Math.round(view.height) - 1);
    }).toPass();
    await screen.context.close();
    await phone.context.close();
  });

  test("slot 4: with the list too full for it, the pill floats over the item at bottom center", async ({ browser }) => {
    // Short enough that the demo list scrolls; a 3 : 2 item leaves no room beside it.
    const context = await browser.newContext({ viewport: { width: 1000, height: 360 } });
    const page = await context.newPage();
    await page.route("**/f/**", (route) => route.fulfill({ contentType: "image/png", body: WIDE }));
    await page.goto("/s?mode=demo");
    const code = await typedCodeOf(page);
    const phone = await open(browser, "phone", `/a?c=${code}`);
    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expect(heading(page)).toHaveText("Dog.jpg");
    await expect(page.locator(STAGED)).toBeVisible();
    await expect(page.locator("#pane")).not.toHaveClass(/is-stacked|is-under/);
    expect(await page.locator("#side").evaluate((n) => n.scrollHeight > n.clientHeight)).toBe(true);
    await expect(async () => {
      const { pill, img, view, inset } = await slotOf(page);
      expect(Math.abs(pill.x + pill.width / 2 - (view.x + view.width / 2))).toBeLessThanOrEqual(1);
      expect(Math.abs(view.y + view.height - inset - (pill.y + pill.height))).toBeLessThanOrEqual(1);
      expect(pill.y).toBeLessThan(img.y + img.height);
    }).toPass();
    await context.close();
    await phone.context.close();
  });

  test("the rail: the logo at the top left, the list under it, End alone at the bottom left; the stage is full height", async ({
    browser,
  }) => {
    const { screen, phone } = await viewerWith(browser);
    const page = screen.page;
    await expect(async () => {
      const [side, end, home, view] = await Promise.all([
        box(page, "#side"),
        box(page, "#b-end"),
        box(page, "#b-home"),
        box(page, "#view"),
      ]);
      const inset = await insetOf(page);
      const height = page.viewportSize()?.height ?? 0;
      // The logo where it is on every screen, the list one inset under it, both left-justified.
      expect(Math.abs(home.x - inset)).toBeLessThanOrEqual(1);
      expect(Math.abs(home.y - inset)).toBeLessThanOrEqual(1);
      expect(Math.abs(side.x - inset)).toBeLessThanOrEqual(1);
      expect(Math.abs(side.y - (home.y + home.height + inset))).toBeLessThanOrEqual(1);
      // End alone at the foot, at its normal size.
      expect(Math.abs(end.x - inset)).toBeLessThanOrEqual(1);
      expect(Math.abs(end.y + end.height + inset - height)).toBeLessThanOrEqual(1);
      expect(end.y).toBeGreaterThan(side.y + side.height);
      expect(end.height).toBeGreaterThanOrEqual(home.height - 1);
      // The stage runs the full height between the insets, whatever the logo holds.
      expect(Math.abs(view.y - inset)).toBeLessThanOrEqual(1);
      expect(Math.abs(view.y + view.height + inset - height)).toBeLessThanOrEqual(1);
    }).toPass();
    await screen.context.close();
    await phone.context.close();
  });

  test("switching between two items with one placement keeps the controls' node and animates nothing", async ({
    browser,
  }) => {
    const { screen, phone } = await viewerWith(browser);
    const page = screen.page;
    // A part's running animations, ended or canceled (a canceled one's `finished` rejects).
    const settle = (id: string) =>
      page.evaluate(
        `Promise.all(document.getElementById('${id}').getAnimations().map((a) => a.finished.catch(() => {})))`,
      );
    // The viewer's own entry (scanned to viewer) can still be running: let it end, then count any that start.
    await settle("pane");
    // Each item's image arrives after its click and reshapes the frame (a legitimate glide): load both first,
    // so the measured switch is between two ready items.
    const loaded = page.locator("#frame .loader");
    await sidebarItem(page, "Sample deck.pdf").click();
    await expect(page.locator(STAGED)).toBeVisible();
    await expect(loaded).toHaveCount(0);
    await settle("pane");
    await page.evaluate(
      "window.__paneStarts = 0; document.getElementById('pane').addEventListener('animationstart', () => window.__paneStarts++)",
    );
    await sidebarItem(page, "Sample deck.pptx").click();
    await expect(heading(page)).toHaveText("Sample deck.pptx");
    await expect(page.locator("#dots")).toBeVisible();
    await expect(page.locator(STAGED)).toBeVisible();
    await expect(loaded).toHaveCount(0);
    const dots = async () => page.locator("#dots").textContent();
    const was = await dots();
    // The page count appearing is a shape change: that glide may still run when the next switch comes.
    await settle("controls");
    await page.evaluate("window.__controls = document.getElementById('controls')");
    await sidebarItem(page, "Sample deck.pdf").click();
    await expect(heading(page)).toHaveText("Sample deck.pdf");
    await expect(page.locator(STAGED)).toBeVisible();
    // Nothing starts later either: poll over the swap's settle, then read once more.
    for (let i = 0; i < 5; i++) {
      expect(await page.evaluate("window.__controls === document.getElementById('controls')")).toBe(true);
      expect(
        await page.evaluate("document.getAnimations().filter((a) => a.effect?.target?.id === 'pane').length"),
      ).toBe(0);
      // The pill is the same size, so nothing moves it: a different page count is a shape change, which may glide.
      if ((await dots()) === was)
        expect(
          await page.evaluate("document.getAnimations().filter((a) => a.effect?.target?.id === 'controls').length"),
        ).toBe(0);
      await page.waitForTimeout(100);
    }
    // A replay as short as a frame is missed by polling; the event is not.
    expect(await page.evaluate("window.__paneStarts")).toBe(0);
    await screen.context.close();
    await phone.context.close();
  });

  test("the hairline above the links has the same gap to the row above and the row below, to 1 px", async ({
    browser,
  }) => {
    const { screen, phone } = await viewerWith(browser);
    const gaps = await screen.page.evaluate(`(() => {
      const split = document.querySelector("#items .split");
      const above = split.previousElementSibling.firstElementChild.getBoundingClientRect();
      const below = split.firstElementChild.getBoundingClientRect();
      const line = split.getBoundingClientRect().top;
      return [line - above.bottom, below.top - (line + 1)];
    })()`);
    const [above = 0, below = 99] = gaps as number[];
    expect(Math.abs(above - below)).toBeLessThanOrEqual(1);
    await screen.context.close();
    await phone.context.close();
  });

  test("presenting fills the window edge to edge on black, the stop pill centered on it", async ({ browser }) => {
    const { screen, phone } = await viewerWith(browser);
    await screen.page.getByRole("button", { name: "Present", exact: true }).click();
    await expect(screen.page.locator("body")).toHaveClass(/is-presenting/);
    await expect(async () => {
      const view = await box(screen.page, "#view");
      expect([Math.round(view.x), Math.round(view.y), Math.round(view.width), Math.round(view.height)]).toEqual([
        0,
        0,
        SCREEN.width,
        SCREEN.height,
      ]);
    }).toPass();
    const stop = await box(screen.page, "#b-stop");
    expect(Math.abs(stop.x + stop.width / 2 - SCREEN.width / 2)).toBeLessThanOrEqual(1);
    await screen.context.close();
    await phone.context.close();
  });

  test("a slow photo holds its loader, unblurred, its progress rising with the bytes, then fades in over it", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const page = screen.page;
    const code = await typedCodeOf(page);
    // About 4 s for the demo photo's 232 KB, so the in-between states can be read.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 40,
      downloadThroughput: 60 * 1024,
      uploadThroughput: -1,
    });
    const phone = await open(browser, "phone", `/a?c=${code}`);
    await phone.page.getByRole("button", { name: "Approve" }).click();
    const loader = page.locator("#frame .loader.stand-in");
    await expect(loader).toBeVisible();
    await expect(loader).toHaveAttribute("role", "progressbar");
    await expect(loader).toHaveAttribute("aria-label", "Loading Dog.jpg");
    await expect(loader).toHaveCSS("filter", "none");
    const values: number[] = [];
    await expect
      .poll(async () => {
        const v = Number((await loader.getAttribute("aria-valuenow").catch(() => null)) ?? -1);
        if (v >= 0) values.push(v);
        return v > 0 && v < 100;
      })
      .toBe(true);
    await expect(page.locator(STAGED)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("img", { name: "Dog.jpg" })).toBeVisible();
    // It rose, never fell, and the loader left once the photo had faded in.
    expect(values.some((v) => v > 0 && v < 100)).toBe(true);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    await expect(page.locator("#frame .loader")).toHaveCount(0);
    await screen.context.close();
    await phone.context.close();
  });

  test("presenting draws on pure black, and the photo grows until it meets two opposite window edges", async ({
    browser,
  }) => {
    // The demo photo (1280 x 853) is smaller than the window: contained, it still meets the top and bottom at 1440 x 900.
    const { screen, phone } = await viewerWith(browser);
    const page = screen.page;
    await page.getByRole("button", { name: "Present", exact: true }).click();
    await expect(page.locator("body")).toHaveClass(/is-presenting/);
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(0, 0, 0)");
    await expect(page.locator("#view")).toHaveCSS("background-color", "rgb(0, 0, 0)");
    await expect(page.locator(STAGED)).toHaveCSS("border-radius", "0px");
    await expect(async () => {
      // The drawn picture inside the contained box: its own ratio, centered.
      const drawn = await page.locator(STAGED).evaluate((el) => {
        // The node tsconfig has no DOM lib: the canvas's own size, typed by hand.
        const c = el as unknown as {
          width: number;
          height: number;
          getBoundingClientRect(): { left: number; top: number; width: number; height: number };
        };
        const r = c.getBoundingClientRect();
        const k = Math.min(r.width / c.width, r.height / c.height);
        const w = c.width * k;
        const h = c.height * k;
        return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, w, h };
      });
      const meets = (a: number, b: number) => Math.round(a) === Math.round(b);
      const tall = meets(drawn.top, 0) && meets(drawn.top + drawn.h, SCREEN.height);
      const wide = meets(drawn.left, 0) && meets(drawn.left + drawn.w, SCREEN.width);
      expect(tall || wide).toBe(true);
    }).toPass();
    await screen.context.close();
    await phone.context.close();
  });

  test("the stop pill is hidden when presenting starts and follows the pointer to the top; Tab shows it, Escape exits", async ({
    browser,
  }) => {
    const { screen, phone } = await viewerWith(browser);
    const page = screen.page;
    const opacity = async () =>
      Number(await page.evaluate("getComputedStyle(document.getElementById('b-stop')).opacity"));
    await page.getByRole("button", { name: "Present", exact: true }).click();
    await expect(page.locator("body")).toHaveClass(/is-presenting/);
    await page.mouse.move(SCREEN.width / 2, 600);
    await expect.poll(opacity).toBe(0);
    await page.mouse.move(SCREEN.width / 2, 120, { steps: 4 });
    await expect.poll(opacity).toBeGreaterThan(0);
    expect(await opacity()).toBeLessThan(1);
    await page.mouse.move(SCREEN.width / 2, 20, { steps: 4 });
    await expect.poll(opacity).toBe(1);
    await page.mouse.move(SCREEN.width / 2, 600, { steps: 4 });
    await expect.poll(opacity).toBe(0);
    // A keyboard reaches the pill by Tab and it stays shown while focused.
    await page.keyboard.press("Tab");
    for (let i = 0; i < 6 && !(await page.evaluate(`document.activeElement?.id === "b-stop"`)); i++)
      await page.keyboard.press("Tab");
    expect(await page.evaluate(`document.activeElement?.id`)).toBe("b-stop");
    await expect.poll(opacity).toBe(1);
    await page.keyboard.press("Escape");
    await expect(page.locator("body")).not.toHaveClass(/is-presenting/);
    await page.context().close();
    await phone.context.close();
  });

  test("at 390 Present shows for the photo; presenting hides the chrome and Stop Presenting restores it", async ({
    browser,
  }) => {
    const phone = await open(browser, "phone", "/s?mode=demo");
    await phone.page.getByRole("link", { name: "Approve on This Phone" }).click();
    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expect(heading(phone.page)).toHaveText("Dog.jpg");
    await expect(phone.page.getByRole("button", { name: "Present", exact: true })).toBeVisible();
    await phone.page.getByRole("button", { name: "Present", exact: true }).click();
    const chrome = ["#controls", "#handle", ".bar"].map((sel) => phone.page.locator(sel));
    for (const part of chrome) await expect(part).toBeHidden();
    await expect(phone.page.locator(STAGED)).toBeVisible();
    // The stop pill answers only near the window's top: move there first, then press.
    await phone.page.mouse.move(PHONE.width / 2, 10);
    await phone.page.getByRole("button", { name: "Stop Presenting" }).click();
    for (const part of chrome) await expect(part).toBeVisible();
    await expect(phone.page.getByRole("button", { name: "Stop Presenting" })).toBeHidden();
    await phone.context.close();
  });

  test("a reload into a claim keeps the card at its waiting size; the page's own actions are 52", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    await typedCodeOf(screen.page);
    const waiting = await screen.page.locator("#qr-panel").boundingBox();
    const { phone } = await scan(browser, screen.page);
    // A reloaded claim cannot draw its code, so a live one shows the same blank card with the phone glyph.
    await expect(screen.page.locator("#qr")).toBeHidden();
    await expect(screen.page.locator("#match")).toBeVisible();
    await screen.page.reload();
    await expect(screen.page.locator("#qr")).toBeHidden();
    await expect(screen.page.locator("#match")).toBeVisible();
    await expect(screen.page.locator("#line")).toHaveText(/^Waiting for Approval\. Your phone shows \d{2}\.$/);
    await expect(screen.page.locator("#awaiting")).toBeHidden();
    expect(await screen.page.locator("#qr-panel").boundingBox()).toEqual(waiting);
    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expectViewer(screen.page);
    await screen.page.getByRole("button", { name: "End", exact: true }).click();
    await expect(screen.page.getByRole("link", { name: "Join the Waitlist" })).toHaveCSS("min-height", "52px");
    await screen.context.close();
    await phone.context.close();
  });

  test("at 390 a claim leaves the QR card where it was, its status for screen readers only", async ({ browser }) => {
    const screen = await open(browser, "phone", "/s?mode=demo");
    await typedCodeOf(screen.page);
    // A claim replays no entry; any transition still running ends before the read, and boxes compare in whole pixels.
    const settled = async (selector: string) => {
      await screen.page.evaluate(
        "Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity).map((a) => a.finished.catch(() => {})))",
      );
      const box = await screen.page.locator(selector).boundingBox();
      return (
        box && {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height),
        }
      );
    };
    // A web font arriving late reflows the hint, so wait for it before taking the card's place.
    await screen.page.evaluate("document.fonts.ready.then(() => true)");
    const card = await settled("#qr-panel");
    const title = await settled("#heading");
    const { phone } = await scan(browser, screen.page);
    await expect(screen.page.locator("#match")).toBeVisible();
    await expect(screen.page.locator("#awaiting")).toBeHidden();
    await expect(screen.page.locator("#line")).toHaveText(/^Waiting for Approval\. Your phone shows \d{2}\.$/);
    // One column: the title stays above the card, and the hidden hint keeps its height, so nothing moves.
    // No entry replays on a claim: the card never left its place, even for a frame.
    expect(await screen.page.evaluate("document.getElementById('pane').getAnimations().length")).toBe(0);
    expect(await settled("#qr-panel")).toEqual(card);
    expect(await settled("#heading")).toEqual(title);
    expect(await screen.page.evaluate("document.scrollingElement.scrollHeight <= innerHeight")).toBe(true);
    await screen.context.close();
    await phone.context.close();
  });

  test("a screen shows no footer or Back before its first paint, then both", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 834, height: 1000 } });
    const page = await context.newPage();
    let release = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    await page.route("**/api/screens", async (route) => {
      await held;
      await route.continue();
    });
    await page.goto("/s");
    await expect(page.locator("body")).toHaveClass(/is-booting/);
    await expect(page.locator(".foot")).toHaveCSS("visibility", "hidden");
    await expect(page.locator("#b-back")).toHaveCSS("visibility", "hidden");
    release();
    await typedCodeOf(page);
    await expect(page.locator(".foot")).toBeVisible();
    await expect(page.locator("#b-back")).toBeVisible();
    await context.close();
  });

  test("with no script the screen keeps its static Back and footer", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 834, height: 1000 }, javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto("/s");
    await expect(page.locator("#b-back")).toBeVisible();
    await expect(page.locator(".foot")).toBeVisible();
    await context.close();
  });

  test("a phone held landscape keeps Approve (NN) in view, and a short approved record keeps Revoke in view", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const code = await typedCodeOf(screen.page);
    const context = await browser.newContext({ viewport: { width: 844, height: 390 } });
    const page = await context.newPage();
    await page.goto(`/a?c=${code}`);
    const approve = page.getByRole("button", { name: /^Approve/ });
    await expect(approve).toBeInViewport({ ratio: 1 });
    await approve.click();
    await expect(heading(page)).toHaveText("Approved for Demo Room");
    await page.setViewportSize({ width: 834, height: 560 });
    await expect(page.getByRole("button", { name: "Revoke" })).toBeInViewport({ ratio: 1 });
    await context.close();
    await screen.context.close();
  });

  for (const viewport of [
    { width: 932, height: 430 },
    { width: 1280, height: 560 },
  ]) {
    test(`a short window from 900 keeps the two-column approver at ${viewport.width} x ${viewport.height}: its buttons sit on the page, in view, never in the band`, async ({
      browser,
    }) => {
      const screen = await demoScreen(browser);
      const code = await typedCodeOf(screen.page);
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      await page.goto(`/a?c=${code}`);
      await expect(page.locator("#file-list")).toBeVisible();
      const actions = page.locator(".column > .actions");
      await expect(actions).toHaveCSS("position", "static");
      await expect(actions).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      const approve = page.getByRole("button", { name: /^Approve/ });
      await expect(approve).toBeInViewport({ ratio: 1 });
      // In the title's column, 24 under the flow (the demo has no scope line between them).
      const title = await heading(page).boundingBox();
      const flow = await page.locator(".column > .flow").boundingBox();
      const box = await actions.boundingBox();
      expect(Math.round(box?.x ?? 0)).toBe(Math.round(title?.x ?? -1));
      expect(Math.round((box?.y ?? 0) - ((flow?.y ?? 0) + (flow?.height ?? 0)))).toBe(24);
      await context.close();
      await screen.context.close();
    });
  }

  test("a result held landscape is centered as under 640, with Done kept in the band", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const code = await typedCodeOf(screen.page);
    const context = await browser.newContext({ viewport: { width: 834, height: 560 } });
    const page = await context.newPage();
    await page.goto(`/a?c=${code}`);
    await page.getByRole("button", { name: /^Approve/ }).click();
    await page.getByRole("button", { name: "Revoke" }).click();
    await expect(heading(page)).toHaveText("Session Ended");
    const title = await heading(page).boundingBox();
    const body = await page.locator("#body").boundingBox();
    // The group ends at the line, or at the title when the ended view has none.
    const end = body && body.height > 0 ? body.y + body.height : (title?.y ?? 0) + (title?.height ?? 0);
    const center = ((title?.y ?? 0) + end) / 2;
    expect(Math.abs(center - 560 / 2)).toBeLessThan(24);
    await expect(page.getByRole("button", { name: "Done" })).toBeInViewport({ ratio: 1 });
    await context.close();
    await screen.context.close();
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
    // Centered as one group, like every dead end.
    await expect(page.locator(".narrow")).toHaveCSS("text-align", "center");
    const group = await page.locator(".narrow").boundingBox();
    expect(Math.abs((group?.y ?? 0) + (group?.height ?? 0) / 2 - PHONE.height / 2)).toBeLessThan(24);
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
    expect(label).toContain("QR code, scan with your phone, or enter the code");
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
