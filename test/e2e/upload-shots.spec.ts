// Throwaway: upload pill screenshots for review (ci/u-pill-shots only, never merged). Saved under test-results/shots/.
// The page is the real engine and binding against the real Worker; only the stuck states stub POST /complete.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";

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

/** What the page's API calls answered, printed when a test fails. */
const seen: string[] = [];
test.afterEach(({}, info) => {
  if (info.status !== info.expectedStatus) console.log(`seen:\n${seen.splice(0).join("\n")}`);
  else seen.length = 0;
});

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
  page.on("response", (r) => {
    if (r.url().includes("/api/")) seen.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
  page.on("requestfailed", (r) => seen.push(`FAILED ${r.method()} ${r.url()} ${r.failure()?.errorText}`));
  page.on("console", (m) => seen.push(`console ${m.type()} ${m.text()}`));
  page.on("pageerror", (e) => seen.push(`pageerror ${e.message}`));
  // The throwaway page gets the default CSP, which has no connect-src; the real pages are given one.
  await page.route("**/upload-shots.html*", async (route) => {
    const res = await route.fetch();
    const csp = (res.headers()["content-security-policy"] ?? "").replace("default-src 'none';", "default-src 'none'; connect-src 'self';");
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": csp } });
  });
  await options.before?.(page);
  await page.goto(`/upload-shots.html?scene=${name}`);
  await page.locator("body[data-ready]").waitFor({ state: "attached" });
  return { context, page };
}
/** Taken once every finite animation and transition (entrances, the fill's ease, the sheet) has finished. */
const settled = (page: Page) =>
  page.evaluate(async () => {
    const finite = () =>
      document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    do await Promise.allSettled(finite().map((a) => a.finished));
    while (finite().some((a) => a.playState !== "finished"));
  });
const shot = async (page: Page, file: string) => {
  await settled(page);
  await page.screenshot({ path: `test-results/shots/${file}.png` });
};
/** True when the two elements' boxes share any area. */
const overlap = async (a: Locator, b: Locator) => {
  if (!(await a.count()) || !(await b.count())) return false;
  const [x, y] = [await a.boundingBox({ timeout: 2000 }), await b.boundingBox({ timeout: 2000 })];
  if (!x || !y) return false;
  return x.x < y.x + y.width && y.x < x.x + x.width && x.y < y.y + y.height && y.y < x.y + x.height;
};
/** The server keeps these answers `checking`, as a read budget past the cap does. */
const stuck = (page: Page) =>
  page.route("**/api/uploads/*/complete", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/json", "X-Bloop": "1" },
      body: JSON.stringify({ state: "checking", file: { id: "f1", status: "checking" } }),
    }),
  );


/** One line of text: the pill's text box is no taller than a line and the pill itself is one row. */
const oneLine = async (page: Page, what: string) => {
  const text = await page.locator(".up-pill .up-text").boundingBox();
  const pill = await page.locator(".up-pill").boundingBox();
  console.log(`${what}: text ${text?.height} pill ${pill?.height}`);
  expect(text?.height ?? 99, `${what} text`).toBeLessThanOrEqual(24);
  expect(pill?.height ?? 999, `${what} pill`).toBeLessThanOrEqual(72);
  // The name rule: the name is shown with room for 8 characters or more, or dropped; never a stub.
  const head = page.locator(".up-pill .head");
  if (await head.isVisible()) {
    const em = await head.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    const width = (await head.boundingBox())?.width ?? 0;
    console.log(`${what}: name shown ${width}px (needs ${8 * 0.55 * em})`);
    expect(width, `${what} name`).toBeGreaterThanOrEqual(8 * 0.55 * em - 1);
  } else console.log(`${what}: name dropped`);
};

for (const [w, h] of SIZES) {
  const at = `${w}x${h}`;

  test(`paused, uploading, waiting and cancel ${at}`, async ({ browser }) => {
    const paused = await scene(browser, w, h, "paused");
    await expect(paused.page.locator(".up-pill .up-status")).toHaveText(" \u00b7 Paused", { timeout: 30_000 });
    await oneLine(paused.page, `paused ${at}`);
    await shot(paused.page, `paused-${at}`);
    await paused.context.close();

    const longPaused = await scene(browser, w, h, "paused-long");
    await expect(longPaused.page.locator(".up-pill .up-status")).toHaveText(" \u00b7 Paused", { timeout: 30_000 });
    await oneLine(longPaused.page, `paused long ${at}`);
    await shot(longPaused.page, `paused-long-${at}`);
    await longPaused.context.close();

    const { context, page } = await scene(browser, w, h, "uploading");
    await expect(page.locator(".up-pill .up-status")).toContainText("%", { timeout: 30_000 });
    await page.waitForTimeout(600);
    await oneLine(page, `uploading ${at}`);
    await shot(page, `progress-${at}`);
    await page.getByRole("button", { name: /^Cancel Upload of/ }).click();
    await expect(page.locator(".toast")).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, `cancel-${at}`);
    await context.close();

    const waiting = await scene(browser, w, h, "waiting");
    await expect(waiting.page.locator(".up-pill .up-status")).toHaveText(" \u00b7 Waiting", { timeout: 15_000 });
    await oneLine(waiting.page, `waiting ${at}`);
    await shot(waiting.page, `waiting-${at}`);
    await waiting.context.close();
  });

  test(`saved, refusals and batch ${at}`, async ({ browser }) => {
    const saved = await scene(browser, w, h, "saved");
    await expect(saved.page.locator(".up-pill .up-status")).toHaveText(" \u00b7 Saved", { timeout: 30_000 });
    await oneLine(saved.page, `saved ${at}`);
    await shot(saved.page, `saved-${at}`);
    await saved.context.close();

    const one = await scene(browser, w, h, "refusal");
    await expect(one.page.locator(".toast")).toBeVisible({ timeout: 30_000 });
    await settled(one.page);
    const toast = await one.page.locator(".toast").boundingBox();
    console.log(`refusal ${at}: toast ${toast?.height} text ${await one.page.locator(".toast").innerText()}`);
    expect(toast?.height ?? 999).toBeLessThanOrEqual(72);
    await shot(one.page, `refusal-${at}`);
    await one.context.close();

    const many = await scene(browser, w, h, "refusals");
    await many.page.getByRole("button", { name: "See Why" }).click({ timeout: 30_000 });
    await expect(many.page.locator("dialog[open] .up-item").first()).toBeVisible();
    await shot(many.page, `refusals-sheet-${at}`);
    await many.context.close();

    const batch = await scene(browser, w, h, "batch");
    await expect(batch.page.locator(".up-pill .up-status")).toContainText("%", { timeout: 30_000 });
    await batch.page.waitForTimeout(800);
    await oneLine(batch.page, `batch ${at}`);
    await shot(batch.page, `batch-${at}`);
    await batch.context.close();
  });
}

for (const [w, h] of [SIZES[0], SIZES[1]] as [number, number][]) {
  const at = `${w}x${h}`;
  test(`checking, then still checking ${at}`, async ({ browser }) => {
    test.setTimeout(300_000);
    const { context, page } = await scene(browser, w, h, "checking", {
      before: async (page) => void (await stuck(page)),
    });
    await expect(page.locator(".up-pill .up-status")).toHaveText(" \u00b7 Checking", { timeout: 30_000 });
    await oneLine(page, `checking ${at}`);
    await shot(page, `checking-${at}`);
    await expect(page.locator(".up-pill .up-status")).toHaveText(" \u00b7 Still Checking", { timeout: 200_000 });
    await expect(page.getByRole("button", { name: "Check Again" })).toBeVisible();
    await oneLine(page, `still checking ${at}`);
    const act = await page.getByRole("button", { name: "Check Again" }).boundingBox();
    console.log(`check again ${at}: ${act?.width} x ${act?.height}`);
    expect(act?.height ?? 0).toBeGreaterThanOrEqual(24);
    expect(act?.width ?? 0).toBeGreaterThanOrEqual(24);
    console.log(`status ${at}: ${await page.locator(".up-pill .up-title").innerText()}`);
    await shot(page, `still-checking-${at}`);
    await context.close();
  });
}
