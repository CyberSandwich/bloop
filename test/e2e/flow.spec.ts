// The pairing flow in two browser contexts: the room screen at 1440 and a phone at 390. Runs in CI only
// (headless Chrome cannot start in the local sandbox). The demo mode needs no account, so the whole
// flow is drivable; `npm run dev` runs with TEST_TIMING=1 here (playwright.config.ts), which skips the
// platform rate limits that ten fresh screens a minute would trip. Selectors are roles and names first, ids where
// the page names a slot (docs/design.md section 7).

import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { type Browser, type BrowserContext, expect, type Locator, type Page, type Route, test } from "@playwright/test";
import { expectNoAxeViolations, heading, type Opened, open, PHONE, pickMatch, SCREEN, typedCodeOf } from "./pairing.ts";

/** The item on the stage: a page's picture, the photo's canvas or a video (never the loader's thumbnail). */
const STAGED = "#frame :is(picture img, canvas, video)";

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

/** No toast now, read once: a retrying toHaveCount(0) passes once a toast leaves by itself (5 s). */
const expectNoToast = async (page: Page) =>
  expect(await page.locator(".toast:not(.out)").count(), "a toast is up").toBe(0);
type Prep = Parameters<typeof open>[3];
const demoScreen = (browser: Browser, prep?: Prep) => open(browser, "screen", "/s?mode=demo", prep);
/** A live screen on the mock source: the lectern path, which launches PowerPoint (ADR 0003). */
const liveScreen = (browser: Browser, prep?: Prep) => open(browser, "screen", "/s", prep);
const DEMO: { room: string; title: string | RegExp } = { room: "Demo Room", title: "Demo Room" };
/** An unregistered room has no name: no heading on the screen, "This Screen" as the phone's title. */
const LIVE = { room: "", title: "This Screen" };

/** Taps Add a File, which opens the native picker at once, and answers the browser's file chooser. */
async function addFile(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add a File" }).click();
  await (await chooser).setFiles(file);
}
/** The demo catalog as the viewer orders it: files by name, then links by title. */
const CATALOG = ["Dog.jpg", "Sample deck.pdf", "Sample deck.pptx", "Vevox"];

async function scan(
  browser: Browser,
  screen: Page,
  expected = DEMO,
): Promise<{ phone: Opened; code: string; match: string }> {
  // An unregistered room's screen has no heading at all, never an empty one.
  if (expected.room) await expect(heading(screen)).toHaveText(expected.room);
  else {
    await expect(screen.locator("#qr")).toBeVisible();
    await expect(screen.locator("h1:not([hidden])")).toHaveCount(0);
  }
  const code = await typedCodeOf(screen);
  const phone = await open(browser, "phone", `/a?c=${code}`);
  await expect(heading(phone.page)).toHaveText(expected.title);
  // A live claim picks the screen's number first (PAIR-14); the chooser's Approve then carries no digits.
  if (expected === LIVE) {
    const match = await pickMatch(phone.page, screen);
    await expect(phone.page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
    return { phone, code, match };
  }
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

/** Revoke, then End Session in the question it asks first. */
async function revoke(page: Page) {
  await page.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("dialog", { name: "End This Session?" }).getByRole("button", { name: "End Session" }).click();
}

/** The page's one inset (10 under 640, 12 from it): the edge distance and the gap between floating parts. */
const insetOf = async (page: Page) =>
  (await page.evaluate("parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--inset'))")) as number;

type Box = { x: number; y: number; width: number; height: number };

/**
 * The pill and its count, read in one frame once nothing finite animates in the pill. A change of place glides it
 * (viewer.js fit: translate plus scale, 300 ms) and the count grows in, so a box read mid-flight is scaled or
 * moving; two separate boundingBox calls can also straddle a frame. Every pill box read goes through here
 * (e2e-rules.test.ts).
 */
async function settledPill(page: Page): Promise<{ pill: Box; dots: Box }> {
  const read = `(() => {
    const pill = document.getElementById("controls");
    const dots = document.getElementById("dots");
    if (!pill || !dots) return null;
    const moving = pill.getAnimations({ subtree: true }).some((a) => a.effect?.getComputedTiming().endTime !== Infinity);
    if (moving) return null;
    const box = (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    return { pill: box(pill), dots: box(dots) };
  })()`;
  const held: { boxes: { pill: Box; dots: Box } | null } = { boxes: null };
  await expect(async () => {
    held.boxes = (await page.evaluate(read)) as { pill: Box; dots: Box } | null;
    expect(held.boxes, "the pill is still gliding").not.toBeNull();
  }).toPass();
  if (!held.boxes) throw new Error("the pill never settled");
  return held.boxes;
}

/** The viewer's pill rides one inset under the item on the stage. */
async function expectPillUnder(page: Page, item: Locator) {
  await expect(item).toBeVisible();
  const inset = await insetOf(page);
  await expect(async () => {
    const box = await item.boundingBox();
    const { pill } = await settledPill(page);
    expect(Math.abs(pill.y - ((box?.y ?? 0) + (box?.height ?? 0)) - inset)).toBeLessThanOrEqual(1);
  }).toPass();
}

/** The pill is as wide as its contents: "1 / 2" stays one line and the pill keeps its 60. */
async function expectOneLinePill(page: Page) {
  await expect(page.locator("#dots")).toHaveText("1 / 2");
  const { dots, pill } = await settledPill(page);
  expect(dots.height).toBeLessThanOrEqual(24);
  // Boxes are sub-pixel (59.99997 on CI runners): compare to the nearest pixel, never exactly.
  expect(Math.round(pill.height)).toBe(60);
  expect(dots.y >= pill.y - 0.5 && dots.y + dots.height <= pill.y + 60 + 0.5).toBe(true);
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

type Moving = { getAnimations(o: { subtree: boolean }): { pause(): void; finish(): void; currentTime: number }[] };

/**
 * Ends every animation under `locator`, so a box read next is where it comes to rest: an entry animation moves boxes
 * until it ends, and a box read mid-flight puts a click computed from it somewhere else (test/unit/e2e-motion-rules).
 */
async function atRest(locator: Locator) {
  await locator.evaluate((el) => {
    for (const a of (el as unknown as Moving).getAnimations({ subtree: true })) a.finish();
  });
}

/** Holds every animation under `locator` at its first frame: the worst case a slow runner can measure in. */
async function atStart(locator: Locator) {
  await locator.evaluate((el) => {
    for (const a of (el as unknown as Moving).getAnimations({ subtree: true })) {
      a.pause();
      a.currentTime = 0;
    }
  });
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
    await expect(phone.page.locator("#ends-text")).toHaveText(/^Ends in \d+:\d{2}$/);
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

  test("a long file name on the phone list takes two lines and stays inside the row at 320 and 390", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    const name = phone.page.locator("#file-list li:has(input) .row-name").first();
    await expect(name).toBeVisible();
    await phone.page.evaluate(
      `document.querySelector("#file-list li:has(input) .row-name .head").textContent = "Introduction to Corporate Financial Reporting Week 5 of the long module name"`,
    );
    for (const width of [320, 390]) {
      await phone.page.setViewportSize({ width, height: 844 });
      const box = await name.boundingBox();
      // A 15px line at 1.3 is 19.5 high: two lines, never three.
      expect(Math.round((box?.height ?? 0) / 19.5), `lines at ${width}`).toBe(2);
      expect((box?.x ?? 0) + (box?.width ?? 0), `right edge at ${width}`).toBeLessThanOrEqual(width);
    }
    await screen.context.close();
    await phone.context.close();
  });

  test("SESS-01 a chip changes the countdown: the sheet offers the demo's lengths, applies one tap and closes", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await phone.page.getByRole("button", { name: "Approve" }).click();
    const ends = phone.page.locator("#ends-text");
    await expect(ends).toHaveText(/^Ends in (59|1:00):\d{2}$/);
    await phone.page.getByRole("button", { name: /Change the Session Expiry$/ }).click();
    const sheet = phone.page.getByRole("dialog", { name: "Session Expiry" });
    await expect(sheet).toBeVisible();
    // Exactly three presets, one row under the title and time, in one glass pane.
    await expect(sheet.locator("[data-minutes]")).toHaveText(["30m", "1h", "2h"]);
    // Measured at rest, even from the entry animation's first frame (8 px low): the click above lands on the backdrop.
    await atStart(sheet);
    await atRest(sheet);
    const pane = await sheet.locator("form").boundingBox();
    await expect(sheet.getByLabel("Expires At")).toHaveValue(/^\d{2}:\d{2}$/);
    // Focus lands on the title (announced, no ring), not on Close; Tab reaches the time, then Close.
    await expect(sheet.getByRole("heading", { name: "Session Expiry" })).toBeFocused();
    await phone.page.keyboard.press("Tab");
    const time = sheet.getByLabel("Expires At");
    await expect(time).toBeFocused();
    // Chromium's time input takes a Tab per field (hours, minutes) before focus leaves it; nothing sits between.
    const close = sheet.getByRole("button", { name: "Close" });
    for (let i = 0; i < 6 && (await time.evaluate((n) => n === n.ownerDocument.activeElement)); i++)
      await phone.page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    // A tap above the pane is the backdrop's: it closes with no change.
    await phone.page.mouse.click((pane?.x ?? 0) + (pane?.width ?? 0) / 2, (pane?.y ?? 0) - 12);
    await expect(sheet).toBeHidden();
    await phone.page.getByRole("button", { name: /Change the Session Expiry$/ }).click();
    await expect(sheet).toBeVisible();
    await expectNoAxeViolations(phone.page);
    await sheet.getByRole("button", { name: "30 minutes" }).click();
    await expect(sheet).toBeHidden();
    await expect(ends).toHaveText(/^Ends in (29|30):\d{2}$/);
    // Escape closes it with no change.
    await phone.page.getByRole("button", { name: /Change the Session Expiry$/ }).click();
    await expect(sheet).toBeVisible();
    await phone.page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(ends).toHaveText(/^Ends in (29|30):\d{2}$/);
    // The screen's End while it is open: the sheet goes with "Ends in", never floating over Session Ended.
    await phone.page.getByRole("button", { name: /Change the Session Expiry$/ }).click();
    await expect(sheet).toBeVisible();
    await screen.page.getByRole("button", { name: "End", exact: true }).click();
    await expect(heading(phone.page)).toHaveText("Session Ended");
    await expect(sheet).toBeHidden();
    expect([...screen.csp, ...phone.csp]).toEqual([]);
    await screen.context.close();
    await phone.context.close();
  });

  /** A demo session approved on a 390 phone, its countdown showing. */
  async function approvedDemo(browser: Browser) {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expect(phone.page.locator("#ends-text")).toHaveText(/^Ends in /);
    const lengthButton = phone.page.getByRole("button", { name: /Change the Session Expiry$/ });
    const sheet = phone.page.getByRole("dialog", { name: "Session Expiry" });
    return { screen, phone, lengthButton, sheet };
  }

  for (const width of [320, 390]) {
    test(`SESS-01 at ${width} the sheet is a 2 x 2 grid: the card and Close, the presets and Set`, async ({
      browser,
    }) => {
      const { screen, phone, lengthButton, sheet } = await approvedDemo(browser);
      await phone.page.setViewportSize({ width, height: 640 });
      await lengthButton.click();
      await expect(sheet).toBeVisible();
      // Measured at rest: the pane's entry animation moves every box until it ends.
      await sheet
        .locator("form")
        .evaluate((f) => Promise.all(f.getAnimations().map((a: { finished: Promise<unknown> }) => a.finished)));
      const field = sheet.getByLabel("Expires At");
      // The whole time shows: a time input never scrolls (its scrollWidth is its width even when clipped), so measure
      // the widest 12-hour time in its font, beside its picker icon (about one em), against its content box.
      const fits = await phone.page.evaluate(`(() => {
        const el = document.querySelector(".sheet-card .field");
        const css = getComputedStyle(el);
        const ctx = document.createElement("canvas").getContext("2d");
        ctx.font = css.fontWeight + " " + css.fontSize + " " + css.fontFamily;
        const text = Math.max(...["00:00 PM", "12:59 AM", "08:48 PM"].map((t) => ctx.measureText(t).width));
        const room = el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
        return text + parseFloat(css.fontSize) <= room;
      })()`);
      expect(fits).toBe(true);
      // The input spans its row of the card.
      const card = sheet.locator(".sheet-card");
      const inner = await card.evaluate((n) => n.clientWidth);
      expect(Math.round((await field.boundingBox())?.width ?? 0)).toBe(Math.round(inner));
      // The presets share one row.
      const tops = new Set<number>();
      for (const chip of await sheet.locator("[data-minutes]").all())
        tops.add(Math.round((await chip.boundingBox())?.y ?? -1));
      expect(tops.size).toBe(1);
      // Close spans the card's height; Set is Close's width.
      const [c, x, set] = await Promise.all([
        card.boundingBox(),
        sheet.getByRole("button", { name: "Close" }).boundingBox(),
        sheet.getByRole("button", { name: "Set" }).boundingBox(),
      ]);
      expect(Math.round(x?.height ?? 0)).toBe(Math.round(c?.height ?? -1));
      expect(Math.round(set?.width ?? 0)).toBe(Math.round(x?.width ?? -1));
      expect((x?.width ?? 0) >= 44).toBe(true);
      await expectNoAxeViolations(phone.page);
      // Close closes with no change.
      await sheet.getByRole("button", { name: "Close" }).click();
      await expect(sheet).toBeHidden();
      await screen.context.close();
      await phone.context.close();
    });
  }

  test("SESS-01 a refused length is a toast over the running session: the countdown, Revoke and the sheet stay", async ({
    browser,
  }) => {
    const { screen, phone, lengthButton, sheet } = await approvedDemo(browser);
    await phone.page.route("**/api/session/length", (route) =>
      route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ code: "rate_limited" }) }),
    );
    await lengthButton.click();
    await sheet.getByRole("button", { name: "30 minutes" }).click();
    await expect(phone.page.getByRole("alert")).toContainText("Wait a minute, then try again.");
    await expect(heading(phone.page)).toHaveText("Approved for Demo Room");
    await expect(phone.page.locator("#ends-text")).toHaveText(/^Ends in (59|1:00):\d{2}$/);
    await expect(phone.page.getByRole("button", { name: "Revoke" })).toBeVisible();
    // The sheet still works once the server takes changes again.
    await phone.page.unroute("**/api/session/length");
    await lengthButton.click();
    await sheet.getByRole("button", { name: "30 minutes" }).click();
    await expect(phone.page.locator("#ends-text")).toHaveText(/^Ends in (29|30):\d{2}$/);
    await screen.context.close();
    await phone.context.close();
  });

  test("SESS-01 a failed stylesheet still opens the sheet, and the next open loads it", async ({ browser }) => {
    const { screen, phone, lengthButton, sheet } = await approvedDemo(browser);
    await phone.page.route("**/css/length.css", (route) => route.abort());
    await lengthButton.click();
    await expect(sheet).toBeVisible();
    await phone.page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await phone.page.unroute("**/css/length.css");
    await lengthButton.click();
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(".chips")).toHaveCSS("border-radius", "26px");
    await sheet.getByRole("button", { name: "1 hour" }).click();
    await expect(sheet).toBeHidden();
    await screen.context.close();
    await phone.context.close();
  });

  test("SESS-01 an answer older than the pushed view is dropped: an End meanwhile stays the end", async ({
    browser,
  }) => {
    const { screen, phone, lengthButton, sheet } = await approvedDemo(browser);
    // The server applies the length at once; its answer is held until the screen's End has been pushed.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await phone.page.route("**/api/session/length", async (route) => {
      const response = await route.fetch();
      await held;
      await route.fulfill({ response });
    });
    await lengthButton.click();
    await sheet.getByRole("button", { name: "30 minutes" }).click();
    await expect(phone.page.locator("#ends-text")).toHaveText(/^Ends in (29|30):\d{2}$/);
    await screen.page.getByRole("button", { name: "End", exact: true }).click();
    await expect(heading(phone.page)).toHaveText("Session Ended");
    const answered = phone.page.waitForResponse("**/api/session/length");
    release();
    await answered;
    await expect(heading(phone.page)).toHaveText("Session Ended");
    await expect(phone.page.getByRole("button", { name: "Revoke" })).toBeHidden();
    await screen.context.close();
    await phone.context.close();
  });

  /** The time input's value `minutes` whole minutes past the current minute's start on the phone's clock (0 to 60 s ahead for 0, 60 to 120 s for 1), and its epoch ms. */
  const clockAhead = (page: Page, minutes: number) =>
    page.evaluate((m) => {
      const t = new Date();
      t.setSeconds(0, 0);
      t.setMinutes(t.getMinutes() + m);
      return {
        value: `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`,
        at: t.getTime(),
      };
    }, minutes);

  test("SESS-01 a preset past the cap is cut to it with no toast; a typed time past it leaves Set disabled", async ({
    browser,
  }) => {
    const { screen, phone, lengthButton, sheet } = await approvedDemo(browser);
    const countdown = phone.page.locator("#ends-text");
    // The 2h preset, the demo's cap: cut to approval plus the cap.
    await lengthButton.click();
    await sheet.getByRole("button", { name: "2 hours" }).click();
    await expect(sheet).toBeHidden();
    await expect(countdown).toHaveText(/^Ends in 1:59:\d{2}$/);
    await phone.page.waitForTimeout(300);
    await expectNoToast(phone.page);
    // A typed time past the cap is refused by the sheet, never clamped.
    await lengthButton.click();
    await sheet.getByLabel("Expires At").fill((await clockAhead(phone.page, 180)).value);
    await expect(sheet.getByRole("button", { name: "Set" })).toBeDisabled();
    await screen.context.close();
    await phone.context.close();
  });

  test("SESS-01 an Until time three minutes ahead ends at HH:MM:00; a time not ahead disables Set", async ({
    browser,
  }) => {
    const { screen, phone, lengthButton, sheet } = await approvedDemo(browser);
    const countdown = phone.page.locator("#ends-text");
    await lengthButton.click();
    const set = sheet.getByRole("button", { name: "Set" });
    const target = await clockAhead(phone.page, 3);
    await sheet.getByLabel("Expires At").fill(target.value);
    await expect(set).toBeEnabled();
    const answered = phone.page.waitForResponse("**/api/session/length");
    await set.click();
    expect((await answered).ok()).toBe(true);
    await expect(countdown).toHaveText(/^Ends in \d{1,2}:\d{2}$/);
    // The countdown reads the target to the second, give or take the answer's latency.
    const text = (await countdown.textContent()) ?? "";
    const [m = 0, s = 0] = text.replace("Ends in ", "").split(":").map(Number);
    const left = (target.at - (await phone.page.evaluate(() => Date.now()))) / 1000;
    expect(Math.abs(m * 60 + s - left)).toBeLessThanOrEqual(2);
    // The current minute is a day away, so it is over the cap and refused.
    await lengthButton.click();
    await sheet.getByLabel("Expires At").fill((await clockAhead(phone.page, 0)).value);
    await expect(set).toBeDisabled();
    await screen.context.close();
    await phone.context.close();
  });

  test("SESS-01 a disabled Set says why in a line under the time, and focus leaves it when it goes disabled", async ({
    browser,
  }) => {
    const { screen, phone, lengthButton, sheet } = await approvedDemo(browser);
    const set = sheet.getByRole("button", { name: "Set" });
    const hint = sheet.locator("#length-hint");
    const time = sheet.getByLabel("Expires At");
    await lengthButton.click();
    await time.fill((await clockAhead(phone.page, 3)).value);
    await expect(set).toBeEnabled();
    await expect(hint).toBeHidden();
    // A time just past is a day away: over the room, so refused with the latest end named.
    await set.focus();
    const past = (await clockAhead(phone.page, 0)).value;
    await phone.page.evaluate(
      `(() => { const el = document.getElementById("length-at"); el.value = "${past}"; el.dispatchEvent(new Event("input")); })()`,
    );
    await expect(set).toBeDisabled();
    await expect(time).toBeFocused();
    await expect(hint).toHaveText(/^Pick a time before \d{2}:\d{2}$/);
    await time.fill("");
    await expect(hint).toHaveText("Pick a time");
    await screen.context.close();
    await phone.context.close();
  });

  test("SESS-01 Set on the time the end already shows changes nothing: no request, and the sheet closes", async ({
    browser,
  }) => {
    const { screen, phone, lengthButton, sheet } = await approvedDemo(browser);
    const posts: string[] = [];
    phone.page.on("request", (r) => {
      if (r.url().includes("/api/session/length")) posts.push(r.method());
    });
    await lengthButton.click();
    // The sheet opens on the end's own HH:MM, a minute the end falls in: Set is enabled, and a post would cut its seconds.
    const set = sheet.getByRole("button", { name: "Set" });
    await expect(set).toBeEnabled();
    await set.click();
    await expect(sheet).toBeHidden();
    await phone.page.waitForTimeout(500);
    expect(posts).toEqual([]);
    await screen.context.close();
    await phone.context.close();
  });

  test("SESS-01 an end the server cuts more than a minute short of the ask shows a Capped toast", async ({
    browser,
  }) => {
    const { screen, phone, lengthButton, sheet } = await approvedDemo(browser);
    // The answer comes back an hour short of the 2 h asked, as late in a session it would.
    await phone.page.route("**/api/session/length", async (route) => {
      const response = await route.fetch();
      const view = await response.json();
      await route.fulfill({ response, json: { ...view, endsAt: view.now + 3600_000 } });
    });
    await lengthButton.click();
    await sheet.getByRole("button", { name: "2 hours" }).click();
    await expect(phone.page.getByText(/^Capped at \d{2}:\d{2}$/)).toBeVisible();
    await screen.context.close();
    await phone.context.close();
  });

  test("SESS-01 a typed time past approval plus the cap is refused though it is within the cap of now", async ({
    browser,
  }) => {
    const { screen, phone, lengthButton, sheet } = await approvedDemo(browser);
    // Every view the phone gets (socket frames, the state read and the length answer) says the latest end is an hour
    // sooner, as it would an hour after approval: 90 minutes ahead is within 2 h of now but past it. (The phone corrects
    // its clock by each view, so a faked clock cannot do this.)
    const sooner = (view: { latestEnd?: number | null } | undefined) => {
      if (view?.latestEnd != null) view.latestEnd -= 3600_000;
    };
    await phone.page.routeWebSocket(/.*/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => {
        const frame = typeof m === "string" ? JSON.parse(m) : null;
        if (frame?.t === "state") sooner(frame.view);
        ws.send(frame ? JSON.stringify(frame) : m);
      });
    });
    await phone.page.route(/\/api\/(pair\/state|session\/length)/, async (route) => {
      const response = await route.fetch();
      const view = await response.json();
      sooner(view);
      await route.fulfill({ response, json: view });
    });
    await phone.page.reload();
    await expect(phone.page.locator("#ends-text")).toHaveText(/^Ends in /);
    await lengthButton.click();
    const time = sheet.getByLabel("Expires At");
    const set = sheet.getByRole("button", { name: "Set" });
    await time.fill((await clockAhead(phone.page, 90)).value);
    await expect(set).toBeDisabled();
    await expect(sheet.locator("#length-hint")).toHaveText(/^Pick a time before \d{2}:\d{2}$/);
    await time.fill((await clockAhead(phone.page, 30)).value);
    await expect(set).toBeEnabled();
    await screen.context.close();
    await phone.context.close();
  });

  test("P1 Approved at 390 x 844: Revoke sits in the floating glass panel and the title is one inset from the top", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expect(heading(phone.page)).toHaveText("Approved for Demo Room");
    const revoke = phone.page.locator(".column > .actions.glass").getByRole("button", { name: "Revoke" });
    await expect(revoke).toBeInViewport({ ratio: 1 });
    const inset = await insetOf(phone.page);
    await expect(async () => {
      const title = await heading(phone.page).boundingBox();
      expect(Math.round(title?.y ?? -1)).toBe(Math.round(inset));
    }).toPass();
    await screen.context.close();
    await phone.context.close();
  });

  test("P2 the picker opens the chooser directly: its accept list, and no capture attribute to skip the library", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    const pick = phone.page.locator("#file-pick");
    await expect(pick).toHaveAttribute("type", "file");
    await expect(pick).toHaveAttribute("accept", /(^|,)image\/jpeg,.*\.pptx/);
    await expect(pick).not.toHaveAttribute("capture");
    await expect(pick).not.toHaveAttribute("multiple");
    const chooser = phone.page.waitForEvent("filechooser");
    await phone.page.getByRole("button", { name: "Add a File" }).click();
    expect((await chooser).isMultiple()).toBe(false);
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

  test("a code typed before the page's script runs still enables Continue", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const code = await typedCodeOf(screen.page);
    let release: () => void = () => {};
    const held = new Promise<void>((done) => (release = done));
    const phone = await open(browser, "phone", "about:blank");
    await phone.page.route("**/js/code.js", async (route) => {
      await held;
      await route.continue();
    });
    // A held module holds the load event, so this load waits only for the markup.
    await phone.page.goto("/code", { waitUntil: "commit" });
    // The field is typed into while code.js is held: no listener hears it.
    await phone.page.getByLabel("Code").fill(code);
    const go = phone.page.getByRole("button", { name: "Continue" });
    await expect(go).toBeDisabled();
    release();
    await expect(go).toBeEnabled();
    await expect(phone.page.getByLabel("Code")).toHaveValue(`${code.slice(0, 3)} ${code.slice(3)}`);
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
    // The heading reads Demo Room before and after; the new code lands when the drop's answer does.
    await expect.poll(() => typedCodeOf(screen.page)).not.toBe(before);
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

    await revoke(phone.page);
    await expect(heading(phone.page)).toHaveText("Session Ended");
    // A demo phone's end: the waitlist link on top, in the same tab, Done under it.
    const join = phone.page.locator("#actions").getByRole("link", { name: "Join the Waitlist" });
    await expect(join).toHaveAttribute("href", "https://tally.so/r/Yj4KAN?source=phone");
    await expect(join).toHaveAttribute("data-waitlist", "");
    expect(await join.getAttribute("target")).toBeNull();
    const done = phone.page.locator("#actions").getByRole("button", { name: "Done" });
    expect(await done.getAttribute("class")).toContain("secondary");
    const [j, d] = await Promise.all([join.boundingBox(), done.boundingBox()]);
    expect(Math.round((j?.y ?? 0) + (j?.height ?? 0))).toBeLessThanOrEqual(Math.round(d?.y ?? -1));
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
    // A tap says nothing: the line under the title stays as the end set it, and a burst of taps (and the repaints
    // between them) asks for one code, not one each.
    // The screen's End by hand names no reason and the demo holds no PowerPoint or download: no line at all.
    const line = page.locator("#line");
    await expect(line).toBeEmpty();
    await page.waitForTimeout(800);
    for (let i = 0; i < 3; i++) {
      await page.mouse.click(SCREEN.width / 2, 80);
      await page.waitForTimeout(100);
      await expect(line).toHaveText("");
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
    await revoke(phone.page);
    await expect(heading(phone.page)).toHaveText("You're Offline");
    await expect(phone.page.getByRole("button", { name: "Revoke" })).toBeVisible();
    // Revoke alone retries its own failure.
    await expect(phone.page.getByRole("button", { name: "Try Again" })).toHaveCount(0);
    await expect(phone.page.getByRole("link", { name: "Back", exact: true })).toBeHidden();
    expect(await phone.page.evaluate(() => localStorage.getItem("bloop.pid"))).not.toBeNull();
    await phone.page.unroute("**/api/end");
    await revoke(phone.page);
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
  const EXE = { name: "notes.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") };

  test("the first file drag loads the drop hint: it shows at once, leaves with the drag, and a drop takes the picker's road", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    const page = phone.page;
    // The hint shows from 640 wide.
    await page.setViewportSize({ width: 834, height: 1112 });
    const loads: string[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/js/core/drag.js")) loads.push(r.url());
    });
    const files = await page.evaluateHandle(() => {
      type Transfer = { items: { add(file: File): void } };
      const d = new (globalThis as unknown as { DataTransfer: new () => Transfer }).DataTransfer();
      d.items.add(new File(["MZ"], "notes.exe", { type: "application/octet-stream" }));
      return d;
    });
    expect(loads).toEqual([]);
    await page.dispatchEvent("body", "dragenter", { dataTransfer: files });
    await expect(page.locator("#drop-hint")).toBeVisible();
    expect(loads).toHaveLength(1);
    await page.dispatchEvent("body", "dragleave", { dataTransfer: files });
    await expect(page.locator("#drop-hint")).toBeHidden();
    // A drop runs the picker's check: a wrong type is a toast over the same page, and the hint goes.
    await page.dispatchEvent("body", "dragenter", { dataTransfer: files });
    await page.dispatchEvent("body", "drop", { dataTransfer: files });
    await expect(page.getByRole("alert")).toContainText("This File Type Isn't Supported");
    await expect(page.locator("#drop-hint")).toBeHidden();
    await expect(heading(page)).toHaveText("Demo Room");
    expect(loads).toHaveLength(1);
    await screen.context.close();
    await phone.context.close();
  });

  test("a drop never waits on the hint's module: with it unloadable, the drop still takes the picker's road", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    const page = phone.page;
    await page.route("**/js/core/drag.js", (route) => route.abort());
    const files = await page.evaluateHandle(() => {
      type Transfer = { items: { add(file: File): void } };
      const d = new (globalThis as unknown as { DataTransfer: new () => Transfer }).DataTransfer();
      d.items.add(new File(["MZ"], "notes.exe", { type: "application/octet-stream" }));
      return d;
    });
    await page.dispatchEvent("body", "dragenter", { dataTransfer: files });
    await page.dispatchEvent("body", "drop", { dataTransfer: files });
    await expect(page.getByRole("alert")).toContainText("This File Type Isn't Supported");
    await expect(heading(page)).toHaveText("Demo Room");
    await screen.context.close();
    await phone.context.close();
  });

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
    // over this server's demo cap (wrangler.jsonc, 25 MB), which the toast reads from the claim
    await addFile(phone.page, { name: "big.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(26 * 1024 * 1024) });
    await expect(phone.page.getByRole("alert")).toContainText("The demo takes files up to 25 MB.");
    await expect(heading(phone.page)).toHaveText("Demo Room");
    // a video over the cap is told as recording time (about 1 MB a second), with the cap itself
    await addFile(phone.page, { name: "clip.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(26 * 1024 * 1024) });
    await expect(phone.page.getByRole("alert")).toContainText("Video Too Long");
    await expect(phone.page.getByRole("alert")).toContainText(
      "The demo takes videos up to about 20\u00a0seconds (25 MB).",
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
    await expect(heading(phone.page)).toHaveText("Approved for Demo Room");
    expect(await launches()).toEqual({ opened: 0, left: [] });
    await expectNoAxeViolations(screen.page);

    // Download mints its own link on the first click, so it never meets the 2 minute life of the one the screen fetched.
    const saved = screen.page.waitForEvent("download");
    await screen.page.getByRole("button", { name: "Download" }).click();
    expect((await saved).suggestedFilename()).toBe("sample-deck.pptx");

    await revoke(phone.page);
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

  test("after Sent, the browser's Back leaves the page at once: the offer's history entry went with it", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const code = await typedCodeOf(screen.page);
    const context = await browser.newContext({ viewport: PHONE });
    const page = await context.newPage();
    await page.goto("/");
    await page.goto(`/a?c=${code}`);
    await expect(page.locator("#file-list")).toBeVisible();
    await addFile(page, DECK);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(heading(page)).toHaveText("Sent to Demo Room");
    await page.goBack();
    await expect(page).toHaveURL("/");
    await context.close();
    await screen.context.close();
  });

  test("a photo module that fails to load is a refusal toast, and the list comes back", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await phone.page.route("**/js/core/photo.js", (route) => route.abort());
    await addFile(phone.page, { name: "a.png", mimeType: "image/png", buffer: Buffer.from("x") });
    await phone.page.getByRole("button", { name: "Send" }).click();
    await expect(phone.page.getByRole("alert")).toContainText("This Photo Can't Be Sent");
    await expect(heading(phone.page)).toHaveText("Demo Room");
    await expect(phone.page.getByRole("button", { name: "Add a File" })).toBeVisible();
    await screen.context.close();
    await phone.context.close();
  });

  test("a refusal's words load on the refusal (core/refusal.js), never on the first load", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    expect(await modules(phone.page)).not.toContain("/js/core/refusal.js");
    await addFile(phone.page, { name: "empty.png", mimeType: "image/png", buffer: Buffer.alloc(0) });
    await expect(phone.page.getByRole("alert")).toContainText("This File Is Empty");
    expect(await modules(phone.page)).toContain("/js/core/refusal.js");
    await expect(heading(phone.page)).toHaveText("Demo Room");
    await screen.context.close();
    await phone.context.close();
  });

  test("refusal words that fail to load are the general refusal toast, and the list stays", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await phone.page.route("**/js/core/refusal.js", (route) => route.abort());
    await addFile(phone.page, { name: "empty.png", mimeType: "image/png", buffer: Buffer.alloc(0) });
    const alert = phone.page.getByRole("alert");
    await expect(alert).toContainText("This File Can't Be Sent");
    await expect(alert).toContainText(/Choose a \.pptx, .* file under \d+ MB\./);
    await expect(heading(phone.page)).toHaveText("Demo Room");
    await expect(phone.page.getByRole("button", { name: "Add a File" })).toBeVisible();
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

    await addFile(phone.page, {
      name: "A long holiday photo from the beach at sunset.png",
      mimeType: "image/png",
      buffer: png(3000, 2000),
    });
    // A long name is cut in the middle, its extension kept; the line under it holds it whole.
    await expect(heading(phone.page)).toHaveText("Send A long holiday phot…nset.png to Demo Room?");
    await expect(phone.page.locator("#file-name")).toHaveText("A long holiday photo from the beach at sunset.png");
    expect(await modules(phone.page)).not.toContain("/js/core/photo.js");
    await phone.page.getByRole("button", { name: "Send" }).click();
    await expect(heading(phone.page)).toHaveText("Sending A long holiday photo from the beach at sunset.png");
    const row = phone.page.locator("#file-list .row.upload");
    await expect(
      row.getByRole("progressbar", { name: "Sending A long holiday photo from the beach at sunset.png" }),
    ).toBeVisible();
    await expect(row.locator(".small")).toHaveText(/^(Compressing|\d+% sent|Finishing)$/);
    await expect(phone.page.locator("progress")).toHaveCount(0);
    // A long name ellipsizes inside the card: the row never widens the list (or the page).
    const list = await phone.page.locator("#file-list").boundingBox();
    const rowBox = await row.boundingBox();
    expect(Math.round((rowBox?.x ?? 0) + (rowBox?.width ?? 0))).toBeLessThanOrEqual(
      Math.round((list?.x ?? 0) + (list?.width ?? 0)),
    );
    expect(
      await phone.page.evaluate(
        () =>
          (globalThis as unknown as { document: { documentElement: { scrollWidth: number } } }).document.documentElement
            .scrollWidth,
      ),
    ).toBe(390);
    release();

    await expect(heading(phone.page)).toHaveText("Sent to Demo Room");
    const modulesNow = await modules(phone.page);
    expect(modulesNow).toContain("/js/core/photo.js");
    expect(modulesNow).not.toContain("/js/core/video.js");
    // Re-encoded on the phone: a JPEG (SOI, then a JFIF APP0 from the canvas), named .jpg, its long side at 2560.
    const out = await sent(phone.page);
    expect(out.name).toBe("A long holiday photo from the beach at sunset.jpg");
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

test.describe("a guest's photo and video on the screen (design.md section 7, Video)", () => {
  /** A 4 s, 128 x 72 VP9 MP4 (ffmpeg testsrc2): Playwright's Chromium plays VP9, not H.264. */
  const CLIP = readFileSync("test/fixtures/media/clip.mp4");
  /** Passes the server's checks (an ftyp box, then a data box) but holds no movie, so no browser can play it. */
  const BROKEN = (() => {
    const box = (type: string, body: Buffer) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(8 + body.length);
      head.write(type, 4, "latin1");
      return Buffer.concat([head, body]);
    };
    return Buffer.concat([
      box("ftyp", Buffer.from("isom\0\0\x02\0isom", "latin1")),
      box("mdat", Buffer.alloc(2048, 0xab)),
    ]);
  })();

  /** The phone's claim becomes a guest at the first byte: the drop API the phone's picker sends through. */
  async function sendAsGuest(phone: Page, name: string, bytes: Buffer) {
    const status = await phone.evaluate(
      async ([n, b]) => {
        const g = globalThis as unknown as {
          localStorage: { getItem(k: string): string | null };
          fetch: (u: string, i: object) => Promise<{ status: number }>;
        };
        const res = await g.fetch("/api/drop", {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${g.localStorage.getItem("bloop.pid")}`,
            "Content-Type": "application/octet-stream",
            "X-Bloop-Name": encodeURIComponent(n),
          },
          body: new Uint8Array(b),
        });
        return res.status;
      },
      [name, [...bytes]] as const,
    );
    expect(status).toBe(200);
  }

  /** A demo screen showing one guest file, opened by the screen's Open click. */
  async function openAsGuest(browser: Browser, name: string, bytes: Buffer, slow = false, live = false, prep?: Prep) {
    const screen = await (live ? liveScreen : demoScreen)(browser, prep);
    const { phone } = await scan(browser, screen.page, live ? LIVE : DEMO);
    await sendAsGuest(phone.page, name, bytes);
    await expect(heading(screen.page)).toHaveText("Sent by a Guest");
    if (slow) {
      let first = true;
      await screen.page.route("**/f/**", async (route) => {
        if (first) await new Promise((done) => setTimeout(done, 1500));
        first = false;
        await route.continue();
      });
    }
    await screen.page.getByRole("button", { name: "Open" }).click();
    return { screen, phone, page: screen.page };
  }

  /** The stage video's state; the node tsconfig has no DOM lib, so it is typed by hand. */
  const media = (page: Page) =>
    page.locator("#frame video").evaluate((el) => {
      const v = el as unknown as { paused: boolean; muted: boolean; autoplay: boolean; currentTime: number };
      return { paused: v.paused, muted: v.muted, autoplay: v.autoplay, at: v.currentTime };
    });

  test("a guest's photo is drawn on the stage as the demo's is, and presents edge to edge", async ({ browser }) => {
    const { screen, phone, page } = await openAsGuest(browser, "Board.png", png(1200, 800));
    await expect(page.getByRole("img", { name: "Board.png" })).toBeVisible();
    await expect(page.locator("#frame .loader")).toHaveCount(0);
    await expect(heading(page)).toHaveText("Board.png");
    await expect(page.locator("#items")).toBeHidden();
    await page.getByRole("button", { name: "Present", exact: true }).click();
    await expect(page.locator("body")).toHaveClass(/is-presenting/);
    const box = await page.locator(STAGED).boundingBox();
    expect([Math.round(box?.width ?? 0), Math.round(box?.height ?? 0)]).toEqual([SCREEN.width, SCREEN.height]);
    await page.keyboard.press("Escape");
    await expect(page.locator("body")).not.toHaveClass(/is-presenting/);
    await screen.context.close();
    await phone.context.close();
  });

  test("a guest's video streams by range under its loader, waits on its metadata with sound, plays, seeks and presents; the end takes it down", async ({
    browser,
  }) => {
    const { screen, phone, page } = await openAsGuest(browser, "Talk.mp4", CLIP, true);
    // Until the metadata: the one loader, indeterminate (a video has no byte count to show), Present held.
    const loader = page.locator("#frame .loader.stand-in");
    await expect(loader).toBeVisible();
    await expect(loader).toHaveAttribute("aria-label", "Loading Talk.mp4");
    expect(await loader.getAttribute("aria-valuenow")).toBeNull();
    await expect(page.getByRole("button", { name: "Present", exact: true })).toBeDisabled();
    const ranged = page.waitForResponse((r) => r.url().includes("/f/") && r.status() === 206);
    await expect(page.locator("#frame video")).toBeVisible({ timeout: 15_000 });
    await ranged;
    await expect(page.locator("#frame .loader")).toHaveCount(0);
    await expect(page.locator("#frame video")).toHaveAttribute("aria-label", "Talk.mp4");
    // Its own 16 : 9 frame, never the photo's 3 : 2.
    const frame = await page.locator("#frame video").boundingBox();
    expect(Math.round(((frame?.width ?? 0) / (frame?.height ?? 1)) * 100)).toBe(178);
    await expect(page.getByRole("button", { name: "Present", exact: true })).toBeEnabled();
    // VID-05 sound: it plays at once, with sound (the Open click was this page's gesture), and no Tap for Sound.
    await expect.poll(async () => (await media(page)).at, { timeout: 10_000 }).toBeGreaterThan(0.3);
    expect(await media(page)).toMatchObject({ paused: false, muted: false, autoplay: false });
    await expect(page.getByRole("button", { name: "Tap for Sound" })).toBeHidden();
    await page.locator("#frame video").evaluate((el) => {
      (el as unknown as { currentTime: number }).currentTime = 3;
    });
    await expect.poll(async () => (await media(page)).at).toBeGreaterThanOrEqual(3);

    await page.getByRole("button", { name: "Present", exact: true }).click();
    await expect(page.locator("body")).toHaveClass(/is-presenting/);
    const full = await page.locator("#frame video").boundingBox();
    expect([Math.round(full?.width ?? 0), Math.round(full?.height ?? 0)]).toEqual([SCREEN.width, SCREEN.height]);
    await expect(page.locator("#frame video")).toHaveCSS("object-fit", "contain");
    await page.keyboard.press("Escape");
    await expect(page.locator("body")).not.toHaveClass(/is-presenting/);
    await expectNoAxeViolations(page);

    // The session ends mid-play: Session Ended takes the screen, and the video and its link go with it.
    await revoke(phone.page);
    await expect(heading(page)).toHaveText("Session Ended");
    await expect(page.locator("video")).toHaveCount(0);
    await screen.context.close();
    await phone.context.close();
  });

  test("a live screen plays a guest's video in its own page, never a window: a window's sandboxed document cannot play it", async ({
    browser,
  }) => {
    const { screen, phone, page } = await openAsGuest(browser, "Talk.mp4", CLIP, false, true);
    await expect(page.locator("#frame video")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#frame .loader")).toHaveCount(0);
    await expect(heading(page)).toHaveText("Talk.mp4");
    await expect(page.getByRole("button", { name: "Present", exact: true })).toBeEnabled();
    await expect.poll(async () => (await media(page)).at, { timeout: 10_000 }).toBeGreaterThan(0.3);
    // No window was ever opened: the screen's context holds its one page.
    expect(screen.context.pages()).toHaveLength(1);
    await expect(phone.page.getByRole("button", { name: "Revoke" })).toBeVisible();
    await screen.context.close();
    await phone.context.close();
  });

  /** A browser that holds sound until Tap for Sound is tapped: the autoplay policy Playwright's Chromium skips. */
  const holdSound = (context: BrowserContext) =>
    context.addInitScript({
      content: `{
        const play = HTMLMediaElement.prototype.play;
        let held = true;
        addEventListener("click", (e) => { if (e.target instanceof Element && e.target.id === "b-sound") held = false; }, true);
        HTMLMediaElement.prototype.play = function () {
          return held && !this.muted ? Promise.reject(new DOMException("held", "NotAllowedError")) : play.call(this);
        };
      }`,
    });

  test("VID-05 sound: the phone pauses, plays and mutes the screen's video, and the screen's own hand reports back", async ({
    browser,
  }) => {
    const { screen, phone, page } = await openAsGuest(browser, "Talk.mp4", CLIP);
    await expect(page.locator("#frame video")).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await media(page)).paused).toBe(false);
    const bubbles = phone.page.getByRole("group", { name: "The Screen" });
    const play = bubbles.getByRole("button", { name: "Play" });
    const sound = bubbles.getByRole("button", { name: "Sound" });
    // A video's bubbles play and sound instead of stepping.
    await expect(bubbles.getByRole("button", { name: "Next" })).toBeHidden();
    await expect(play).toHaveAttribute("aria-pressed", "true");
    await expect(sound).toHaveAttribute("aria-pressed", "true");
    await play.click();
    await expect.poll(async () => (await media(page)).paused).toBe(true);
    await expect(play).toHaveAttribute("aria-pressed", "false");
    await play.click();
    await expect.poll(async () => (await media(page)).paused).toBe(false);
    await sound.click();
    await expect.poll(async () => (await media(page)).muted).toBe(true);
    await expect(sound).toHaveAttribute("aria-pressed", "false");
    // The screen's own hand (a pause with user activation, as its native controls make) reaches the phone.
    await page.mouse.click(4, SCREEN.height - 4);
    await page.locator("#frame video").evaluate((el) => (el as unknown as { pause(): void }).pause());
    await expect(play).toHaveAttribute("aria-pressed", "false");
    await screen.context.close();
    await phone.context.close();
  });

  test("VID-05 sound: a screen whose browser holds sound plays the video muted with Tap for Sound, the phone says so, and the tap brings sound", async ({
    browser,
  }) => {
    const { screen, phone, page } = await openAsGuest(browser, "Talk.mp4", CLIP, false, false, holdSound);
    await expect(page.locator("#frame video")).toBeVisible({ timeout: 15_000 });
    const tap = page.getByRole("button", { name: "Tap for Sound" });
    await expect(tap).toBeVisible();
    await expect.poll(() => media(page)).toMatchObject({ paused: false, muted: true });
    const line = phone.page.getByText("Tap the screen once for sound.");
    await expect(line).toBeVisible();
    const sound = phone.page.getByRole("group", { name: "The Screen" }).getByRole("button", { name: "Sound" });
    await expect(sound).toHaveAttribute("aria-pressed", "false");
    await expectNoAxeViolations(page);
    await tap.click();
    await expect.poll(() => media(page)).toMatchObject({ paused: false, muted: false });
    await expect(tap).toBeHidden();
    await expect(line).toBeHidden();
    await expect(sound).toHaveAttribute("aria-pressed", "true");
    await screen.context.close();
    await phone.context.close();
  });

  test("VID-03 a video this browser cannot play shows This Video Can't Play Here, with Download as the way on", async ({
    browser,
  }) => {
    const { screen, phone, page } = await openAsGuest(browser, "Broken.mp4", BROKEN);
    const card = page.locator(".item-card");
    await expect(card).toContainText("This Video Can't Play Here", { timeout: 15_000 });
    // The card's own line, as every file card: the name is the stage's heading.
    await expect(card).toContainText("MP4 video · 2 KB");
    await expect(heading(page)).toHaveText("Broken.mp4");
    await expect(card).toHaveAttribute("role", "alert");
    await expect(page.locator("#frame video")).toHaveCount(0);
    await expect(page.locator("#frame .loader")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Present", exact: true })).toBeHidden();
    await expect(page.getByRole("button", { name: "Download" })).toBeVisible();
    await expectNoAxeViolations(page);
    await screen.context.close();
    await phone.context.close();
  });
});

test.describe("open path", () => {
  test("RES-01 storage: launch, the Download fallback at once, the PDF view, and End leaving no sid", async ({
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
    // At once, and secondary to the launch's own Open.
    await expect(download).toBeVisible();
    await expect(download).toHaveClass(/secondary/);
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
    // A live phone's end is Done alone.
    await expect(phone.page.locator("#actions").locator(".btn")).toHaveCount(1);
    await expect(phone.page.locator("#actions").getByRole("button", { name: "Done" })).toBeVisible();
    await expect(phone.page.locator("[data-waitlist]")).toHaveCount(0);
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
    // The arrow shows only in the outer 20% of the slide's width, which is the outer 40% of a half.
    const nextZone = screen.page.locator("#next");
    const half = await nextZone.boundingBox();
    if (!half) throw new Error("the Next zone has no box");
    const disc = nextZone.locator(".icon");
    await screen.page.mouse.move(half.x + half.width * 0.3, half.y + half.height / 2);
    await expect(disc).toHaveCSS("opacity", "0");
    await screen.page.mouse.move(half.x + half.width * 0.8, half.y + half.height / 2);
    await expect(disc).toHaveCSS("opacity", "1");
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

  test("at 390 x 844 the handle docks on a hairline ring: no drop shadow reaches below it, no band under it", async ({
    browser,
  }) => {
    // iOS Safari tints its floating toolbar from the strip under the handle, so a soft shadow there reads as a gray
    // band. Chromium has no such toolbar; the computed values are what can be checked.
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { bottom: 34, bottomMax: 34 } });
    await page.goto("/s?mode=demo");
    await page.getByRole("link", { name: "Approve on This Phone" }).click();
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(heading(page)).toHaveText("Dog.jpg");
    await expect(page.locator("#handle")).toBeVisible();
    const dock = await page.evaluate(`(() => {
      const handle = document.getElementById("handle");
      // Each outer layer's reach under the box: y offset + blur + spread.
      const reach = Math.max(0, ...getComputedStyle(handle).boxShadow.split(/,(?![^(]*\\))/)
        .filter((layer) => !layer.includes("inset") && layer.trim() !== "none")
        .map((layer) => {
          const [, y = 0, blur = 0, spread = 0] = (layer.replace(/rgba?\\([^)]*\\)/, "").match(/-?[\\d.]+px/g) ?? [])
            .map(parseFloat);
          return y + blur + spread;
        }));
      const page = getComputedStyle(document.body).backgroundColor;
      const band = [];
      for (let y = Math.ceil(handle.getBoundingClientRect().bottom) + 1; y < innerHeight; y += 2) {
        for (const el of document.elementsFromPoint(innerWidth / 2, y)) {
          const s = getComputedStyle(el);
          const fill = s.backgroundColor;
          if (s.backgroundImage !== "none" || (fill !== "rgba(0, 0, 0, 0)" && fill !== page)) band.push(el.tagName + " " + y);
        }
      }
      return { reach, band };
    })()`);
    expect(dock).toEqual({ reach: expect.any(Number), band: [] });
    expect((dock as { reach: number }).reach).toBeLessThanOrEqual(1);
    await context.close();
  });

  test("DEMO-01 isolation: a second tab of the same browser starts its own demo screen, never the first one's", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const first = await typedCodeOf(screen.page);
    const second = await screen.context.newPage();
    await second.goto("/s?mode=demo");
    await expect.poll(() => typedCodeOf(second)).not.toBe(first);
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

  /** Once the glides are awaited: none left, and each visible control is what sits at its own center. */
  async function controlsSettled(page: Page) {
    const state = await page.evaluate(`(async () => {
      // The resize observer fits the pill after the first frame.
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const bar = document.getElementById("controls");
      await Promise.all(bar.getAnimations().map((a) => a.finished.catch(() => {})));
      // A disabled control takes no pointer, so the point goes through it.
      const missed = [...bar.querySelectorAll(".btn:not(:disabled)")]
        .filter((b) => b.getClientRects().length)
        .filter((b) => {
          const r = b.getBoundingClientRect();
          return !b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
        })
        .map((b) => b.textContent + " " + JSON.stringify(b.getBoundingClientRect()) + " in " + innerWidth + "x" + innerHeight);
      return { animations: bar.getAnimations().length, missed };
    })()`);
    expect(state).toEqual({ animations: 0, missed: [] });
  }

  /** Square and portrait pictures standing in for the photo. */
  const SQUARE = png(900, 900);
  const WIDE = png(1500, 1000);

  test("a resize that moves the pill never glides it from the old window", async ({ browser }) => {
    const { screen, phone } = await viewerWith(browser);
    const page = screen.page;
    await page.setViewportSize({ width: 1300, height: 440 });
    await expect(page.locator(STAGED)).toBeVisible();
    await controlsSettled(page);
    await page.setViewportSize({ width: 1000, height: 604 });
    // Once the resize has been fitted (the observer runs after the first frame): nothing animates, and the pill is
    // inside the window.
    const next = await page.evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const bar = document.getElementById("controls");
      const r = bar.getBoundingClientRect();
      done({
        animations: bar.getAnimations().length,
        inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      });
    })))`);
    expect(next).toEqual({ animations: 0, inside: true });
    await controlsSettled(page);
    await screen.context.close();
    await phone.context.close();
  });

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
    await controlsSettled(screen.page);
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
    await controlsSettled(screen.page);
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
    await controlsSettled(screen.page);
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
    await controlsSettled(page);
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

  test("a switch that adds or drops the page count keeps the pill's center; only the count's segment moves", async ({
    browser,
  }) => {
    const { screen, phone } = await viewerWith(browser);
    const page = screen.page;
    await expect(heading(page)).toHaveText("Dog.jpg");
    await page.waitForTimeout(600);
    /** Per frame for 1.2 s from now: [left, width, center, top] of the pill. */
    const sample = async (act: () => Promise<void>) => {
      await page.evaluate(
        "(() => { const p = document.getElementById('controls'); const out = (window.frames_ = []); const t0 = performance.now(); const tick = () => { const r = p.getBoundingClientRect(); out.push([r.left, r.width, r.left + r.width / 2, r.top]); if (performance.now() - t0 < 1200) requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()",
      );
      await act();
      await page.waitForTimeout(1300);
      return (await page.evaluate("window.frames_")) as [number, number, number, number][];
    };
    /** Every frame's step goes the way the whole move goes, or holds: nothing steps back. */
    const oneWay = (values: number[], what: string) => {
      const way = Math.sign((values.at(-1) ?? 0) - (values[0] ?? 0));
      for (let i = 1; i < values.length; i++) {
        const step = (values[i] ?? 0) - (values[i - 1] ?? 0);
        expect(step * way >= -0.5, `${what}, frame ${i}: ${step}`).toBe(true);
      }
    };
    for (const [to, grows] of [
      ["Sample deck.pptx", true],
      ["Dog.jpg", false],
    ] as const) {
      const frames = await sample(() => sidebarItem(page, to).click());
      const last = frames.at(-1) ?? [0, 0, 0];
      for (const [, , center] of frames)
        expect(Math.abs(Math.round(center) - Math.round(last[2]))).toBeLessThanOrEqual(1);
      // The width and the top only ever move one way, so nothing steps back.
      const widths = frames.map((f) => f[1]);
      oneWay(widths, `${to} width`);
      oneWay(
        frames.map((f) => f[3]),
        `${to} top`,
      );
      expect(grows ? last[1] > (frames[0]?.[1] ?? 0) : last[1] < (frames[0]?.[1] ?? 0)).toBe(true);
      // Once the width starts to move it keeps moving until it is within a pixel of the end: no stall.
      const from = widths.findIndex((w) => Math.abs(w - (widths[0] ?? 0)) > 0.5);
      const settled = widths.findIndex((w) => Math.abs(w - last[1]) <= 1);
      for (let i = Math.max(from, 1); i < settled; i++)
        expect(Math.abs((widths[i] ?? 0) - (widths[i - 1] ?? 0)) > 0.01, `${to} width stalls at frame ${i}`).toBe(true);
    }
    // Under reduced motion it changes at once.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await sidebarItem(page, "Sample deck.pptx").click();
    await expect(page.locator("#dots")).toBeVisible();
    expect(await page.evaluate("document.getElementById('dots').getAnimations().length")).toBe(0);
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
    // Present holds its place in the pill, disabled, so the pill keeps one shape when the photo lands.
    const present = page.getByRole("button", { name: "Present", exact: true });
    await expect(present).toBeVisible();
    await expect(present).toBeDisabled();
    // Download joins the pill once the session leaves `approved` (no mint before the first fetch); measure after it.
    await expect(page.getByRole("button", { name: "Download", exact: true })).toBeVisible();
    const { pill } = await settledPill(page);
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
    await expect(present).toBeEnabled();
    expect(Math.round((await settledPill(page)).pill.width)).toBe(Math.round(pill.width));
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

  test("a screen shows no Back before its first paint, then shows it", async ({ browser }) => {
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
    await expect(page.locator("#b-back")).toHaveCSS("visibility", "hidden");
    release();
    await typedCodeOf(page);
    await expect(page.locator("#b-back")).toBeVisible();
    // No footer line: the screen never sends anyone to another way in (design.md section 3).
    await expect(page.getByText(/sign in/i)).toHaveCount(0);
    await context.close();
  });

  test("with no script the screen keeps its static Back", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 834, height: 1000 }, javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto("/s");
    await expect(page.locator("#b-back")).toBeVisible();
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
    await revoke(page);
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

  // Waiting or a refresh is all these states allow: Back would leave the room PC on the home page.
  for (const [state, title, fail] of [
    [
      "service down",
      "bloop Isn't Responding",
      (r: Route) => r.fulfill({ status: 500, contentType: "application/json", body: '{"code":"internal"}' }),
    ],
    ["offline", "Offline", (r: Route) => r.abort()],
    [
      "rate limited",
      "Busy Right Now",
      (r: Route) => r.fulfill({ status: 429, contentType: "application/json", body: '{"code":"rate_limited"}' }),
    ],
  ] as const) {
    test(`${state} outside a session shows no Back; waiting brings it back`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: SCREEN });
      const page = await context.newPage();
      await page.route("**/api/screens", fail);
      await page.goto("/s");
      await expect(heading(page)).toHaveText(title);
      await expect(page.locator("#b-back")).toBeHidden();
      await page.unroute("**/api/screens");
      await expect(page.locator("#qr")).toBeVisible({ timeout: 40_000 });
      await expect(page.locator("#b-back")).toBeVisible();
      await context.close();
    });
  }

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

test.describe("PAIR-13 remote: the phone commands the demo screen (design.md section 7, Phone page)", () => {
  /** A demo session approved on a 390 phone, the screen in its viewer and the remote on the phone. */
  async function remote(browser: Browser) {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expectViewer(screen.page);
    const preview = phone.page.locator(".preview");
    const row = (name: string) => phone.page.locator("#file-list").getByRole("button", { name: startsWith(name) });
    const bubbles = phone.page.getByRole("group", { name: "The Screen" });
    await expect(bubbles).toBeVisible();
    const dots = screen.page.locator("#dots");
    return { screen, phone, preview, row, bubbles, dots };
  }
  const close = async (...opened: Opened[]) => {
    for (const o of opened) await o.context.close();
  };

  test("a phone tap moves the screen, and the row on screen is marked; a link row is not a control", async ({
    browser,
  }) => {
    const { screen, phone, row, preview } = await remote(browser);
    // Before any command the screen shows its first file: that row is marked.
    await expect(row("Dog.jpg")).toHaveAttribute("aria-current", "true");
    await expect(phone.page.locator("#file-list").getByRole("button", { name: startsWith("Vevox") })).toHaveCount(0);
    // A link row opens its link in a new tab here: no command, never marked as on the screen, no preview.
    const link = phone.page.locator("#file-list").getByRole("link", { name: startsWith("Vevox") });
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(link).toContainText("New Tab");
    let commands = 0;
    await phone.page.route("**/api/control", (route) => {
      commands += 1;
      return route.continue();
    });
    const tab = phone.context.waitForEvent("page");
    await link.click();
    await (await tab).close();
    await phone.page.waitForTimeout(300);
    expect(commands).toBe(0);
    await expect(link).not.toHaveAttribute("aria-current", "true");
    await expect(preview).toHaveCount(0);
    await phone.page.unroute("**/api/control");
    await row("Sample deck.pptx").click();
    // The mark moves at the tap, before the answer.
    await expect(row("Sample deck.pptx")).toHaveAttribute("aria-current", "true");
    await expect(row("Dog.jpg")).not.toHaveAttribute("aria-current", "true");
    await expect(heading(screen.page)).toHaveText("Sample deck.pptx");
    await expect(screen.page.locator(STAGED)).toHaveAttribute("alt", "Slide 1 of 2");
    await expect(preview).toHaveAttribute("aria-label", "Sample deck.pptx, Slide 1 of 2");
    await expectNoAxeViolations(phone.page);
    expect([...screen.csp, ...phone.csp]).toEqual([]);
    await close(screen, phone);
  });

  test("a screen tap marks the phone's row and its preview", async ({ browser }) => {
    const { screen, row, preview, phone, dots } = await remote(browser);
    await sidebarItem(screen.page, "Sample deck.pdf").click();
    await expect(row("Sample deck.pdf")).toHaveAttribute("aria-current", "true");
    await screen.page.locator("#next").click();
    await expect(dots).toHaveText("2 / 2");
    await expect(preview).toHaveAttribute("aria-label", "Sample deck.pdf, Page 2 of 2");
    await expect(preview.locator(".count")).toHaveText("2 / 2");
    await close(screen, phone);
  });

  test("the preview's right half steps on and its left half back; a swipe steps too", async ({ browser }) => {
    const { screen, phone, row, preview, dots } = await remote(browser);
    await row("Sample deck.pptx").click();
    await expect(heading(screen.page)).toHaveText("Sample deck.pptx");
    const box = await preview.boundingBox();
    const w = box?.width ?? 0;
    const h = box?.height ?? 0;
    await preview.click({ position: { x: w * 0.8, y: h / 2 } });
    await expect(dots).toHaveText("2 / 2");
    await preview.click({ position: { x: w * 0.2, y: h / 2 } });
    await expect(dots).toHaveText("1 / 2");
    // A swipe to the left is Next, and is not also a tap on the half it ends on.
    const x0 = (box?.x ?? 0) + w * 0.3;
    const y = (box?.y ?? 0) + h / 2;
    await preview.dispatchEvent("pointerdown", { clientX: x0 + 80, clientY: y });
    await preview.dispatchEvent("pointerup", { clientX: x0, clientY: y });
    await expect(dots).toHaveText("2 / 2");
    await preview.dispatchEvent("pointerdown", { clientX: x0, clientY: y });
    await preview.dispatchEvent("pointerup", { clientX: x0 + 80, clientY: y });
    await expect(dots).toHaveText("1 / 2");
    await close(screen, phone);
  });

  test("the bubbles above Revoke step and present, in the floating glass panel", async ({ browser }) => {
    const { screen, phone, row, bubbles, dots } = await remote(browser);
    const panel = phone.page.locator(".column > .actions.glass");
    await expect(panel.getByRole("group", { name: "The Screen" })).toBeInViewport({ ratio: 1 });
    // The bubbles sit above Revoke.
    const b = await bubbles.boundingBox();
    const r = await panel.getByRole("button", { name: "Revoke" }).boundingBox();
    expect(Math.round((b?.y ?? 0) + (b?.height ?? 0))).toBeLessThan(Math.round(r?.y ?? 0));
    // A photo has no pages: both arrows are off, Present is on.
    await expect(bubbles.getByRole("button", { name: "Previous" })).toBeDisabled();
    await expect(bubbles.getByRole("button", { name: "Next" })).toBeDisabled();
    await row("Sample deck.pptx").click();
    await expect(bubbles.getByRole("button", { name: "Previous" })).toBeDisabled();
    await bubbles.getByRole("button", { name: "Next" }).click();
    await expect(dots).toHaveText("2 / 2");
    await expect(bubbles.getByRole("button", { name: "Next" })).toBeDisabled();
    await bubbles.getByRole("button", { name: "Present" }).click();
    await expect(screen.page.locator("body")).toHaveClass(/is-presenting/);
    await expect(bubbles.getByRole("button", { name: "Stop" })).toBeVisible();
    // A new item while presenting keeps presenting.
    await row("Dog.jpg").click();
    await expect(heading(screen.page)).toHaveText("Dog.jpg");
    await expect(screen.page.locator("body")).toHaveClass(/is-presenting/);
    // Stop on the screen itself reaches the phone.
    await screen.page.keyboard.press("Escape");
    await expect(screen.page.locator("body")).not.toHaveClass(/is-presenting/);
    await expect(bubbles.getByRole("button", { name: "Present" })).toBeVisible();
    await close(screen, phone);
  });

  test("the list sits under the title; a paged item's preview sits --inset over the panel, a photo has none", async ({
    browser,
  }) => {
    const { screen, phone, row, preview } = await remote(browser);
    const page = phone.page;
    const list = page.locator("#file-list");
    const panel = page.locator(".column > .actions");
    const inset = await insetOf(page);
    // The screen shows Dog.jpg first: its row already says what the screen shows.
    await expect(row("Dog.jpg")).toHaveAttribute("aria-current", "true");
    await expect(preview).toHaveCount(0);
    const top = (await list.boundingBox())?.y;
    await row("Sample deck.pptx").click();
    await expect(preview).toBeVisible();
    const l = await list.boundingBox();
    const p = await preview.boundingBox();
    const pill = await panel.boundingBox();
    expect(l && p && l.y < p.y).toBe(true);
    expect(p && pill && Math.round(pill.y - (p.y + p.height))).toBe(inset);
    expect(l && p && Math.round(p.y - (l.y + l.height)) >= 24).toBe(true);
    // The list never moves as the preview comes and goes.
    expect(l?.y).toBe(top);
    await row("Dog.jpg").click();
    await expect(preview).toHaveCount(0);
    expect((await list.boundingBox())?.y).toBe(top);
    await close(screen, phone);
  });

  test("a long list stops over the preview with the section gap and scrolls inside itself", async ({ browser }) => {
    const { screen, phone, row, preview } = await remote(browser);
    const page = phone.page;
    const list = page.locator("#file-list");
    await row("Sample deck.pptx").click();
    await expect(preview).toBeVisible();
    // Copies of the demo's rows stand in for a long list: layout only, the next push draws the list again.
    await list.evaluate((ul) => {
      for (let i = 0; i < 3; i++) for (const li of [...ul.children]) ul.append(li.cloneNode(true));
    });
    const [scroll, client] = await list.evaluate((ul) => [ul.scrollHeight, ul.clientHeight]);
    expect(scroll ?? 0).toBeGreaterThan(client ?? 0);
    const l = await list.boundingBox();
    const p = await preview.boundingBox();
    const pill = await page.locator(".column > .actions").boundingBox();
    expect(l && p && Math.round(p.y - (l.y + l.height))).toBe(24);
    expect(p && pill && Math.round(pill.y - (p.y + p.height))).toBe(await insetOf(page));
    // At least two rows stay in view, and the page itself does not scroll.
    expect((l?.height ?? 0) >= 2 * 56).toBe(true);
    expect(await page.evaluate("document.documentElement.scrollHeight <= innerHeight")).toBe(true);
    await close(screen, phone);
  });

  test("held landscape at 844 x 390 a paged item has no preview, and Next still steps", async ({ browser }) => {
    const { screen, phone, row, preview, bubbles, dots } = await remote(browser);
    await phone.page.setViewportSize({ width: 844, height: 390 });
    await row("Sample deck.pptx").click();
    await expect(heading(screen.page)).toHaveText("Sample deck.pptx");
    await expect(preview).toHaveCount(0);
    await bubbles.getByRole("button", { name: "Next" }).click();
    await expect(dots).toHaveText("2 / 2");
    await close(screen, phone);
  });

  test("Revoke asks first: Cancel keeps the session, End Session ends it", async ({ browser }) => {
    const { screen, phone } = await remote(browser);
    const ask = phone.page.getByRole("dialog", { name: "End This Session?" });
    await phone.page.getByRole("button", { name: "Revoke" }).click();
    await expect(ask).toBeVisible();
    // The title and its two buttons, on the phone's glass.
    await expect(ask.locator("p")).toHaveCount(0);
    await expect(ask).toHaveClass(/\bglass\b/);
    // Opened by a tap, the focus it moves to Cancel draws no ring; opened by a key, it does (WCAG 2.4.7).
    const cancel = ask.getByRole("button", { name: "Cancel" });
    await expect(cancel).toBeFocused();
    await expect(cancel).toHaveCSS("outline-style", "none");
    // A modal <dialog>, not a popover: Safari before 17 has no Popover API.
    expect(await ask.evaluate((n) => n.matches("dialog:modal"))).toBe(true);
    await expectNoAxeViolations(phone.page);
    await phone.page.keyboard.press("Escape");
    await expect(ask).toBeHidden();
    await phone.page.getByRole("button", { name: "Revoke" }).click();
    await ask.getByRole("button", { name: "Cancel" }).click();
    await expect(ask).toBeHidden();
    await phone.page.getByRole("button", { name: "Revoke" }).focus();
    await phone.page.keyboard.press("Enter");
    await expect(cancel).toBeFocused();
    await expect(cancel).not.toHaveCSS("outline-style", "none");
    await phone.page.keyboard.press("Escape");
    await expect(ask).toBeHidden();
    await expect(heading(phone.page)).toHaveText("Approved for Demo Room");
    await expect(heading(screen.page)).toHaveText("Dog.jpg");
    // The screen's End while the question is open: it goes with Revoke, never floating over Session Ended.
    await phone.page.getByRole("button", { name: "Revoke" }).click();
    await expect(ask).toBeVisible();
    await screen.page.getByRole("button", { name: "End", exact: true }).click();
    await expect(heading(phone.page)).toHaveText("Session Ended");
    await expect(ask).toBeHidden();
    await expect(phone.page.locator(".preview")).toHaveCount(0);
    await expect(phone.page.getByRole("group", { name: "The Screen" })).toHaveCount(0);
    await close(screen, phone);
  });

  test("PAIR-13 stale seq: the answer is the current view, which the phone adopts with no toast", async ({
    browser,
  }) => {
    const { screen, phone, row } = await remote(browser);
    await row("Sample deck.pptx").click();
    await expect(heading(screen.page)).toHaveText("Sample deck.pptx");
    // The next command goes out with a seq below the last applied one: the server changes nothing.
    await phone.page.route("**/api/control", (route) =>
      route.continue({ postData: JSON.stringify({ ...route.request().postDataJSON(), seq: 1 }) }),
    );
    const answered = phone.page.waitForResponse("**/api/control");
    await row("Sample deck.pdf").click();
    await answered;
    await expect(row("Sample deck.pptx")).toHaveAttribute("aria-current", "true");
    await expect(row("Sample deck.pdf")).not.toHaveAttribute("aria-current", "true");
    await expect(heading(screen.page)).toHaveText("Sample deck.pptx");
    await phone.page.waitForTimeout(300);
    await expectNoToast(phone.page);
    await close(screen, phone);
  });

  test("a push that leaves the list as it was keeps the rows, and the focus on the one that has it", async ({
    browser,
  }) => {
    const { screen, row } = await remote(browser);
    const kept = row("Sample deck.pptx");
    await kept.focus();
    await kept.evaluate((n) => n.setAttribute("data-kept", "1"));
    // A tap on the screen pushes a new view with the same items.
    await sidebarItem(screen.page, "Sample deck.pdf").click();
    await expect(row("Sample deck.pdf")).toHaveAttribute("aria-current", "true");
    await expect(kept).toHaveAttribute("data-kept", "1");
    await expect(kept).toBeFocused();
  });

  test("PAIR-13 reload: a phone reloaded mid-session still moves the screen with its next tap", async ({ browser }) => {
    const { screen, phone, row } = await remote(browser);
    await row("Sample deck.pptx").click();
    await expect(heading(screen.page)).toHaveText("Sample deck.pptx");
    await phone.page.reload();
    await expect(row("Sample deck.pptx")).toHaveAttribute("aria-current", "true");
    await row("Sample deck.pdf").click();
    await expect(heading(screen.page)).toHaveText("Sample deck.pdf");
    await expect(row("Sample deck.pdf")).toHaveAttribute("aria-current", "true");
    await close(screen, phone);
  });

  test("a vertical drag over the preview is no tap, a tap still is", async ({ browser }) => {
    const { screen, phone, row, preview, dots } = await remote(browser);
    await row("Sample deck.pptx").click();
    await expect(dots).toHaveText("1 / 2");
    const box = await preview.boundingBox();
    const x = (box?.x ?? 0) + (box?.width ?? 0) * 0.8;
    const y = (box?.y ?? 0) + (box?.height ?? 0) * 0.25;
    await phone.page.mouse.move(x, y);
    await phone.page.mouse.down();
    await phone.page.mouse.move(x, y + 30, { steps: 4 });
    await phone.page.mouse.up();
    await phone.page.waitForTimeout(400);
    await expect(dots).toHaveText("1 / 2");
    await preview.click({ position: { x: (box?.width ?? 0) * 0.8, y: (box?.height ?? 0) * 0.5 } });
    await expect(dots).toHaveText("2 / 2");
    await close(screen, phone);
  });

  test("a command that never answers times out into the offline toast, and the mark goes back", async ({ browser }) => {
    const { screen, phone, row } = await remote(browser);
    await phone.page.route("**/api/control", () => {});
    await row("Sample deck.pptx").click();
    await expect(row("Sample deck.pptx")).toHaveAttribute("aria-current", "true");
    await expect(phone.page.getByRole("alert")).toContainText("Check the connection, then try again.", {
      timeout: 20_000,
    });
    await expect(row("Dog.jpg")).toHaveAttribute("aria-current", "true");
    await close(screen, phone);
  });

  test("a remote that failed to load says so with a Reload action, which brings it back", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    let asked = 0;
    await phone.context.route("**/core/remote-ui.js*", (route) => (asked++ === 0 ? route.abort() : route.continue()));
    await phone.page.reload();
    const alert = phone.page.getByRole("alert");
    // Before the approval there is no remote to miss.
    await expect.poll(() => asked).toBe(1);
    await phone.page.waitForTimeout(300);
    await expectNoToast(phone.page);
    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expect(alert).toContainText("Remote Didn't Load");
    // Not fetched again by itself, and the toast waits for a tap.
    await phone.page.waitForTimeout(500);
    expect(asked).toBe(1);
    await alert.getByRole("button", { name: "Reload" }).click();
    await expect(phone.page.getByRole("group", { name: "The Screen" })).toBeVisible();
    expect(asked).toBe(2);
    // Gone on the tap: a wait for its leaving, not a claim that none came.
    await expect(phone.page.getByRole("alert")).toBeHidden();
    await close(screen, phone);
  });

  test("presenting holds while the next photo is still on its way, with no new full screen", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const { phone } = await scan(browser, screen.page);
    let release = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    // The photo's bytes wait until the test lets them go.
    await screen.page.route("**/f/**", async (route) => {
      await held;
      await route.continue();
    });
    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expect(phone.page.getByRole("group", { name: "The Screen" })).toBeVisible();
    await expect(screen.page.locator("#items > li .item")).toHaveCount(CATALOG.length);
    await screen.page.evaluate(
      "(() => { window.exits = 0; const exit = document.exitFullscreen?.bind(document); document.exitFullscreen = (...a) => { window.exits += 1; return exit?.(...a); }; })()",
    );
    const row = (name: string) => phone.page.locator("#file-list").getByRole("button", { name: startsWith(name) });
    await row("Sample deck.pptx").click();
    await expect(heading(screen.page)).toHaveText("Sample deck.pptx");
    await phone.page
      .getByRole("group", { name: "The Screen" })
      .getByRole("button", { name: "Present", exact: true })
      .click();
    const body = screen.page.locator("body");
    await expect(body).toHaveClass(/is-presenting/);
    await row("Dog.jpg").click();
    await expect(heading(screen.page)).toHaveText("Dog.jpg");
    await expect(screen.page.locator("#frame .loader")).toBeVisible();
    await screen.page.waitForTimeout(400);
    await expect(body).toHaveClass(/is-presenting/);
    expect(await screen.page.evaluate("window.exits")).toBe(0);
    release();
    await expect(screen.page.getByRole("img", { name: "Dog.jpg" })).toBeVisible();
    await expect(body).toHaveClass(/is-presenting/);
    expect(await screen.page.evaluate("window.exits")).toBe(0);
    await close(screen, phone);
  });

  test("a scrolling document goes to the page the phone asks for, and a scroll here is reported back", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    await screen.page.route("**/img/demo-slide-*", (route) =>
      route.fulfill({ contentType: "image/png", body: png(600, 900) }),
    );
    const { phone } = await scan(browser, screen.page);
    await phone.page.getByRole("button", { name: "Approve" }).click();
    await expectViewer(screen.page);
    await phone.page
      .locator("#file-list")
      .getByRole("button", { name: startsWith("Sample deck.pdf") })
      .click();
    const frame = screen.page.locator("#frame");
    await expect(frame).toHaveClass(/is-scroll/);
    const bubbles = phone.page.getByRole("group", { name: "The Screen" });
    await bubbles.getByRole("button", { name: "Next" }).click();
    await expect(screen.page.locator('#frame [data-page="1"]')).toBeInViewport({ ratio: 0.5 });
    // Scrolling back here is a step: the phone's preview follows.
    await frame.evaluate((n) => n.scrollTo(0, 0));
    await expect(phone.page.locator(".preview .count")).toHaveText("1 / 2");
    await close(screen, phone);
  });

  test("offline or rate limited: a toast, and the mark goes back to what the screen shows", async ({ browser }) => {
    const { screen, phone, row } = await remote(browser);
    await phone.page.route("**/api/control", (route) =>
      route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ code: "rate_limited" }) }),
    );
    await row("Sample deck.pptx").click();
    await expect(phone.page.getByRole("alert")).toContainText("The Screen Didn't Change");
    await expect(phone.page.getByRole("alert")).toContainText("Wait a minute, then try again.");
    await expect(row("Dog.jpg")).toHaveAttribute("aria-current", "true");
    await expect(heading(screen.page)).toHaveText("Dog.jpg");
    await phone.page.unroute("**/api/control");
    await phone.page.route("**/api/control", (route) => route.abort());
    await row("Sample deck.pdf").click();
    await expect(phone.page.getByRole("alert")).toContainText("Check the connection, then try again.");
    await expect(row("Dog.jpg")).toHaveAttribute("aria-current", "true");
    await expect(heading(phone.page)).toHaveText("Approved for Demo Room");
    await close(screen, phone);
  });
});

test.describe("the phone page at phone widths (design.md section 7, Phone page)", () => {
  /** A sid or pid (`<22-char ref>.<43-char secret>`) or a pairing code: none may ride in the support mail. */
  const CREDENTIALS = [/[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/, /\b[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6,7}\b/];
  const toast = (page: Page) => page.locator(".toast:not(.out)");

  /**
   * What a phone width breaks: a layout wider than the screen (a zoomed-out page), a part past its edge, a target
   * under 44 px. A string, so the node tsconfig needs no DOM types.
   */
  const measure = (page: Page) =>
    page.evaluate(`(() => {
      const vw = document.documentElement.clientWidth;
      const seen = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden" && !el.closest(".sr, .skip");
      };
      const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + "." + String(el.className).trim().split(/\\s+/).join(".");
      const past = [...document.querySelectorAll("body *")].filter((el) => {
        const r = el.getBoundingClientRect();
        return seen(el) && (r.right > vw + 0.5 || r.left < -0.5);
      });
      const small = [...document.querySelectorAll("button, a[href], [role=button]")].filter((el) => {
        const r = el.getBoundingClientRect();
        return seen(el) && (r.height < 43.5 || r.width < 43.5);
      });
      return { inner: innerWidth, scroll: document.documentElement.scrollWidth, past: past.map(name), small: small.map(name) };
    })()`) as Promise<{ inner: number; scroll: number; past: string[]; small: string[] }>;

  async function guard(page: Page, width: number, label: string) {
    const m = await measure(page);
    expect(m, label).toEqual({ inner: width, scroll: width, past: [], small: [] });
  }

  /** Scrolled to its end (the page, and the list where it scrolls inside itself), the last row clears the panel. */
  async function lastRowClear(page: Page, label: string) {
    await page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)");
    await page.locator("#file-list").evaluate((ul) => {
      ul.scrollTop = ul.scrollHeight;
    });
    const row = await page.locator("#file-list > li").last().boundingBox();
    const panel = await page.locator(".column > .actions").boundingBox();
    expect(row && panel && row.y + row.height <= panel.y, label).toBe(true);
  }

  for (const width of [320, 360, 390]) {
    test(`at ${width} wide every /a state fits: approve, a long offer, approved with the remote, a toast over the panel`, async ({
      browser,
    }) => {
      const screen = await demoScreen(browser);
      const code = await typedCodeOf(screen.page);
      const context = await browser.newContext({
        viewport: { width, height: 568 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      await page.goto(`/a?c=${code}`);
      await expect(page.getByRole("button", { name: /^Approve/ })).toBeEnabled();
      await guard(page, width, "approve");
      await lastRowClear(page, "approve");

      await addFile(page, {
        name: "Week 7 lecture recording final cut.png",
        mimeType: "image/png",
        buffer: png(300, 200),
      });
      await expect(heading(page)).toHaveText("Send Week 7 lecture reco… cut.png to Demo Room?");
      await guard(page, width, "offer");
      await page.getByRole("button", { name: "Cancel" }).click();

      await page.getByRole("button", { name: /^Approve/ }).click();
      await expect(heading(page)).toHaveText("Approved for Demo Room");
      await expect(page.getByRole("group", { name: "The Screen" })).toBeVisible();
      await expect(page.locator("#ends")).toHaveCSS("min-height", "44px");
      await guard(page, width, "approved");
      await lastRowClear(page, "approved");

      // A toast sits just above the panel, never over the list.
      await page.route("**/api/session/length", (route) => route.abort());
      await page.locator("#ends").click();
      await page.getByRole("dialog", { name: "Session Expiry" }).getByRole("button", { name: "30 minutes" }).click();
      await expect(toast(page)).toContainText("The Session Expiry Didn't Change");
      await expect(toast(page)).toHaveCSS("opacity", "1");
      const t = await toast(page).boundingBox();
      const panel = await page.locator(".column > .actions").boundingBox();
      expect(t && panel && Math.round(panel.y - (t.y + t.height))).toBe(8);
      await guard(page, width, "toast");
      await context.close();
      await screen.context.close();
    });
  }

  /** /a on a claim the server fails (`internal`): service down. */
  async function downPhone(browser: Browser, code: string, supportLoads = true) {
    const context = await browser.newContext({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true });
    await context.route("**/api/claim", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"internal"}' }),
    );
    if (!supportLoads) await context.route("**/js/shared/support.js", (route) => route.abort());
    const page = await context.newPage();
    await page.goto(`/a?c=${code}`);
    await expect(heading(page)).toHaveText("bloop Isn't Responding");
    const mail = page.getByRole("link", { name: "Email bloop" });
    // Unloadable, the facts are asked for again on the way to the link.
    if (!supportLoads) await mail.focus();
    return { context, page, mail };
  }

  test("held landscape at 844 x 390, the approve list's end and Add a File clear the floating panel", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const code = await typedCodeOf(screen.page);
    const context = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    await page.goto(`/a?c=${code}`);
    await expect(page.getByRole("button", { name: /^Approve/ })).toBeEnabled();
    await lastRowClear(page, "approve, landscape");
    await guard(page, 844, "approve, landscape");
    await context.close();
    await screen.context.close();
  });

  test("service down offers a prefilled support mail with no credential in it", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const code = await typedCodeOf(screen.page);
    const { context, page, mail } = await downPhone(browser, code);
    await expect(page.locator("#body")).toHaveText("Something's wrong on bloop's side.");
    // The facts fill the link as it shows, with no tap or focus on it.
    await expect(mail).toHaveAttribute("href", /^mailto:hi@bloop\.here\?subject=bloop%20isn't%20responding&body=/);
    const href = (await mail.getAttribute("href")) ?? "";
    const body = new URL(href).searchParams.get("body") ?? "";
    expect(body).toContain("Page: /a\nState: service_down\nError: internal\nTime: ");
    for (const pattern of CREDENTIALS) expect(body, String(pattern)).not.toMatch(pattern);
    expect(body).not.toContain(code);
    await expect(page.getByRole("button", { name: "Try Again" })).toBeVisible();
    await guard(page, 320, "service down");
    await context.close();
    await screen.context.close();
  });

  test("service down's mail stays the plain one when its facts cannot load", async ({ browser }) => {
    const screen = await demoScreen(browser);
    const { context, page, mail } = await downPhone(browser, await typedCodeOf(screen.page), false);
    await page.waitForTimeout(500);
    await expect(mail).toHaveAttribute("href", "mailto:hi@bloop.here?subject=bloop%20isn't%20responding");
    await context.close();
    await screen.context.close();
  });

  test("a Remote Didn't Load toast that another toast took the place of comes back with the next view; tapped away, it stays away", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const code = await typedCodeOf(screen.page);
    const phone = await open(browser, "phone", `/a?c=${code}`, (c) =>
      c.route("**/js/core/remote-ui.js", (route) => route.abort()),
    );
    await phone.page.getByRole("button", { name: /^Approve/ }).click();
    await expectViewer(screen.page);
    await expect(toast(phone.page)).toContainText("Remote Didn't Load");
    // Views while it shows leave it as it is.
    await expect(toast(phone.page)).toContainText("Remote Didn't Load");
    await phone.page.route("**/api/session/length", (route) => route.abort());
    await phone.page.locator("#ends").click();
    await phone.page
      .getByRole("dialog", { name: "Session Expiry" })
      .getByRole("button", { name: "30 minutes" })
      .click();
    await expect(toast(phone.page)).toContainText("The Session Expiry Didn't Change");
    // The screen's own tap is the next view the phone gets.
    await sidebarItem(screen.page, "Sample deck.pdf").click();
    await expect(toast(phone.page)).toContainText("Remote Didn't Load");
    await expect(toast(phone.page).getByRole("button", { name: "Reload" })).toBeVisible();
    // Tapped away, the views after it leave it away.
    await toast(phone.page).locator("strong").click();
    await expect(toast(phone.page)).toBeHidden();
    await sidebarItem(screen.page, "Dog.jpg").click();
    await phone.page.waitForTimeout(1500);
    await expect(toast(phone.page)).toBeHidden();
    await screen.context.close();
    await phone.context.close();
  });

  test("a Remote Didn't Load toast shows only where the remote would: not on the ended page that follows", async ({
    browser,
  }) => {
    const screen = await demoScreen(browser);
    const code = await typedCodeOf(screen.page);
    const phone = await open(browser, "phone", `/a?c=${code}`, (c) =>
      c.route("**/js/core/remote-ui.js", (route) => route.abort()),
    );
    await phone.page.getByRole("button", { name: /^Approve/ }).click();
    await expect(toast(phone.page)).toContainText("Remote Didn't Load");
    await toast(phone.page).locator("strong").click();
    await expect(toast(phone.page)).toBeHidden();
    await revoke(phone.page);
    await expect(heading(phone.page)).toHaveText("Session Ended");
    await phone.page.waitForTimeout(500);
    await expectNoToast(phone.page);
    await screen.context.close();
    await phone.context.close();
  });
});
