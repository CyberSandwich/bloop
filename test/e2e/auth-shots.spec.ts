// Throwaway: /signin and /invite screenshots for review (ci/a-shots only, never merged). Saved under test-results/shots/.
import { type Browser, expect, type Page, type Route, test } from "@playwright/test";

const TOKEN = "T".repeat(43);
const TURNSTILE = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const FAKE_TURNSTILE =
  "window.turnstile={render:function(b,o){window.__ts=o;return 'w'},execute:function(){Promise.resolve().then(function(){window.__ts.callback('tok')})},reset:function(){}};";

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", headers: { "X-Bloop": "1" }, body: JSON.stringify(body) });

async function mock(page: Page, peek: Record<string, unknown>, me: Record<string, unknown> = { signedIn: false }) {
  await page.route(TURNSTILE, (r) => r.fulfill({ contentType: "text/javascript", body: FAKE_TURNSTILE }));
  await page.route("**/api/me", (r) =>
    json(r, 200, { source: "mock", launchMode: "preview", turnstileSiteKey: "1x00000000000000000000AA", ...me }),
  );
  await page.route("**/api/auth/code/request", (r) =>
    json(r, 202, { challengeId: "c".repeat(22), expiresAt: Date.now() + 600_000 }),
  );
  await page.route(/\/api\/(auth\/code|invite)\/verify$/, (r) => json(r, 400, { type: "about:blank", status: 400, code: "code_invalid" }));
  await page.route("**/api/invite/peek", (r) => json(r, 200, peek));
  await page.route("**/api/invite/accept", (r) => json(r, 202, { challengeId: "c".repeat(22) }));
}

const OPEN = { state: "open", emailMasked: "y**@example.test", expiresAt: Date.UTC(2026, 11, 2, 12) };

const SIZES: [number, number][] = [
  [320, 700],
  [390, 844],
  [430, 932],
  [844, 390],
  [1440, 900],
];

type Scene = (page: Page) => Promise<void>;

const toCode = async (page: Page) => {
  await page.goto("/signin");
  await page.getByLabel("Email").fill("you@example.test");
  await page.getByRole("button", { name: "Email Me a Code" }).click();
  await expect(page.getByRole("heading", { name: "Check Your Email" })).toBeVisible();
};

const SCENES: Record<string, Scene> = {
  "signin-email": async (page) => {
    await mock(page, OPEN);
    await page.goto("/signin");
    await page.getByLabel("Email").fill("you@example.test");
  },
  "signin-code-wrong": async (page) => {
    await mock(page, OPEN);
    await toCode(page);
    await page.getByLabel("Code").pressSequentially("111111");
    await expect(page.locator("#code-error.is-on")).toBeVisible();
  },
  "signin-blocked": async (page) => {
    await mock(page, OPEN);
    await page.unroute(TURNSTILE);
    await page.route(TURNSTILE, (r) => r.abort("blockedbyclient"));
    await page.goto("/signin");
    await page.getByLabel("Email").fill("you@example.test");
    await expect(page.locator("#email-error.is-on")).toBeVisible();
  },
  "invite-open": async (page) => {
    await mock(page, OPEN);
    await page.goto(`/invite#t=${TOKEN}`);
    await expect(page.getByRole("heading", { name: "You're Invited" })).toBeVisible();
  },
  "invite-other": async (page) => {
    await mock(page, OPEN, { signedIn: true, email: "ann@other.example", admin: false });
    await page.goto(`/invite#t=${TOKEN}`);
    await expect(page.getByRole("button", { name: "Sign Out and Continue" })).toBeVisible();
  },
  "invite-expired": async (page) => {
    await mock(page, { state: "expired" });
    await page.goto(`/invite#t=${TOKEN}`);
    await expect(page.getByRole("heading", { name: "This Invite Has Expired" })).toBeVisible();
  },
  "invite-skeleton": async (page) => {
    await mock(page, OPEN);
    await page.unroute("**/api/invite/peek");
    await page.route("**/api/invite/peek", () => new Promise(() => {}));
    await page.goto(`/invite#t=${TOKEN}`);
  },
};

async function shoot(browser: Browser, w: number, h: number, scheme: "light" | "dark", name: string, scene: Scene) {
  const context = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
  const page = await context.newPage();
  await scene(page);
  await page.evaluate("document.fonts.ready");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `test-results/shots/${name}-${w}x${h}-${scheme}.png` });
  await context.close();
}

for (const [name, scene] of Object.entries(SCENES)) {
  for (const [w, h] of SIZES) {
    test(`${name} ${w}x${h}`, async ({ browser }) => {
      await shoot(browser, w, h, "light", name, scene);
    });
  }
  test(`${name} 390x844 dark`, async ({ browser }) => {
    await shoot(browser, 390, 844, "dark", name, scene);
  });
}
