// The live match pick on /a (present-live.md 3.2 to 3.4, PAIR-14): the phone gets three numbers, never the screen's,
// and the person taps the one the screen shows. Runs in CI only, as flow.spec.ts.
import { type Browser, expect, type Page, test } from "@playwright/test";
import { choice, expectNoAxeViolations, heading, type Opened, open, pickMatch, typedCodeOf } from "./pairing.ts";

const PICK = "Tap the Screen's Number";
const group = (phone: Page) => phone.getByRole("group", { name: PICK });

/**
 * A live screen and a phone that scanned it, at the pick. `prep` runs on the phone before its first load; with none,
 * the three choices are in before it returns, so the digits read are never the skeleton's none.
 */
async function atPick(browser: Browser, prep?: Parameters<typeof open>[3]) {
  const screen = await open(browser, "screen", "/s");
  await expect(screen.page.locator("#qr")).toBeVisible();
  const code = await typedCodeOf(screen.page);
  const phone = await open(browser, "phone", `/a?c=${code}`, prep);
  await expect(heading(phone.page)).toHaveText("This Screen");
  if (!prep) await expect(phone.page.locator("#pick").getByRole("button")).toHaveCount(3);
  return { screen, phone, code };
}

/** The three choices on the phone, in their order there; the group keeps its id while its legend reads Approving. */
const digits = async (phone: Page) =>
  (await phone.locator("#pick").getByRole("button").allTextContents()).map((t) => t.trim());

const closeAll = async (...all: Opened[]) => {
  for (const o of all) await o.context.close();
};

test.describe("PAIR-14 the match pick", () => {
  test("the phone shows three numbers, the screen's among them, and no digits anywhere else", async ({ browser }) => {
    const { screen, phone } = await atPick(browser);
    await expect(group(phone.page).getByRole("button")).toHaveCount(3);
    const shown = (await screen.page.locator("#match").textContent())?.trim() ?? "";
    const three = await digits(phone.page);
    expect(three).toHaveLength(3);
    expect(new Set(three).size).toBe(3);
    expect(three).toContain(shown);
    for (const d of three) expect(d).toMatch(/^\d{2}$/);
    // The line under the title, no list, no buttons beside the choices; Back lets go of the claim.
    await expect(phone.page.locator("#body")).toHaveText("Tap the screen's number, then choose your files.");
    await expect(phone.page.locator("#file-list")).toBeHidden();
    await expect(phone.page.locator("#actions .btn")).toHaveCount(0);
    await expect(phone.page.getByRole("link", { name: "Back", exact: true })).toBeVisible();
    // The claim's answer and the view never carry the real number while the pick is open.
    const pid = await phone.page.evaluate(() => localStorage.getItem("bloop.pid"));
    const state = await phone.page.evaluate(async (p) => {
      const res = await fetch("/api/pair/state", { headers: { Authorization: `Bearer ${p}` } });
      return (await res.json()) as { match: string | null; confirmed: boolean; choices: string[] };
    }, pid);
    expect(state).toMatchObject({ match: null, confirmed: false });
    expect([...state.choices].sort()).toEqual([...three].sort());
    await expectNoAxeViolations(phone.page);
    await closeAll(screen, phone);
  });

  test("until the module lands, three skeleton pills hold the boxes the choices then take", async ({ browser }) => {
    let release: () => void = () => {};
    const held = new Promise<void>((done) => (release = done));
    const { screen, phone } = await atPick(browser, (context) =>
      context.route("**/js/core/match.js", async (route) => {
        await held;
        await route.continue();
      }),
    );
    const skels = phone.page.locator("#pick .skel");
    await expect(skels).toHaveCount(3);
    const boxes = async (selector: string) =>
      (await phone.page.locator(selector).evaluateAll((els) => els.map((el) => el.getBoundingClientRect()))).map((b) =>
        [b.x, b.y, b.width, b.height].map(Math.round),
      );
    const before = await boxes("#pick .skel");
    expect(before[0]?.[3]).toBe(64);
    const title = await heading(phone.page).boundingBox();
    release();
    await expect(group(phone.page).getByRole("button")).toHaveCount(3);
    await expect(skels).toHaveCount(0);
    expect(await boxes("#pick .choice")).toEqual(before);
    expect(await heading(phone.page).boundingBox()).toEqual(title);
    await closeAll(screen, phone);
  });

  test("the right number: the tapped one fills ink at once, Android ticks once, then the chooser and the file flow", async ({
    browser,
  }) => {
    const { screen, phone } = await atPick(browser, (context) =>
      context.addInitScript({
        content: "window.__buzz = []; navigator.vibrate = (ms) => (window.__buzz.push(ms), true);",
      }),
    );
    // The answer is held, so the tapped state can be read.
    let release: () => void = () => {};
    const held = new Promise<void>((done) => (release = done));
    await phone.page.route("**/api/match", async (route) => {
      await held;
      await route.continue();
    });
    const shown = (await screen.page.locator("#match").textContent())?.trim() ?? "";
    await choice(phone.page, shown).click();
    await expect(choice(phone.page, shown)).toHaveClass(/\bprimary\b/);
    for (const d of (await digits(phone.page)).filter((d) => d !== shown))
      await expect(choice(phone.page, d)).toBeDisabled();
    await expect(phone.page.locator("#pick legend")).toHaveText("Approving...");
    expect(await phone.page.evaluate(() => (globalThis as unknown as { __buzz: number[] }).__buzz)).toEqual([]);
    release();
    // The chooser: one file, radios, and Approve with no digits (the pick compared them).
    await expect(phone.page.locator("#file-list input[type=radio]:checked")).toHaveCount(1);
    await expect(phone.page.locator("#pick")).toBeHidden();
    await expect(phone.page.getByRole("button", { name: "Approve", exact: true })).toHaveText("Approve");
    expect(await phone.page.evaluate(() => (globalThis as unknown as { __buzz: number[] }).__buzz)).toEqual([12]);
    await phone.page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(heading(screen.page)).toHaveText("Opening in PowerPoint");
    await expect(heading(phone.page)).toHaveText("Approved");
    await expect(phone.page.getByRole("button", { name: "Revoke" })).toBeVisible();
    await closeAll(screen, phone);
  });

  test("a wrong number is a dead end, the screen moves on, and the old pid is refused; Enter the Code works", async ({
    browser,
  }) => {
    const { screen, phone, code } = await atPick(browser);
    const shown = (await screen.page.locator("#match").textContent())?.trim() ?? "";
    const wrong = (await digits(phone.page)).find((d) => d !== shown) ?? "";
    const pid = await phone.page.evaluate(() => localStorage.getItem("bloop.pid"));
    await choice(phone.page, wrong).click();
    await expect(heading(phone.page)).toHaveText("That Wasn't the Screen's Number");
    await expect(phone.page.locator("#body")).toHaveText("Scan the screen again, or type its code.");
    const enter = phone.page.getByRole("link", { name: "Enter the Code" });
    await expect(enter).toBeVisible();
    // One exit: no Back, and no choice to guess again.
    await expect(phone.page.getByRole("link", { name: "Back", exact: true })).toBeHidden();
    await expect(phone.page.locator("#pick")).toBeHidden();
    await expectNoAxeViolations(phone.page);
    // The screen shows a new code; the old pid is dead and dropped.
    const next = await typedCodeOf(screen.page);
    expect(next).not.toBe(code);
    expect(await phone.page.evaluate(() => localStorage.getItem("bloop.pid"))).toBeNull();
    const refused = await phone.page.evaluate(async (p) => {
      const res = await fetch("/api/pair/state", { headers: { Authorization: `Bearer ${p}` } });
      return { status: res.status, code: ((await res.json()) as { code: string }).code };
    }, pid);
    expect(refused).toEqual({ status: 401, code: "pairing_invalid" });
    const again = await phone.page.evaluate(async (p) => {
      const res = await fetch("/api/match", {
        method: "POST",
        headers: { Authorization: `Bearer ${p}`, "Content-Type": "application/json" },
        body: JSON.stringify({ choice: "00" }),
      });
      return { status: res.status, code: ((await res.json()) as { code: string }).code };
    }, pid);
    expect(again).toEqual({ status: 401, code: "pairing_invalid" });
    // A reload holds no pairing: "Scan the Code", which keeps Back.
    await phone.page.reload();
    await expect(heading(phone.page)).toHaveText("Scan the Code");
    // The fallback: Enter the Code, then the screen's new code, back to a fresh pick.
    await phone.page.getByRole("link", { name: "Enter the Code" }).click();
    await expect(phone.page).toHaveURL(/\/code$/);
    await phone.page.getByRole("textbox").fill(next);
    await phone.page.keyboard.press("Enter");
    await expect(group(phone.page).getByRole("button")).toHaveCount(3);
    await closeAll(screen, phone);
  });

  test("offline at the tap: the choices return to rest with the toast, and the same number then works", async ({
    browser,
  }) => {
    const { screen, phone } = await atPick(browser);
    await phone.page.route("**/api/match", (route) => route.abort("internetdisconnected"));
    const shown = (await screen.page.locator("#match").textContent())?.trim() ?? "";
    await choice(phone.page, shown).click();
    const alert = phone.page.getByRole("alert");
    await expect(alert).toContainText("You're Offline");
    await expect(alert).toContainText("Check your connection, then tap the number again.");
    for (const d of await digits(phone.page)) await expect(choice(phone.page, d)).toBeEnabled();
    await expect(choice(phone.page, shown)).not.toHaveClass(/\bprimary\b/);
    await expect(phone.page.locator("#pick legend")).toHaveText(PICK);
    await phone.page.unroute("**/api/match");
    await choice(phone.page, shown).click();
    await expect(phone.page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
    await closeAll(screen, phone);
  });

  test("a match module that fails to load says so with Reload, over the skeleton pills", async ({ browser }) => {
    const { screen, phone } = await atPick(browser, (context) =>
      context.route("**/js/core/match.js", (route) => route.abort()),
    );
    const alert = phone.page.getByRole("alert");
    await expect(alert).toContainText("Match Didn't Load");
    await expect(alert.getByRole("button", { name: "Reload" })).toBeVisible();
    await expect(phone.page.locator("#pick .skel")).toHaveCount(3);
    await closeAll(screen, phone);
  });

  test("a full live flow: a reload mid-pick keeps the pick, the pick, approve, Revoke ends it on both", async ({
    browser,
  }) => {
    const { screen, phone } = await atPick(browser);
    const three = await digits(phone.page);
    await phone.page.reload();
    await expect(heading(phone.page)).toHaveText("This Screen");
    await expect(group(phone.page).getByRole("button")).toHaveCount(3);
    expect(await digits(phone.page)).toEqual(three);
    await pickMatch(phone.page, screen.page);
    await phone.page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(heading(screen.page)).toHaveText("Opening in PowerPoint");
    await phone.page.getByRole("button", { name: "Revoke" }).click();
    await phone.page
      .getByRole("dialog", { name: "End This Session?" })
      .getByRole("button", { name: "End Session" })
      .click();
    await expect(heading(phone.page)).toHaveText("Session Ended");
    await expect(heading(screen.page)).toHaveText("Session Ended");
    await closeAll(screen, phone);
  });
});
