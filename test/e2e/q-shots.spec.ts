// Temporary: screenshots for the queued client fixes (never merge). Writes test-results/shots/<tag>-*.png.
import { type Browser, expect, type Page, test } from "@playwright/test";

const TAG = "after";
const SIZES = [
  ["320", { width: 320, height: 640 }],
  ["390", { width: 390, height: 844 }],
  ["430", { width: 430, height: 932 }],
  ["844x390", { width: 844, height: 390 }],
  ["834", { width: 834, height: 1112 }],
  ["1440", { width: 1440, height: 900 }],
] as const;

async function pair(browser: Browser, path: string) {
  const sctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const screen = await sctx.newPage();
  await screen.goto(path);
  await expect(screen.locator("#qr-panel")).not.toHaveClass(/\bis-swapping\b/);
  await expect(screen.locator("#typed-code")).toHaveText(/^[A-Z0-9]{3} [A-Z0-9]{3}$/);
  const code = ((await screen.locator("#typed-code").textContent()) ?? "").replace(/\s/g, "");
  const pctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  const phone = await pctx.newPage();
  await phone.goto(`/a?c=${code}`);
  await expect(phone.getByRole("button", { name: "Approve" })).toBeEnabled();
  return { screen, phone };
}

async function shoot(page: Page, name: string, after?: () => Promise<void>) {
  for (const [size, viewport] of SIZES) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(450);
    await after?.();
    await page.waitForTimeout(250);
    await page.screenshot({ path: `test-results/shots/${TAG}-${name}-${size}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("SHOTS Approve with nothing ticked (demo phone)", async ({ browser }) => {
  const { screen, phone } = await pair(browser, "/s?mode=demo");
  await shoot(phone, "phone-all-ticked");
  const boxes = phone.locator("#file-list input[type=checkbox]");
  const n = await boxes.count();
  for (let i = 0; i < n; i += 1) await boxes.nth(i).uncheck();
  await shoot(phone, "phone-none-ticked");
  await screen.context().close();
  await phone.context().close();
});

test("SHOTS the opening and fallback states on a live screen", async ({ browser }) => {
  const { screen, phone } = await pair(browser, "/s");
  await phone.getByRole("button", { name: "Approve" }).click();
  await expect(screen.getByRole("heading", { level: 1 })).toHaveText("Opening in PowerPoint");
  await shoot(screen, "screen-opening");
  const download = screen.getByRole("button", { name: "Download It Instead" });
  await download.waitFor({ state: "visible", timeout: 10_000 });
  await shoot(screen, "screen-opening-download");
  const saved = screen.waitForEvent("download").catch(() => null);
  await download.click();
  await saved;
  await expect(screen.getByRole("heading", { level: 1 })).toHaveText("PowerPoint Didn't Open");
  await shoot(screen, "screen-fallback-deck");
  await screen.context().close();
  await phone.context().close();
});

test("SHOTS the fallback for a photo, which has no PDF", async ({ browser }) => {
  const { screen, phone } = await pair(browser, "/s");
  await phone.getByRole("radio", { name: /Dog\.jpg/ }).check();
  await phone.getByRole("button", { name: "Approve" }).click();
  await expect(screen.locator("#line")).toContainText("Dog.jpg");
  const download = screen.getByRole("button", { name: /Download/ });
  await download.waitFor({ state: "visible", timeout: 10_000 });
  await shoot(screen, "screen-photo-before-fallback");
  const saved = screen.waitForEvent("download").catch(() => null);
  await download.click();
  await saved;
  await expect(screen.getByRole("heading", { level: 1 })).toHaveText("PowerPoint Didn't Open");
  await shoot(screen, "screen-fallback-photo");
  await screen.context().close();
  await phone.context().close();
});

test("SHOTS the slide arrows and the remembered page (demo viewer)", async ({ browser }) => {
  const { screen, phone } = await pair(browser, "/s?mode=demo");
  await phone.getByRole("button", { name: "Approve" }).click();
  await expect(screen.getByRole("img", { name: "Dog.jpg" })).toBeVisible();
  const row = (name: string) =>
    screen.locator("#items").getByRole("button", { name: new RegExp(`^${name.replace(".", "\\.")}`) });
  await row("Sample deck.pptx").click();
  await expect(screen.getByRole("img", { name: "Slide 1 of 2" })).toBeVisible();
  const aim = (fraction: number) => async () => {
    const box = await screen.getByRole("img", { name: "Slide 1 of 2" }).boundingBox();
    if (box) await screen.mouse.move(box.x + box.width * fraction, box.y + box.height / 2);
  };
  for (const [name, fraction] of [
    ["edge-left", 0.1],
    ["mid-left", 0.35],
    ["mid-right", 0.65],
    ["edge-right", 0.9],
  ] as const)
    await shoot(screen, `deck-${name}`, aim(fraction));
  await aim(0.65)();
  await screen.mouse.down();
  await screen.mouse.up();
  await expect(screen.getByRole("img", { name: "Slide 2 of 2" })).toBeVisible();
  await row("Dog.jpg").click();
  await row("Sample deck.pptx").click();
  await shoot(screen, "deck-after-return");
  await screen.context().close();
  await phone.context().close();
});
