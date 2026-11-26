// LINK-02: the phone's Open on a link row opens the link in a new tab on the screen, or, where the browser refuses a tab
// no click asked for, shows the pill that does it (docs/design.md section 7, Phone page and Room screen). CI only.
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";

const VEVOX = "https://www.vevox.com/";

/** A screen and its phone, approved, the remote showing. `screenInit` runs on the screen before its first load. */
async function paired(browser: Browser, screenInit?: string) {
  const screenContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // No request leaves for vevox.com: a popup's page is answered here.
  await screenContext.route(`${VEVOX}**`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>Vevox</title>" }),
  );
  if (screenInit) await screenContext.addInitScript(screenInit);
  const screen = await screenContext.newPage();
  await screen.goto("/s?mode=demo");
  await expect(screen.locator("#qr-panel")).not.toHaveClass(/\bis-swapping\b/);
  await expect(screen.locator("#typed-code")).toHaveText(/^[A-Z0-9]{3} [A-Z0-9]{3}$/);
  const code = ((await screen.locator("#typed-code").textContent()) ?? "").replace(/\s/g, "");
  const phoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const phone = await phoneContext.newPage();
  await phone.goto(`/a?c=${code}`);
  await expect(phone.getByRole("button", { name: "Approve" })).toBeEnabled();
  await phone.getByRole("button", { name: /^Approve, code \d{2} on the screen$/ }).click();
  // The remote is lazy: its group shows once the phone is approved, and from then a link row's tap asks the screen.
  await expect(phone.getByRole("group", { name: "The Screen" })).toBeVisible();
  const row = phone.locator("#file-list").getByRole("link", { name: /^Vevox/ });
  await expect(row).toBeVisible();
  await expect(screen.locator("#items").getByRole("link", { name: /^Vevox/ })).toBeVisible();
  return { screen, screenContext, phone, phoneContext, row };
}

const toast = (page: Page) => page.locator(".toast:not(.out)");
const close = (...contexts: BrowserContext[]) => Promise.all(contexts.map((c) => c.close()));

test.describe("LINK-02 the phone opens a link on the screen", () => {
  test("LINK-02 e2e popup allowed: the screen opens a new tab on the link, the phone says so, and bloop stays live", async ({
    browser,
  }) => {
    const { screen, screenContext, phone, phoneContext, row } = await paired(browser);
    const popup = screenContext.waitForEvent("page");
    await row.click();
    await (await popup).waitForURL(VEVOX);
    await expect(toast(phone)).toContainText("Opened on the Screen");
    await expect(toast(phone)).toContainText("This phone can't control that tab.");
    // No pill, and the bloop tab is still there to command.
    await expect(screen.locator("#b-link")).toBeHidden();
    await expect(screen.getByRole("heading", { level: 1 })).toBeVisible();
    // The phone did not open it itself.
    expect(phoneContext.pages()).toHaveLength(1);
    await close(screenContext, phoneContext);
  });

  test("LINK-02 e2e popup blocked: the pill shows at the top, the phone says to tap the screen, and the click opens the tab", async ({
    browser,
  }) => {
    // The first window.open is refused, as a browser does without a click on this page; a real click then works.
    const refuseOnce =
      "{ const real = window.open.bind(window); let n = 0; window.open = (...a) => (n++ ? real(...a) : null); }";
    const { screen, screenContext, phone, phoneContext, row } = await paired(browser, refuseOnce);
    await row.click();
    const pill = screen.locator("#b-link");
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText("Open Vevox");
    await expect(toast(phone)).toContainText("Tap Open on the Screen");
    // The Stop Presenting pill's look: one rule styles both. Stop is hidden here, so its top and left stay unresolved
    // (the next test checks the place).
    const sameAsStop = await screen.evaluate(
      `["position", "translate", "zIndex", "minHeight", "backgroundColor", "boxShadow"].every((p) =>
        getComputedStyle(document.getElementById("b-link"))[p] === getComputedStyle(document.getElementById("b-stop"))[p])`,
    );
    expect(sameAsStop).toBe(true);
    expect(screenContext.pages()).toHaveLength(1);
    const popup = screenContext.waitForEvent("page");
    await pill.click();
    await (await popup).waitForURL(VEVOX);
    await expect(pill).toBeHidden();
    await close(screenContext, phoneContext);
  });

  test("LINK-02 e2e pill and Stop Presenting: presenting that starts after the pill never puts Stop under it", async ({
    browser,
  }) => {
    const { screen, screenContext, phone, phoneContext, row } = await paired(browser, "window.open = () => null;");
    await row.click();
    const pill = screen.locator("#b-link");
    await expect(pill).toBeVisible();
    await phone
      .locator("#file-list")
      .getByRole("button", { name: /\.pptx/ })
      .first()
      .click();
    await phone.getByRole("button", { name: "Present", exact: true }).click();
    const stop = screen.locator("#b-stop");
    await expect(stop).toBeVisible();
    await expect(pill).toBeVisible();
    const [a, b] = await Promise.all([stop.boundingBox(), pill.boundingBox()]);
    if (!a || !b) throw new Error("no box");
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
    await close(screenContext, phoneContext);
  });
});
