// Throwaway: screenshots of the early-access state, Scan the Screen Again and the guest offer. Never merged.
import { expect, test } from "@playwright/test";
import { heading, open, typedCodeOf } from "./pairing.ts";

const SIZES = [
  [320, 568],
  [390, 844],
  [430, 932],
  [844, 390],
  [1440, 900],
] as const;

for (const [width, height] of SIZES) {
  test(`early access at ${width}x${height}`, async ({ browser }) => {
    const screen = await open(browser, "screen", "/s");
    await expect(screen.page.locator("#qr")).toBeVisible();
    const code = await typedCodeOf(screen.page);
    const phone = await open(browser, "phone", `/a?c=${code}`, async (context) => {
      await context.route("**/api/claim", (route) =>
        route.fulfill({
          status: 401,
          contentType: "application/problem+json",
          body: JSON.stringify({ type: "about:blank", status: 401, code: "auth_required" }),
        }),
      );
      await context.route("**/api/me", (route) =>
        route.fulfill({
          contentType: "application/json",
          headers: { "X-Bloop": "1" },
          body: JSON.stringify({ source: "graph", signedIn: false, email: null, launchMode: "open" }),
        }),
      );
    });
    await phone.page.setViewportSize({ width, height });
    await expect(heading(phone.page)).toHaveText("Early Access Only");
    await phone.page.waitForTimeout(400);
    await phone.page.screenshot({ path: `test-results/shots/early-${width}x${height}.png` });
    await phone.page.keyboard.press("Tab");
    await phone.page.screenshot({ path: `test-results/shots/early-${width}x${height}-tab.png` });
  });

  test(`rescan at ${width}x${height}`, async ({ browser }) => {
    const phone = await open(browser, "phone", "/code");
    await phone.page.setViewportSize({ width, height });
    await phone.page.evaluate(() =>
      sessionStorage.setItem("bloop.resume", JSON.stringify({ code: "ZZZ9ZZ", key: "k", at: Date.now() })),
    );
    await phone.page.goto("/a");
    await expect(heading(phone.page)).toHaveText("Scan the Screen Again");
    await phone.page.waitForTimeout(400);
    await phone.page.screenshot({ path: `test-results/shots/rescan-${width}x${height}.png` });
  });

  test(`guest confirm at ${width}x${height}`, async ({ browser }) => {
    const screen = await open(browser, "screen", "/s?mode=demo");
    await expect(screen.page.locator("#qr")).toBeVisible();
    const code = await typedCodeOf(screen.page);
    const phone = await open(browser, "phone", `/a?c=${code}`);
    await phone.page.setViewportSize({ width, height });
    await expect(heading(phone.page)).toHaveText("Demo Room");
    const chooser = phone.page.waitForEvent("filechooser");
    await phone.page.getByRole("button", { name: "Add a File" }).click();
    await (await chooser).setFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n") });
    await expect(heading(phone.page)).toHaveText("Send notes.pdf to Demo Room?");
    await phone.page.waitForTimeout(400);
    await phone.page.screenshot({ path: `test-results/shots/confirm-${width}x${height}.png` });
    await phone.page.route("**/api/drop", () => {});
    await phone.page.getByRole("button", { name: "Send" }).click();
    await expect(heading(phone.page)).toHaveText("Sending notes.pdf");
    await phone.page.waitForTimeout(400);
    await phone.page.screenshot({ path: `test-results/shots/sending-${width}x${height}.png` });
  });
}
