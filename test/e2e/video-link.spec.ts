// The catalog's video link (PREVIEW-01): a link card with its same-origin thumbnail and its long title, on the phone list
// and the screen's sidebar at three widths, and the thumbnail route itself. Runs in CI only (headless Chrome cannot start
// in the local sandbox). The Worker's upstream is a local stand-in for i.ytimg.com (playwright.config.ts starts
// test/yt-upstream.ts and gives its origin as YT_THUMB_ORIGIN): no test reaches the real network. The fixture is a
// real JPEG, so `naturalWidth` proves the picture decoded.
import { type Browser, type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import { DEMO_ITEMS, DEMO_VIDEO_ID } from "../../src/shared/demo-catalog.ts";

const WIDTHS = [320, 390, 1440] as const;
const WATCH = `https://www.youtube.com/watch?v=${DEMO_VIDEO_ID}`;
const THUMB = `/yt/${DEMO_VIDEO_ID}.jpg`;
/** Under this width the screen's list is a bottom sheet behind the handle (app.css). */
const SHEET_BELOW = 760;

const heading = (page: Page) => page.getByRole("heading", { level: 1 });

async function openPage(browser: Browser, width: number, kind: "screen" | "phone", path: string, prep?: PrepFn) {
  const context = await browser.newContext(
    kind === "screen"
      ? { viewport: { width, height: 900 } }
      : { viewport: { width, height: 844 }, hasTouch: true, isMobile: width < SHEET_BELOW },
  );
  await prep?.(context);
  const page = await context.newPage();
  await page.goto(path);
  return { context, page };
}
type PrepFn = (context: BrowserContext) => Promise<unknown>;

/** A demo screen and a phone paired to it, both `width` wide, the phone on its list before Approve. */
async function paired(browser: Browser, width: number, phonePrep?: PrepFn) {
  const screen = await openPage(browser, width, "screen", "/s?mode=demo");
  await expect(screen.page.locator("#typed-code")).toHaveText(/^[A-Z0-9]{3} [A-Z0-9]{3}$/);
  const code = ((await screen.page.locator("#typed-code").textContent()) ?? "").replace(/\s/g, "");
  const phone = await openPage(browser, width, "phone", `/a?c=${code}`, phonePrep);
  await expect(phone.page.getByRole("button", { name: "Approve" })).toBeEnabled();
  return { screen, phone };
}

/** The video's row in a list: a row whose name is the video's title. */
const videoRow = (list: Locator) => list.locator(".row, .item").filter({ hasText: DEMO_ITEMS.video.name });

/**
 * A long title keeps its row whole: one line with an ellipsis, the thumbnail and the arrow inside the row, the
 * text clear of the arrow, and no horizontal overflow of the row, its list or the page.
 */
async function expectWholeRow(row: Locator, trailing: Locator) {
  await expect(row).toBeVisible();
  await expect(row.locator(".row-name")).toHaveText(DEMO_ITEMS.video.name);
  await expect(trailing).toBeVisible();

  // Typed callback, serialized into the page: a string function expression is not called by evaluate, and the test
  // project has no DOM types.
  const geometry = await row.evaluate((el) => {
    interface Node_ {
      getBoundingClientRect(): { left: number; right: number; top: number; bottom: number; height: number };
      querySelector(selector: string): Node_ | null;
      closest(selector: string): { scrollWidth: number; clientWidth: number } | null;
      scrollWidth: number;
      clientWidth: number;
    }
    const page = globalThis as unknown as {
      document: { documentElement: { scrollWidth: number; clientWidth: number } };
      getComputedStyle(node: Node_): { lineHeight: string };
    };
    const box = el as unknown as Node_;
    const rect = (node: Node_ | null) => {
      const r = node?.getBoundingClientRect();
      return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height } : null;
    };
    const name = box.querySelector(".row-name");
    const list = box.closest("ul");
    return {
      row: rect(box),
      text: rect(box.querySelector(".row-text")),
      name: rect(name),
      thumb: rect(box.querySelector(".thumb")),
      lineHeight: name ? Number.parseFloat(page.getComputedStyle(name).lineHeight) : 0,
      scrollWidth: box.scrollWidth,
      clientWidth: box.clientWidth,
      listScroll: list ? list.scrollWidth : 0,
      listClient: list ? list.clientWidth : 0,
      pageScroll: page.document.documentElement.scrollWidth,
      pageClient: page.document.documentElement.clientWidth,
    };
  });
  const icon = await trailing.boundingBox();
  if (!geometry.row || !geometry.text || !geometry.name || !geometry.thumb || !icon)
    throw new Error("a part has no box");
  const { row: box, text, name, thumb } = geometry;

  // Nothing overflows sideways: the row, its list and the page.
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.listScroll).toBeLessThanOrEqual(geometry.listClient);
  expect(geometry.pageScroll).toBeLessThanOrEqual(geometry.pageClient);
  // The title clamps to one whole line.
  expect(name.height).toBeLessThanOrEqual(geometry.lineHeight + 1);
  expect(name.height).toBeGreaterThanOrEqual(geometry.lineHeight - 1);
  // A row of two text lines: the name's one line and the small line over its padding, never a tall slab.
  expect(box.height).toBeLessThanOrEqual(geometry.lineHeight + 80);
  // The thumbnail, the text and the trailing icon sit inside the row, in order, with the text clear of the icon.
  for (const part of [thumb, text]) {
    expect(part.left).toBeGreaterThanOrEqual(box.left - 1);
    expect(part.right).toBeLessThanOrEqual(box.right + 1);
    expect(part.top).toBeGreaterThanOrEqual(box.top - 1);
    expect(part.bottom).toBeLessThanOrEqual(box.bottom + 1);
  }
  expect(icon.x).toBeGreaterThanOrEqual(box.left - 1);
  expect(icon.x + icon.width).toBeLessThanOrEqual(box.right + 1);
  expect(icon.y).toBeGreaterThanOrEqual(box.top - 1);
  expect(icon.y + icon.height).toBeLessThanOrEqual(box.bottom + 1);
  expect(thumb.right).toBeLessThanOrEqual(text.left + 1);
  expect(text.right).toBeLessThanOrEqual(icon.x + 1);
}

/** The row's picture: the one same-origin thumbnail, decoded. */
async function expectThumbnail(row: Locator) {
  const picture = row.locator("img.thumb");
  await expect(picture).toHaveCount(1);
  await expect(picture).toHaveAttribute("src", THUMB);
  await expect
    .poll(() =>
      picture.evaluate((img) => {
        const loaded = img as unknown as { complete: boolean; naturalWidth: number };
        return loaded.complete ? loaded.naturalWidth : 0;
      }),
    )
    .toBeGreaterThan(0);
}

/** The screen's list: a left rail from 760 wide, a bottom sheet behind the handle below it. */
async function openSidebar(page: Page, width: number) {
  if (width < SHEET_BELOW) {
    await page.locator("#handle").click();
    await expect(page.locator("#side")).toBeVisible();
  }
  await expect(page.locator("#items")).toBeVisible();
}

for (const width of WIDTHS) {
  test.describe(`the video link at ${width} wide`, () => {
    test(`PREVIEW-01 row: on the phone list and the screen sidebar, its thumbnail loaded and its long title kept whole (${width})`, async ({
      browser,
    }) => {
      const { screen, phone } = await paired(browser, width);

      // The phone's list before Approve: a ticked row with the thumbnail, the title and the tick.
      const pick = videoRow(phone.page.locator("#file-list"));
      await expect(pick).toHaveCount(1);
      await expectThumbnail(pick);
      await expectWholeRow(pick, pick.locator(".tick"));
      await expect(pick.locator(".small")).toContainText("youtube.com");

      await phone.page.getByRole("button", { name: "Approve" }).click();
      await expect(heading(screen.page)).toHaveText(DEMO_ITEMS.deck.name);

      // The screen's sidebar: a link that opens a new tab, with the same picture and title.
      await openSidebar(screen.page, width);
      const side = videoRow(screen.page.locator("#items"));
      await expect(side).toHaveCount(1);
      await expect(side).toHaveAttribute("href", WATCH);
      await expect(side).toHaveAttribute("target", "_blank");
      await expect(side).toHaveAttribute("rel", "noopener noreferrer");
      await expectThumbnail(side);
      await expectWholeRow(side, side.locator(".icon").last());
      // A link card, never a frame: nothing is embedded and the stage keeps the deck.
      await expect(screen.page.locator("iframe")).toHaveCount(0);
      await expect(heading(screen.page)).toHaveText(DEMO_ITEMS.deck.name);

      // The phone's approved list: the same row as a link.
      const approved = videoRow(phone.page.locator("#file-list"));
      await expect(approved).toHaveAttribute("href", WATCH);
      await expectThumbnail(approved);
      await expectWholeRow(approved, approved.locator(".icon").last());

      // The row is as tall as one of its neighbors' two-line names allows: no other row is pushed out of its list.
      const heights = await screen.page.locator("#items .item").evaluateAll((els) => els.map((e) => e.clientHeight));
      expect(Math.max(...heights)).toBeLessThan(160);

      await screen.context.close();
      await phone.context.close();
    });
  });
}

test("PREVIEW-01 fallback: a thumbnail that does not load gives way to the link glyph tile on both lists", async ({
  browser,
}) => {
  const { screen, phone } = await paired(browser, 390, (context) => context.route("**/yt/*.jpg", (r) => r.abort()));
  const pick = videoRow(phone.page.locator("#file-list"));
  await expect(pick).toHaveCount(1);
  await expect(pick.locator("img")).toHaveCount(0);
  await expect(pick.locator("span.thumb svg")).toBeVisible();
  await expect(pick.locator(".row-name")).toHaveText(DEMO_ITEMS.video.name);
  await screen.context.close();
  await phone.context.close();
});

test("PREVIEW-01 route: the catalog's own id is a JPEG under nosniff; any other id is a 404 with nothing cached", async ({
  request,
}) => {
  const ok = await request.get(THUMB);
  expect(ok.status()).toBe(200);
  expect(ok.headers()["content-type"]).toBe("image/jpeg");
  expect(ok.headers()["x-content-type-options"]).toBe("nosniff");
  expect(ok.headers()["cache-control"]).toBe("public, max-age=86400");
  expect([...(await ok.body()).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);

  for (const path of [
    "/yt/ZZZZZZZZZZZ.jpg",
    "/yt/short.jpg",
    `/yt/${DEMO_VIDEO_ID}.png`,
    `/yt/${DEMO_VIDEO_ID}.jpg/`,
  ]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(404);
    expect(res.headers()["cache-control"], path).toBe("no-store");
  }
});
