// Throwaway: upload pill screenshots for review (ci/u-client-shots only, never merged). Saved under test-results/shots/.
// The page is the real engine and binding against the real Worker; only the stuck states stub POST /complete.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";

const now = Date.now();
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
// Parallel workers share one local database: a locked one is tried again.
const d1 = (sql: string) => {
  for (let tries = 0; ; tries++) {
    const r = spawnSync(
      "npx",
      ["wrangler", "d1", "execute", "bloop", "--local", "--persist-to", ".wrangler/state", "--command", sql],
      { encoding: "utf8" },
    );
    if (r.status === 0) return;
    if (tries >= 10 || !/locked|BUSY/.test(r.stderr)) throw new Error(r.stderr.slice(-400));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 + tries * 300);
  }
};

function seed(): string {
  const user = `shot-${randomUUID()}`;
  const cookie = `${user}-c`;
  d1(
    [
      `INSERT INTO app_user (id, tid, oid, email, created_at, last_seen_at, email_norm, status, used_bytes) VALUES ('${user}', 'email', '${user}', '${user}@example.test', ${now}, ${now}, '${user}@example.test', 'active', 0)`,
      `INSERT INTO phone_session (id_hash, user_id, created_at, last_seen_at, expires_at, public_id) VALUES ('${sha(cookie)}', '${user}', ${now}, ${now}, ${now + 86_400_000}, 'pub-${user}')`,
    ].join("; "),
  );
  return cookie;
}

const SIZES: [number, number][] = [
  [320, 700],
  [390, 844],
  [430, 932],
  [844, 390],
];

async function scene(
  browser: import("@playwright/test").Browser,
  w: number,
  h: number,
  name: string,
  options: { calm?: boolean; before?: (page: Page) => Promise<void> } = {},
) {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: w, height: h },
    ...(options.calm ? { reducedMotion: "reduce" as const } : {}),
  });
  await context.setExtraHTTPHeaders({ Cookie: `__Host-bloop_sid=${seed()}` });
  const page = await context.newPage();
  await options.before?.(page);
  await page.goto(`/upload-shots.html?scene=${name}`);
  await page.locator("body[data-ready]").waitFor({ state: "attached" });
  return { context, page };
}
const shot = (page: Page, file: string) => page.screenshot({ path: `test-results/shots/${file}.png` });
/** The server keeps these answers `checking`, as a read budget past the cap does. */
const stuck = (page: Page) =>
  page.route("**/api/uploads/*/complete", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/json", "X-Bloop": "1" },
      body: JSON.stringify({ state: "checking", file: { id: "f1", status: "checking" } }),
    }),
  );

for (const [w, h] of SIZES) {
  const at = `${w}x${h}`;

  test(`progress, waiting and cancel ${at}`, async ({ browser }) => {
    const { context, page } = await scene(browser, w, h, "uploading");
    await expect(page.locator(".up-pill .up-line")).toContainText(" of ");
    await page.waitForTimeout(600);
    await shot(page, `progress-${at}`);
    await page.getByRole("button", { name: /^Cancel Upload of/ }).click();
    await expect(page.getByText("Upload Canceled")).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, `cancel-${at}`);
    await context.close();

    const waiting = await scene(browser, w, h, "waiting");
    await expect(waiting.page.locator(".up-pill .up-line")).toHaveText("Waiting for a Connection", { timeout: 15_000 });
    await shot(waiting.page, `waiting-${at}`);
    await waiting.context.close();
  });

  test(`saved and refusals ${at}`, async ({ browser }) => {
    const saved = await scene(browser, w, h, "saved");
    await expect(saved.page.locator(".up-pill .up-title")).toHaveText("Saved", { timeout: 30_000 });
    await shot(saved.page, `saved-${at}`);
    await saved.context.close();

    const one = await scene(browser, w, h, "refusal");
    await expect(one.page.getByText("This File Type Isn't Supported")).toBeVisible({ timeout: 30_000 });
    await shot(one.page, `refusal-${at}`);
    await one.context.close();

    const many = await scene(browser, w, h, "refusals");
    await many.page.getByRole("button", { name: "See Why" }).click({ timeout: 30_000 });
    await expect(many.page.locator("dialog[open] .up-item").first()).toBeVisible();
    await shot(many.page, `refusals-sheet-${at}`);
    await many.context.close();

    const batch = await scene(browser, w, h, "batch");
    await expect(batch.page.locator(".up-pill .up-title")).toHaveText("Uploading 3 Files");
    await batch.page.waitForTimeout(800);
    await shot(batch.page, `batch-${at}`);
    await batch.page.locator(".up-press").click();
    await expect(batch.page.locator("dialog[open] .up-item").first()).toBeVisible();
    await shot(batch.page, `batch-sheet-${at}`);
    await batch.context.close();
  });

  test(`checking, then still checking ${at}`, async ({ browser }) => {
    test.setTimeout(300_000);
    const { context, page } = await scene(browser, w, h, "checking", {
      before: async (page) => void (await stuck(page)),
    });
    await expect(page.locator(".up-pill .up-title")).toHaveText("Checking Your File", { timeout: 30_000 });
    await shot(page, `checking-${at}`);
    await expect(page.locator(".up-pill .up-title")).toHaveText("Still Checking Your File", { timeout: 200_000 });
    await expect(page.getByRole("button", { name: "Check Again" })).toBeVisible();
    await shot(page, `still-checking-${at}`);
    await context.close();
  });
}

test("reduced motion: the pill uploading", async ({ browser }) => {
  const { context, page } = await scene(browser, 390, 844, "uploading", { calm: true });
  await expect(page.locator(".up-pill .up-line")).toContainText(" of ");
  await page.waitForTimeout(600);
  await shot(page, "reduced-motion-390x844");
  await context.close();
});

test("the pill at 1440", async ({ browser }) => {
  const { context, page } = await scene(browser, 1440, 900, "uploading");
  await expect(page.locator(".up-pill .up-line")).toContainText(" of ");
  await page.waitForTimeout(600);
  await shot(page, "pill-1440x900");
  await context.close();
});
