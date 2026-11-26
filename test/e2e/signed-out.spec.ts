// A signed-out phone's claim on a live code (present-live.md 5, PAIR-15). The e2e server runs the mock source, where
// every owner counts as signed in, so the Graph answers are routed: the claim's 401 auth_required while signed out,
// /api/me's launch mode, and /auth/start standing in for Entra and the callback (a 302 to /a, with no code). The
// guest claims and the claims after sign-in go to the real server. Runs in CI only, as flow.spec.ts.
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { expectNoAxeViolations, heading, type Opened, open, pickMatch, typedCodeOf } from "./pairing.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const KEPT = "bloop.resume";

interface Claim {
  kind: string;
  key: string | undefined;
  nonce: string | undefined;
  refused: boolean;
}

/**
 * Routes the Graph side for one phone context: `mode` is what /api/me says, and the phone counts as signed out until
 * /auth/start runs. Every claim is recorded with its headers.
 */
async function graph(context: BrowserContext, mode: "preview" | "open") {
  const state = { signedIn: false, claims: [] as Claim[] };
  await context.route("**/api/claim", async (route) => {
    const req = route.request();
    const body = req.postDataJSON() as { kind?: string };
    const refused = body.kind === "owner" && !state.signedIn;
    const h = req.headers();
    state.claims.push({ kind: body.kind ?? "", key: h["idempotency-key"], nonce: h["x-bloop-nonce"], refused });
    if (!refused) return route.continue();
    await route.fulfill({
      status: 401,
      contentType: "application/problem+json",
      body: JSON.stringify({ type: "about:blank", status: 401, code: "auth_required" }),
    });
  });
  await context.route("**/api/me", (route) =>
    route.fulfill({
      contentType: "application/json",
      headers: { "X-Bloop": "1" },
      body: JSON.stringify({ source: "graph", signedIn: state.signedIn, email: null, launchMode: mode }),
    }),
  );
  await context.route("**/auth/start", (route) => {
    state.signedIn = true;
    return route.fulfill({ status: 302, headers: { Location: "/a" } });
  });
  return state;
}

/** A live screen and a phone that scanned it signed out; `prep` runs on the phone before its first load. */
async function scanSignedOut(
  browser: Parameters<typeof open>[0],
  mode: "preview" | "open",
  prep?: (c: BrowserContext) => Promise<unknown>,
) {
  const screen = await open(browser, "screen", "/s");
  await expect(screen.page.locator("#qr")).toBeVisible();
  const code = await typedCodeOf(screen.page);
  let state = { signedIn: false, claims: [] as Claim[] };
  const phone = await open(browser, "phone", `/a?c=${code}`, async (context) => {
    state = await graph(context, mode);
    await prep?.(context);
  });
  return { screen, phone, code, state: () => state };
}

const closeAll = async (...all: Opened[]) => {
  for (const o of all) await o.context.close();
};

const pick = (phone: Page) => phone.locator("#pick").getByRole("button");

test.describe("PAIR-15 a signed-out claim on a live code", () => {
  test("MODE-01 preview: a signed-out owner claim goes as a guest at once, has to pick, then adds a file", async ({
    browser,
  }) => {
    const { screen, phone, state } = await scanSignedOut(browser, "preview");
    await expect(heading(phone.page)).toHaveText("This Screen");
    await expect(pick(phone.page)).toHaveCount(3);
    const claims = state().claims;
    expect(claims.map((c) => [c.kind, c.refused])).toEqual([
      ["owner", true],
      ["guest", false],
    ]);
    // One key per attempt, one nonce per tab.
    for (const c of claims) {
      expect(c.key).toMatch(UUID);
      expect(c.nonce).toMatch(NONCE);
    }
    expect(claims[0]?.key).not.toBe(claims[1]?.key);
    expect(claims[0]?.nonce).toBe(claims[1]?.nonce);
    await expect(phone.page.getByRole("heading", { name: "Early Access Only" })).toHaveCount(0);
    await pickMatch(phone.page, screen.page);
    await expect(phone.page.getByRole("button", { name: "Add a File" })).toBeVisible();
    await closeAll(screen, phone);
  });

  test("open: Early Access Only; Sign In keeps the code, and back on /a the same claim goes on to the pick", async ({
    browser,
  }) => {
    const { screen, phone, state } = await scanSignedOut(browser, "open");
    await expect(heading(phone.page)).toHaveText("Early Access Only");
    await expect(phone.page.locator("#body")).toHaveText(
      "Sign in to present your own files. No invite yet? You can still send one file to this screen.",
    );
    const actions = phone.page.locator("#actions .btn");
    await expect(actions).toHaveCount(4);
    await expect(actions).toHaveText(["Try the Demo", "Join the Waitlist", "Send One File", "Sign In"]);
    await expect(phone.page.getByRole("link", { name: "Try the Demo" })).toHaveAttribute("href", "/demo");
    await expect(phone.page.getByRole("link", { name: "Join the Waitlist" })).toHaveAttribute("data-waitlist", "");
    await expect(heading(phone.page)).toBeFocused();
    await expectNoAxeViolations(phone.page);

    await phone.page.getByRole("button", { name: "Sign In" }).click();
    await expect(heading(phone.page)).toHaveText("This Screen");
    await expect(pick(phone.page)).toHaveCount(3);
    expect(new URL(phone.page.url()).pathname).toBe("/a");
    // Taken once: the kept code is gone, and the claim after sign-in reused the refused one's key.
    expect(await phone.page.evaluate((k) => sessionStorage.getItem(k), KEPT)).toBeNull();
    const claims = state().claims;
    expect(claims.map((c) => [c.kind, c.refused])).toEqual([
      ["owner", true],
      ["owner", false],
    ]);
    expect(claims[1]?.key).toBe(claims[0]?.key);
    // The owner's pick leads to the chooser, as section 3.
    await pickMatch(phone.page, screen.page);
    await expect(phone.page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
    await closeAll(screen, phone);
  });

  test("open: the four actions stay inside the action box at every width", async ({ browser }) => {
    const { screen, phone } = await scanSignedOut(browser, "open");
    await expect(heading(phone.page)).toHaveText("Early Access Only");
    for (const size of [
      { width: 320, height: 568 },
      { width: 390, height: 844 },
      { width: 430, height: 932 },
      { width: 844, height: 390 },
      { width: 1440, height: 900 },
    ]) {
      await phone.page.setViewportSize(size);
      const box = await phone.page.locator(".actions").boundingBox();
      for (const b of await phone.page.locator("#actions .btn").all()) {
        const r = await b.boundingBox();
        if (!box || !r) throw new Error("no box");
        // A leading text action sits 12 out, so its words line up with the column (app.css).
        expect(Math.round(r.x), `${size.width}`).toBeGreaterThanOrEqual(Math.round(box.x) - 12);
        expect(Math.round(r.x + r.width), `${size.width}`).toBeLessThanOrEqual(Math.round(box.x + box.width));
      }
    }
    await closeAll(screen, phone);
  });

  test("open: Send One File claims the same code as a guest, which picks then adds a file", async ({ browser }) => {
    const { screen, phone, state } = await scanSignedOut(browser, "open");
    await expect(heading(phone.page)).toHaveText("Early Access Only");
    await phone.page.getByRole("button", { name: "Send One File" }).click();
    await expect(heading(phone.page)).toHaveText("This Screen");
    await pickMatch(phone.page, screen.page);
    await expect(phone.page.getByRole("button", { name: "Add a File" })).toBeVisible();
    expect(state().claims.map((c) => c.kind)).toEqual(["owner", "guest"]);
    await closeAll(screen, phone);
  });

  test("open: a kept code that died while signing in reads Scan the Screen Again, one exit, no Back", async ({
    browser,
  }) => {
    const phone = await open(browser, "phone", "/code");
    // A code no screen holds: the claim answers code_unknown, as a code that expired meanwhile does.
    await phone.page.evaluate(
      (k) => sessionStorage.setItem(k, JSON.stringify({ code: "ZZZ9ZZ", key: crypto.randomUUID(), at: Date.now() })),
      KEPT,
    );
    await phone.page.goto("/a");
    await expect(heading(phone.page)).toHaveText("Scan the Screen Again");
    await expect(phone.page.locator("#body")).toHaveText(
      "The code changed while you signed in. You're signed in now, so one scan is all it takes.",
    );
    await expect(phone.page.getByRole("link", { name: "Enter the Code" })).toBeVisible();
    await expect(phone.page.getByRole("link", { name: "Back", exact: true })).toBeHidden();
    expect(await phone.page.evaluate((k) => sessionStorage.getItem(k), KEPT)).toBeNull();
    await closeAll(phone);
  });

  test("a kept code older than 5 minutes is never replayed: /a reads as no code", async ({ browser }) => {
    const phone = await open(browser, "phone", "/code");
    let claims = 0;
    phone.page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/claim") claims += 1;
    });
    await phone.page.evaluate(
      (k) => sessionStorage.setItem(k, JSON.stringify({ code: "ZZZ9ZZ", key: "k", at: Date.now() - 300_001 })),
      KEPT,
    );
    await phone.page.goto("/a");
    await expect(heading(phone.page)).toHaveText("Scan the Code");
    expect(claims).toBe(0);
    await closeAll(phone);
  });

  test("open: if the early-access module cannot load, the same code goes as a guest and never dead-ends", async ({
    browser,
  }) => {
    const { screen, phone, state } = await scanSignedOut(browser, "open", (context) =>
      context.route("**/js/core/early.js", (route) => route.abort()),
    );
    await expect(heading(phone.page)).toHaveText("This Screen");
    await expect(pick(phone.page)).toHaveCount(3);
    expect(state().claims.map((c) => c.kind)).toEqual(["owner", "guest"]);
    await closeAll(screen, phone);
  });
});

/** A demo phone at the offer of one PDF over its list; `prep` runs on the phone before its first load. */
async function atOffer(browser: Parameters<typeof open>[0], prep: (c: BrowserContext) => Promise<unknown>) {
  const screen = await open(browser, "screen", "/s?mode=demo");
  await expect(screen.page.locator("#qr")).toBeVisible();
  const code = await typedCodeOf(screen.page);
  const phone = await open(browser, "phone", `/a?c=${code}`, prep);
  await expect(heading(phone.page)).toHaveText("Demo Room");
  const chooser = phone.page.waitForEvent("filechooser");
  await phone.page.getByRole("button", { name: "Add a File" }).click();
  await (await chooser).setFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n") });
  await expect(heading(phone.page)).toHaveText("Send notes.pdf to Demo Room?");
  return { screen, phone };
}

test("a Cancel while the send module loads sends nothing when it lands", async ({ browser }) => {
  let release: () => void = () => {};
  const held = new Promise<void>((done) => (release = done));
  const { screen, phone } = await atOffer(browser, (context) =>
    context.route("**/js/core/send.js", async (route) => {
      await held;
      await route.continue();
    }),
  );
  let drops = 0;
  phone.page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/drop") drops += 1;
  });
  await phone.page.getByRole("button", { name: "Send" }).click();
  await phone.page.getByRole("button", { name: "Cancel" }).click();
  await expect(heading(phone.page)).toHaveText("Demo Room");
  const landed = phone.page.waitForResponse("**/js/core/send.js");
  release();
  await landed;
  // The same module record, so once this resolves the page's own then() has run too.
  await phone.page.evaluate((url) => import(url).then(() => 0), "/js/core/send.js");
  await expect(heading(phone.page)).toHaveText("Demo Room");
  expect(drops).toBe(0);
  await closeAll(screen, phone);
});

test("a send module that cannot load says so with Reload, and the offer stays", async ({ browser }) => {
  const { screen, phone } = await atOffer(browser, (context) =>
    context.route("**/js/core/send.js", (route) => route.abort()),
  );
  await phone.page.getByRole("button", { name: "Send" }).click();
  const alert = phone.page.getByRole("alert");
  await expect(alert).toContainText("That Didn't Load");
  await expect(alert.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(heading(phone.page)).toHaveText("Send notes.pdf to Demo Room?");
  await closeAll(screen, phone);
});
