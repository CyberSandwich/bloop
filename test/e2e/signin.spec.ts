// /signin and /invite in the browser, in both modes, with the API mocked (page.route): the email step and Turnstile
// through the Trusted Types policy, the code field (digits typed one at a time, a paste, five wrong codes, the
// countdown and the expiry on page.clock), the invite states, and axe on each page.
import AxeBuilder from "@axe-core/playwright";
import type { Page, Route } from "@playwright/test";
import { expect, test } from "./mode.ts";

const CODE = "481207";
const TOKEN = "T".repeat(43);
const CHALLENGE = "c".repeat(22);
const TURNSTILE = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const WRONG = "That code didn't match. Try again.";
const BLOCKED = "Turn off content blocking for bloop.here to sign in.";
// Stands in for Turnstile's script: draws nothing and answers execute with a token, on a microtask so a paused clock
// cannot hold it.
const FAKE_TURNSTILE =
  "window.turnstile={render:function(b,o){window.__ts=o;return 'w'},execute:function(){Promise.resolve().then(function(){window.__ts.callback('tok')})},reset:function(){}};";

const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "X-Bloop": "1", ...headers },
    body: JSON.stringify(body),
  });
const problem = (route: Route, status: number, code: string, headers: Record<string, string> = {}) =>
  json(route, status, { type: "about:blank", status, code }, headers);
/** A 202's lifetime as the Worker states it: the absolute expiry, and the time left. */
const lifetime = () => ({ expiresAt: Date.now() + 600_000, expiresIn: 600_000 });

interface Mock {
  /** What GET /api/me says: signed out until a code verifies, unless a test sets it. */
  me: Record<string, unknown>;
  /** The session the verify would set; null keeps /api/me signed out (cookies blocked). */
  after: Record<string, unknown> | null;
  requests: Record<string, unknown>[];
  verifies: string[];
  peek: Record<string, unknown>;
}

async function mock(page: Page, over: Partial<Mock> = {}): Promise<Mock> {
  const m: Mock = {
    me: { source: "mock", signedIn: false, launchMode: "preview", turnstileSiteKey: "1x00000000000000000000AA" },
    after: { source: "mock", signedIn: true, email: "you@example.test", admin: false, launchMode: "preview" },
    requests: [],
    verifies: [],
    peek: { state: "open", emailMasked: "y**@example.test", expiresAt: Date.UTC(2026, 11, 2, 12) },
    ...over,
  };
  await page.route(TURNSTILE, (r) => r.fulfill({ contentType: "text/javascript", body: FAKE_TURNSTILE }));
  await page.route("**/api/me", (r) => json(r, 200, m.me));
  await page.route("**/api/auth/code/request", (r) => {
    m.requests.push(r.request().postDataJSON());
    return json(r, 202, { challengeId: CHALLENGE, ...lifetime() });
  });
  const verify = (r: Route) => {
    const { challengeId, code } = r.request().postDataJSON();
    m.verifies.push(code);
    if (challengeId !== CHALLENGE || code !== CODE) return problem(r, 400, "code_invalid");
    if (m.after) m.me = m.after;
    return json(r, 200, { next: "/library", offerPasskey: false });
  };
  await page.route("**/api/auth/code/verify", verify);
  await page.route("**/api/invite/verify", verify);
  await page.route("**/api/invite/peek", (r) => json(r, 200, m.peek));
  await page.route("**/api/invite/accept", (r) =>
    json(r, 202, { challengeId: CHALLENGE, emailMasked: "y**@example.test", ...lifetime() }),
  );
  await page.route("**/api/me/signout", (r) => json(r, 200, { signedIn: false }));
  // By pathname: a glob would also catch /signin?next=/account.
  for (const path of ["/library", "/account"])
    await page.route(
      (url) => url.pathname === path,
      (r) => r.fulfill({ contentType: "text/html", body: `<!DOCTYPE html><title>${path}</title><h1>${path}</h1>` }),
    );
  return m;
}

/** Console lines from the policies: none may appear. */
function violations(page: Page): string[] {
  const seen: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Trusted Type/i.test(message.text())) seen.push(message.text());
  });
  return seen;
}

const alertLine = (page: Page, form: "email" | "code") => page.locator(`#${form}-error.is-on`);

/** Scrolled into view the least it takes, `selector`'s middle is itself, not a panel floating over it. */
const uncovered = (page: Page, selector: string) =>
  page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + Math.min(r.width / 2, 40), r.top + r.height / 2);
    return r.bottom <= innerHeight && hit !== null && el.contains(hit);
  })()`);

async function toCodeStep(page: Page, path = "/signin") {
  await page.goto(path);
  await page.getByLabel("Email").fill("you@example.test");
  await page.getByRole("button", { name: "Email Me a Code" }).click();
  await expect(page.getByRole("heading", { name: "Check Your Email" })).toBeVisible();
}

test.describe("/signin", () => {
  test("is served in both modes, noindex only in preview, with the auth policy", async ({ request, mode }) => {
    const res = await request.get("/signin");
    expect(res.status()).toBe(200);
    expect(res.headers()["x-robots-tag"]).toBe(mode === "open" ? undefined : "noindex");
    expect(res.headers()["content-security-policy"]).toContain("trusted-types bloop-worker");
  });

  test("the email step sends a Turnstile token, then the code typed one digit at a time signs in", async ({ page }) => {
    const seen = violations(page);
    const m = await mock(page);
    await page.goto("/signin");
    const send = page.getByRole("button", { name: "Email Me a Code" });
    await expect(send).toBeDisabled();
    await page.getByLabel("Email").fill("you@example.test");
    await send.click();
    await expect(page.getByRole("heading", { name: "Check Your Email" })).toBeVisible();
    await expect(page.locator("#lead")).toHaveText("If you@example.test has early access, a code is on its way.");
    expect(m.requests).toEqual([{ email: "you@example.test", turnstile: "tok" }]);
    const field = page.getByLabel("Code");
    await expect(field).toHaveAttribute("autocomplete", "one-time-code");
    await expect(field).toHaveAttribute("inputmode", "numeric");
    await field.pressSequentially("4812", { delay: 30 });
    await expect(field).toHaveValue("481 2");
    expect(m.verifies).toEqual([]);
    await field.pressSequentially("07", { delay: 30 });
    await page.waitForURL("**/library");
    expect(m.verifies).toEqual([CODE]);
    expect(seen).toEqual([]);
  });

  test("Turnstile loads on intent: nothing from Cloudflare until the first keystroke in the field", async ({
    page,
  }) => {
    await mock(page);
    const cloudflare: string[] = [];
    page.on("request", (r) => {
      if (r.url().startsWith("https://challenges.cloudflare.com/")) cloudflare.push(r.url());
    });
    await page.goto("/signin");
    await expect(page.getByLabel("Email")).toBeFocused();
    await page.waitForLoadState("networkidle");
    expect(cloudflare).toEqual([]);
    await page.getByLabel("Email").press("y");
    await expect.poll(() => cloudflare).toEqual([TURNSTILE]);
  });

  test("a failed /api/me read is not kept: Try Again reads it again and the code request carries a token", async ({
    page,
  }) => {
    const m = await mock(page);
    let reads = 0;
    await page.route("**/api/me", (r) => (++reads === 1 ? problem(r, 503, "service_busy") : json(r, 200, m.me)));
    await page.goto("/signin");
    await page.getByLabel("Email").fill("you@example.test");
    await expect(alertLine(page, "email")).toHaveText(BLOCKED);
    await page.getByRole("button", { name: "Try Again" }).click();
    await expect(alertLine(page, "email")).toBeHidden();
    await page.getByRole("button", { name: "Email Me a Code" }).click();
    await expect(page.getByRole("heading", { name: "Check Your Email" })).toBeVisible();
    expect(m.requests).toEqual([{ email: "you@example.test", turnstile: "tok" }]);
    expect(reads).toBe(2);
  });

  test("a pasted '481 207' signs in, and ?next= lands where it asked", async ({ page }) => {
    await mock(page);
    await toCodeStep(page, "/signin?next=/account");
    await page.evaluate(`(() => {
      const data = new DataTransfer();
      data.setData("text/plain", "481 207");
      const paste = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
      document.getElementById("code").dispatchEvent(paste);
    })()`);
    await page.waitForURL("**/account");
  });

  test("a next outside the allowlist lands on the library", async ({ page }) => {
    await mock(page);
    await toCodeStep(page, "/signin?next=https://evil.example/");
    await page.getByLabel("Code").pressSequentially(CODE);
    await page.waitForURL("**/library");
  });

  test("five wrong codes show Too many tries, and a sixth sends nothing", async ({ page }) => {
    const m = await mock(page);
    await toCodeStep(page);
    const field = page.getByLabel("Code");
    for (let i = 1; i <= 5; i++) {
      // The digits stay selected after a refusal, so typing replaces them.
      await field.pressSequentially("111111");
      await expect.poll(() => m.verifies.length).toBe(i);
      await expect(alertLine(page, "code")).toHaveText(i < 5 ? WRONG : "Too many tries. Send a new code.");
      await expect(field).toBeEnabled();
      await expect(field).toHaveAttribute("aria-invalid", "true");
    }
    await field.pressSequentially("222222");
    await expect(alertLine(page, "code")).toHaveText("Too many tries. Send a new code.");
    expect(m.verifies).toHaveLength(5);
  });

  test("the resend countdown runs 0:30 to 0:24 to Send a New Code; past expiresIn a code is still sent and reads expired", async ({
    page,
  }) => {
    const start = Date.UTC(2026, 10, 26, 9);
    await page.clock.install({ time: start });
    await page.clock.pauseAt(start + 1000);
    const m = await mock(page);
    await toCodeStep(page);
    const resend = page.locator("#resend");
    await expect(resend).toHaveText("Send a New Code in 0:30");
    await expect(resend).toBeDisabled();
    await page.clock.runFor(6000);
    await expect(resend).toHaveText("Send a New Code in 0:24");
    await page.clock.runFor(24_000);
    await expect(resend).toHaveText("Send a New Code");
    await expect(resend).toBeEnabled();
    await page.clock.runFor(570_000);
    await expect(alertLine(page, "code")).toHaveText("That code has expired. Send a new one.");
    // The server decides expiry: the page sends the code and words the refusal by its own deadline.
    await page.getByLabel("Code").pressSequentially("111111");
    await expect.poll(() => m.verifies).toEqual(["111111"]);
    await expect(alertLine(page, "code")).toHaveText("That code has expired. Send a new one.");
    await resend.click();
    await expect(resend).toHaveText("Send a New Code in 0:30");
    expect(m.requests).toHaveLength(2);
  });

  test("Use a Different Email and Back both return to the email step with the address kept", async ({ page }) => {
    await mock(page);
    await toCodeStep(page);
    await page.getByRole("button", { name: "Use a Different Email" }).click();
    await expect(page.getByRole("heading", { name: "Sign In" })).toBeVisible();
    await expect(page.getByLabel("Email")).toHaveValue("you@example.test");
    await page.getByRole("button", { name: "Email Me a Code" }).click();
    await expect(page.getByRole("heading", { name: "Check Your Email" })).toBeVisible();
    await page.getByRole("link", { name: "Back" }).click();
    await expect(page.getByRole("heading", { name: "Sign In" })).toBeVisible();
    await expect(page).toHaveURL(/\/signin$/);
  });

  test("the skip link on the code step focuses the title and keeps the step, with no #title in the address", async ({
    page,
  }) => {
    await mock(page);
    await toCodeStep(page);
    await page.locator(".skip").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Check Your Email" })).toBeFocused();
    await expect(page.getByLabel("Code")).toBeVisible();
    await expect(page).toHaveURL(/\/signin$/);
  });

  test("a session cookie that did not stick shows the cookies line, stays, and gives the field back", async ({
    page,
  }) => {
    await mock(page, { after: null });
    await toCodeStep(page);
    await page.getByLabel("Code").pressSequentially(CODE);
    await expect(alertLine(page, "code")).toHaveText(
      "Your browser blocked sign-in. Allow cookies for bloop.here, then try again.",
    );
    await expect(page.getByLabel("Code")).toBeEnabled();
    await expect(page).toHaveURL(/\/signin$/);
  });

  test("Turnstile blocked: the content-blocking line with Try Again, and no code request", async ({ page }) => {
    const m = await mock(page);
    await page.unroute(TURNSTILE);
    await page.route(TURNSTILE, (r) => r.abort("blockedbyclient"));
    await page.goto("/signin");
    await page.getByLabel("Email").fill("you@example.test");
    await expect(alertLine(page, "email")).toHaveText(BLOCKED);
    await expect(page.getByRole("button", { name: "Try Again" })).toBeVisible();
    await page.getByRole("button", { name: "Email Me a Code" }).click();
    await expect(alertLine(page, "email")).toHaveText(BLOCKED);
    expect(m.requests).toEqual([]);
  });

  test("over the bucket the wait is Retry-After's; an address the server refuses is marked invalid", async ({
    page,
  }) => {
    await mock(page);
    await page.route("**/api/auth/code/request", (r) => problem(r, 429, "rate_limited", { "Retry-After": "900" }));
    await page.goto("/signin");
    await page.getByLabel("Email").fill("you@example.test");
    await page.getByRole("button", { name: "Email Me a Code" }).click();
    await expect(alertLine(page, "email")).toHaveText("Too many codes for now. Try again in 15 minutes.");
    await page.unroute("**/api/auth/code/request");
    await page.route("**/api/auth/code/request", (r) => problem(r, 400, "email_invalid"));
    await page.getByRole("button", { name: "Email Me a Code" }).click();
    await expect(page.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("Email")).toBeFocused();
  });

  test("in a short landscape window the code step's error line is not under the panel", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await mock(page);
    await toCodeStep(page);
    await page.getByLabel("Code").pressSequentially("111111");
    await expect(alertLine(page, "code")).toHaveText(WRONG);
    expect(await uncovered(page, "#code-error")).toBe(true);
  });

  test("has no axe violations on the email step and the code step", async ({ page }) => {
    await mock(page);
    await page.goto("/signin");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByLabel("Email").fill("you@example.test");
    await page.getByRole("button", { name: "Email Me a Code" }).click();
    await expect(page.getByRole("heading", { name: "Check Your Email" })).toBeVisible();
    await page.getByLabel("Code").pressSequentially("111111");
    await expect(alertLine(page, "code")).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});

test.describe("/invite", () => {
  test("INV-01 fragment: the address holds no #t= by the time the peek is sent, and Accept, the code and the library follow", async ({
    page,
  }) => {
    const seen = violations(page);
    await mock(page);
    const atPeek: string[] = [];
    await page.route("**/api/invite/peek", async (r) => {
      atPeek.push(String(await page.evaluate("location.href")));
      return json(r, 200, { state: "open", emailMasked: "y**@example.test", expiresAt: Date.UTC(2026, 11, 2, 12) });
    });
    await page.goto(`/invite#t=${TOKEN}`);
    await expect(page.getByRole("heading", { name: "You're Invited" })).toBeVisible();
    expect(atPeek).toHaveLength(1);
    expect(atPeek[0]).toMatch(/\/invite$/);
    await expect(page).toHaveURL(/\/invite$/);
    await expect(page.locator("#lead")).toHaveText("Early access to bloop for y**@example.test.");
    await expect(page.locator("#until")).toContainText("The invite works until");
    await expect(page.locator("#adult")).toHaveText(
      "By continuing you confirm you are 18 or over and accept the Terms.",
    );
    await page.getByRole("button", { name: "Accept Invite" }).click();
    await expect(page.getByRole("heading", { name: "Check Your Email" })).toBeVisible();
    await expect(page.locator("#lead")).toHaveText("A code is on its way to y**@example.test.");
    await page.getByLabel("Code").pressSequentially(CODE);
    await page.waitForURL("**/library");
    expect(seen).toEqual([]);
  });

  for (const [state, title] of [
    ["used", "This Invite Was Already Used"],
    ["expired", "This Invite Has Expired"],
    ["invalid", "This Invite Isn't Valid"],
  ] as const) {
    test(`a ${state} invite is a dead end with one exit`, async ({ page }) => {
      await mock(page, { peek: { state } });
      await page.goto(`/invite#t=${TOKEN}`);
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
      await expect(page.getByRole("button", { name: "Accept Invite" })).toBeHidden();
      await expect(page.locator(".actions .btn:visible")).toHaveCount(1);
    });
  }

  test("a bare /invite asks for the email's link, and sends no request", async ({ page }) => {
    let asked = 0;
    await mock(page);
    await page.route("**/api/invite/peek", (r) => {
      asked++;
      return json(r, 200, {});
    });
    await page.goto("/invite");
    await expect(page.getByRole("heading", { name: "Open Your Invite Email" })).toBeVisible();
    expect(asked).toBe(0);
  });

  test("signed in as someone else: Sign Out and Continue signs out, then accepts", async ({ page }) => {
    const m = await mock(page);
    m.me = { source: "mock", signedIn: true, email: "ann@other.example", admin: false, launchMode: "preview" };
    m.peek = { ...m.peek, forYou: false };
    await page.goto(`/invite#t=${TOKEN}`);
    await expect(page.getByRole("heading", { name: "You're Signed In as a**@other.example" })).toBeVisible();
    await expect(page.locator("#lead")).toHaveText("This invite is for y**@example.test.");
    await page.getByRole("button", { name: "Sign Out and Continue" }).click();
    await expect(page.getByRole("heading", { name: "Check Your Email" })).toBeVisible();
  });

  test("a session already gone still continues: Sign Out and Continue on auth_required accepts", async ({ page }) => {
    const m = await mock(page);
    m.me = { source: "mock", signedIn: true, email: "ann@other.example", admin: false, launchMode: "preview" };
    m.peek = { ...m.peek, forYou: false };
    await page.route("**/api/me/signout", (r) => problem(r, 401, "auth_required"));
    await page.goto(`/invite#t=${TOKEN}`);
    await page.getByRole("button", { name: "Sign Out and Continue" }).click();
    await expect(page.getByRole("heading", { name: "Check Your Email" })).toBeVisible();
  });

  test("the invitee already signed in (the peek says forYou) goes to the library, whatever the masks say", async ({
    page,
  }) => {
    const m = await mock(page);
    m.me = { source: "mock", signedIn: true, email: "yan@example.test", admin: false, launchMode: "preview" };
    m.peek = { ...m.peek, forYou: true };
    await page.goto(`/invite#t=${TOKEN}`);
    await page.waitForURL("**/library");
  });

  test("a same mask is not the same address: without forYou it is someone else", async ({ page }) => {
    const m = await mock(page);
    m.me = { source: "mock", signedIn: true, email: "yuri@example.test", admin: false, launchMode: "preview" };
    m.peek = { ...m.peek, forYou: false };
    await page.goto(`/invite#t=${TOKEN}`);
    await expect(page.getByRole("heading", { name: "You're Signed In as y**@example.test" })).toBeVisible();
  });

  test("Terms keeps the invite for this tab: a fresh load of /invite resumes it once, then it is gone", async ({
    page,
  }) => {
    await mock(page);
    await page.goto(`/invite#t=${TOKEN}`);
    await page.getByRole("link", { name: "Terms" }).click();
    await page.waitForURL("**/terms");
    // A new document, never the back-forward cache: the token comes from this tab's sessionStorage.
    await page.goto("/invite");
    await expect(page.getByRole("heading", { name: "You're Invited" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Open Your Invite Email" })).toBeVisible();
  });

  test("Back from Terms resumes the invite and leaves no token kept behind", async ({ page }) => {
    await mock(page);
    await page.goto(`/invite#t=${TOKEN}`);
    await page.getByRole("link", { name: "Terms" }).click();
    await page.waitForURL("**/terms");
    await page.goBack();
    await expect(page.getByRole("heading", { name: "You're Invited" })).toBeVisible();
    expect(await page.evaluate("sessionStorage.getItem('bloop.invite')")).toBeNull();
  });

  test("the skip link focuses the title and writes no #title into the address", async ({ page }) => {
    await mock(page);
    await page.goto(`/invite#t=${TOKEN}`);
    await expect(page.getByRole("heading", { name: "You're Invited" })).toBeVisible();
    await page.locator(".skip").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "You're Invited" })).toBeFocused();
    await expect(page).toHaveURL(/\/invite$/);
  });

  test("in a short landscape window the invite's date line is not under the panel", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await mock(page);
    await page.goto(`/invite#t=${TOKEN}`);
    await expect(page.locator("#until")).toContainText("The invite works until");
    expect(await uncovered(page, "#until")).toBe(true);
  });

  test("has no axe violations open, dead, and on the code step", async ({ page }) => {
    const m = await mock(page);
    await page.goto(`/invite#t=${TOKEN}`);
    await expect(page.getByRole("heading", { name: "You're Invited" })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Accept Invite" }).click();
    await expect(page.getByRole("heading", { name: "Check Your Email" })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    m.peek = { state: "expired" };
    // A goto that differs only by the fragment would not reload the page.
    await page.goto("about:blank");
    await page.goto(`/invite#t=${TOKEN}`);
    await expect(page.getByRole("heading", { name: "This Invite Has Expired" })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});
