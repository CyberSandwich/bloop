// The viewer's pill on a wide screen while items change fast (design.md section 7, Control pill): centered on the item
// by construction (app.css: left 50% and translate -50%, never a measured left), on every frame of a change and at rest,
// and every button takes the click where it is drawn, Present included, whatever slide images the cache holds. CI only.
import { type Browser, expect, type Page, test } from "@playwright/test";
import { DEMO_ITEMS } from "../../src/shared/demo-catalog.ts";
import { heading } from "./pairing.ts";

const WIDE = { width: 2000, height: 1218 };
const { deck, horizontal, vertical } = DEMO_ITEMS;

type Look = { stacked: boolean; glide: boolean; pill: number; item: number; misses: string[] };

/**
 * One frame's read, in one evaluate: the pill's and the item's centers, and each shown button that the point at its
 * drawn center does not hit. The pill's box is read here and in flow.spec.ts's settledPill only (e2e-rules.test.ts).
 */
const LOOK = `(() => {
  const pill = document.getElementById("controls");
  const item = document.querySelector("#frame :is(picture:not([inert]) img, canvas:not([inert]), video:not([inert]), .stand-in:not([inert]))");
  if (!pill || !item) return null;
  const mid = (r) => r.x + r.width / 2;
  const misses = [...pill.querySelectorAll("button:not([hidden])")].filter((b) => {
    const r = b.getBoundingClientRect();
    return document.elementFromPoint(mid(r), r.y + r.height / 2)?.closest("button") !== b;
  }).map((b) => b.id);
  return {
    stacked: !!pill.closest(".is-stacked"),
    glide: pill.getAnimations().length > 0,
    pill: mid(pill.getBoundingClientRect()),
    item: mid(item.getBoundingClientRect()),
    misses,
  };
})()`;

/** Samples LOOK every frame until the returned stop. */
async function sample(page: Page): Promise<() => Promise<(Look | null)[]>> {
  await page.evaluate(`(() => {
    window.looks = [];
    const tick = () => { window.looks.push(${LOOK}); window.looking = requestAnimationFrame(tick); };
    tick();
  })()`);
  return async () =>
    (await page.evaluate(
      "(() => { cancelAnimationFrame(window.looking); return window.looks; })()",
    )) as (Look | null)[];
}

/** Every frame where the pill is a row at rest in its place: centered on the item, each button hit where drawn. */
function expectCentered(looks: (Look | null)[], what: string) {
  const row = looks.filter((l): l is Look => !!l && !l.stacked && !l.glide);
  expect(row.length, `${what}: frames with the pill as a row`).toBeGreaterThan(0);
  expect(
    row.filter((l) => Math.round(l.pill - l.item) !== 0),
    `${what}: off center`,
  ).toEqual([]);
  expect(
    looks.filter((l) => l?.misses.length),
    `${what}: a button not under its paint`,
  ).toEqual([]);
}

/** Once nothing finite animates in the pill (settledPill's rule): centered, and each button hit where drawn. */
async function expectSettled(page: Page, what: string) {
  const read = `(() => {
    const pill = document.getElementById("controls");
    if (pill.getAnimations({ subtree: true }).some((a) => a.effect?.getComputedTiming().endTime !== Infinity)) return null;
    return ${LOOK};
  })()`;
  await expect.poll(() => page.evaluate(read), { message: `${what}: the pill settles` }).not.toBeNull();
  expectCentered([(await page.evaluate(read)) as Look], what);
}

/** The wide screen, the demo approved on this device, the deck on the stage. */
async function wide(browser: Browser, slides16x10 = false) {
  const context = await browser.newContext({ viewport: WIDE });
  // The shape the slides had before the owner's deck (1920 x 1200), as a cache holding them would serve.
  if (slides16x10)
    await context.route(/\/img\/demo-slide-\d+\.(avif|webp)$/, (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1200"><rect width="1920" height="1200" fill="#1565c0"/></svg>',
      }),
    );
  const page = await context.newPage();
  const downloads: string[] = [];
  page.on("download", (d) => downloads.push(d.suggestedFilename()));
  await page.goto("/s?mode=demo");
  await page.getByRole("link", { name: /^Approve on This/ }).click();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(heading(page)).toHaveText(deck.name);
  await expect(page.getByRole("button", { name: "Download", exact: true })).toBeVisible();
  return { context, page, downloads };
}

const row = (page: Page, name: string) =>
  page.locator("#items").getByRole("button", { name: new RegExp(`^${name.replace(".", "\\.")}`) });

/** Deck, photo, the other photo, deck: each change inside the last one's 200 ms fade. */
async function rapid(page: Page) {
  for (const name of [horizontal.name, vertical.name, horizontal.name, deck.name]) await row(page, name).click();
  await expect(heading(page)).toHaveText(deck.name);
}

/** A real click on Present presents, and nothing downloads; Escape stops. */
async function expectPresentPresents(page: Page, downloads: string[]) {
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator("body")).toHaveClass(/is-presenting/);
  await page.keyboard.press("Escape");
  await expect(page.locator("body")).not.toHaveClass(/is-presenting/);
  expect(downloads, "Present downloaded").toEqual([]);
}

test.describe("the pill on a wide screen while items change fast", () => {
  test("stays centered on the item on every frame and at rest, and Present presents", async ({ browser }) => {
    const { context, page, downloads } = await wide(browser);
    await expectSettled(page, "the deck");
    const stop = await sample(page);
    await rapid(page);
    await expectSettled(page, "after the fast changes");
    expectCentered(await stop(), "during the fast changes");
    await expectPresentPresents(page, downloads);
    await context.close();
  });

  test("a photo still loading, changed away from and back: centered throughout, and Present presents", async ({
    browser,
  }) => {
    const { context, page, downloads } = await wide(browser);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 40,
      downloadThroughput: 60 * 1024,
      uploadThroughput: -1,
    });
    const stop = await sample(page);
    await row(page, horizontal.name).click();
    await expect(page.locator("#frame .loader.stand-in")).toBeVisible();
    await row(page, deck.name).click();
    await row(page, horizontal.name).click();
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await expect(page.getByRole("img", { name: horizontal.name })).toBeVisible({ timeout: 15_000 });
    await expectSettled(page, "the photo landed");
    await row(page, deck.name).click();
    await expect(heading(page)).toHaveText(deck.name);
    await expectSettled(page, "back on the deck");
    expectCentered(await stop(), "around the slow photo");
    await expectPresentPresents(page, downloads);
    await context.close();
  });

  test("slides of the old 16 : 10 shape from a cache: centered on every frame, and Present presents", async ({
    browser,
  }) => {
    const { context, page, downloads } = await wide(browser, true);
    await expectSettled(page, "the old-shape deck");
    const stop = await sample(page);
    await rapid(page);
    await expectSettled(page, "after the fast changes");
    expectCentered(await stop(), "during the fast changes");
    await expectPresentPresents(page, downloads);
    await context.close();
  });
});
