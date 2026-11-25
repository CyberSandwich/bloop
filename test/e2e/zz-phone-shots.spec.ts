// Temporary: screenshots of the phone's guest states at narrow sizes for a review in CI. Removed in the next commit.
import { expect, test } from "@playwright/test";

const SIZES = [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 834, height: 1194 },
];

for (const size of SIZES) {
  test(`phone guest states at ${size.width}x${size.height}`, async ({ browser }) => {
    const screen = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await screen.goto("/s?mode=demo");
    await expect(screen.locator("#typed-code")).toHaveText(/^[A-Z0-9]{3} [A-Z0-9]{3}$/);
    const code = ((await screen.locator("#typed-code").textContent()) ?? "").replace(/\s/g, "");
    const context = await browser.newContext({ viewport: size, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto(`/a?c=${code}`);
    await expect(page.getByRole("button", { name: "Approve" })).toBeEnabled();
    const shot = (name: string) =>
      page.screenshot({ path: `test-results/shots/${size.width}x${size.height}-${name}.png`, fullPage: false });
    await shot("1-list");
    let release = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    await page.route("**/api/drop", async (route) => {
      await held;
      await route.continue();
    });
    const pick = async (file: { name: string; mimeType: string; buffer: Buffer }) => {
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Add a File" }).click();
      await (await chooser).setFiles(file);
    };
    await pick({ name: "clip.mov", mimeType: "video/quicktime", buffer: Buffer.alloc(11 * 1024 * 1024) });
    await expect(page.getByRole("alert")).toBeVisible();
    await page.waitForTimeout(400);
    await shot("2-toast");
    await pick({
      name: "A long holiday photo name from the beach.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n%%EOF\n"),
    });
    await shot("3-confirm");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".row.upload")).toBeVisible();
    await page.waitForTimeout(600);
    await shot("4-sending");
    release();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^(Sent to|This File)/);
    await shot("5-after");
    await context.close();
  });
}
