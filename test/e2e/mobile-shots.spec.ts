// Temporary: full-page phone screenshots and layout measurements into test-results/mobile. Never merged.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type Browser, expect, type Page, test } from "@playwright/test";

const OUT = "test-results/mobile";
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 360, height: 780 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 844, height: 390 },
];

const PAGES: [string, string][] = [
  ["landing", "/"],
  ["articles", "/articles"],
  ["art-how", "/articles/how-bloop-works"],
  ["art-data", "/articles/data-and-retention"],
  ["art-threat", "/articles/threat-model-for-it-teams"],
  ["art-pc", "/articles/what-stays-on-the-pc"],
  ["privacy", "/privacy"],
  ["terms", "/terms"],
  ["security", "/security"],
  ["code", "/code"],
  ["404", "/no-such-page"],
  ["s", "/s?mode=demo"],
  ["a-nopair", "/a"],
  ["a-expired", "/a?c=ZZZZZZ"],
];

const MEASURE = `(() => {
  const vw = innerWidth;
  const desc = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).join(".") : "");
  const path = (el) => { const p = []; let e = el; for (let i = 0; e && i < 4; i++, e = e.parentElement) p.unshift(desc(e)); return p.join(" > "); };
  const visible = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0; };
  const all = [...document.querySelectorAll("body *")].filter(visible);
  const wide = all.filter((el) => { const r = el.getBoundingClientRect(); return r.right > vw + 0.5 || r.left < -0.5; })
    .map((el) => { const r = el.getBoundingClientRect(); return { el: path(el), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) }; });
  const targets = [...document.querySelectorAll("a, button, input, select, textarea, summary, label, [role=button], [tabindex]")]
    .filter(visible).map((el) => { const r = el.getBoundingClientRect(); return { el: path(el), text: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter((t) => t.w < 44 || t.h < 44);
  const sizes = {};
  for (const el of all) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 2);
    if (!own) continue;
    const fs = getComputedStyle(el).fontSize;
    const k = fs + " " + el.tagName.toLowerCase();
    sizes[k] = (sizes[k] || 0) + 1;
  }
  const small = Object.fromEntries(Object.entries(sizes).filter(([k]) => parseFloat(k) < 16));
  return { vw, vh: innerHeight, scrollWidth: document.documentElement.scrollWidth, overflow: document.documentElement.scrollWidth > vw, wide: wide.slice(0, 25), wideCount: wide.length, smallTargets: targets, smallText: small };
})()`;

async function settle(page: Page) {
  await page.evaluate(`document.fonts.ready`);
  // Walk down the page so scroll-triggered parts and lazy images run, then back to the top.
  const h = (await page.evaluate("document.documentElement.scrollHeight")) as number;
  for (let y = 0; y < h; y += 300) {
    await page.evaluate(`scrollTo(0, ${y})`);
    await page.waitForTimeout(60);
  }
  await page.evaluate("scrollTo(0, 0)");
  await page.waitForTimeout(500);
}

async function shoot(page: Page, name: string, fullPage = true) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
  const m = await page.evaluate(MEASURE);
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify(m, null, 1));
  console.log(`MEASURE ${name} ${JSON.stringify(m).slice(0, 600)}`);
}

const tag = (vp: { width: number; height: number }) => `${vp.width}x${vp.height}`;
const phoneOpts = (vp: { width: number; height: number }) => ({
  viewport: vp,
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
});

for (const vp of VIEWPORTS) {
  test.describe(`pages ${tag(vp)}`, () => {
    test.use(phoneOpts(vp));
    for (const [name, path] of PAGES) {
      test(`${name} ${tag(vp)}`, async ({ page }) => {
        await page.goto(path);
        await page.waitForTimeout(800);
        await settle(page);
        await shoot(page, `${name}-${tag(vp)}`);
        await shoot(page, `${name}-${tag(vp)}-view`, false);
      });
    }
  });
}

test.describe("landing at 390", () => {
  const vp = { width: 390, height: 844 };
  test.use(phoneOpts(vp));

  test("menu open", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await page.getByRole("button", { name: "Menu" }).tap();
    await page.waitForTimeout(500);
    await shoot(page, "landing-390-menu", false);
    await page.evaluate("scrollTo(0, 1200)");
    await page.waitForTimeout(400);
    await shoot(page, "landing-390-menu-scrolled", false);
  });

  test("scrolled sections", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    const sections = await page.locator("main > section, footer").count();
    for (let i = 0; i < sections; i++) {
      await page.locator("main > section, footer").nth(i).scrollIntoViewIfNeeded();
      await page.evaluate("void 0");
      const el = page.locator("main > section, footer").nth(i);
      await el.evaluate((e) => (e as unknown as { scrollIntoView(o: object): void }).scrollIntoView({ block: "start" }));
      await page.waitForTimeout(600);
      await shoot(page, `landing-390-sec${i}`, false);
    }
  });

  test("faq open and legal contents", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    const q = page.locator("details summary").first();
    if (await q.count()) {
      await q.scrollIntoViewIfNeeded();
      await q.tap();
      await page.waitForTimeout(400);
      await shoot(page, "landing-390-faq-open", false);
    }
    for (const p of ["privacy", "terms", "security"]) {
      await page.goto(`/${p}`);
      await settle(page);
      await page.evaluate("scrollTo(0, 1500)");
      await page.waitForTimeout(600);
      await shoot(page, `${p}-390-scrolled`, false);
    }
  });
});

// The /a states, through the demo flow the e2e flow spec drives: the screen at 1440, the phone at each viewport.
async function pair(browser: Browser, vp: { width: number; height: number }) {
  const screenCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const screen = await screenCtx.newPage();
  await screen.goto("/s?mode=demo");
  await expect(screen.locator("#qr-panel")).not.toHaveClass(/\bis-swapping\b/);
  await expect(screen.locator("#typed-code")).toHaveText(/^[A-Z0-9]{3} [A-Z0-9]{3}$/);
  const code = ((await screen.locator("#typed-code").textContent()) ?? "").replace(/\s/g, "");
  const phoneCtx = await browser.newContext(phoneOpts(vp));
  const phone = await phoneCtx.newPage();
  await phone.goto(`/a?c=${code}`);
  await expect(phone.getByRole("button", { name: "Approve" })).toBeEnabled();
  await phone.waitForTimeout(600);
  return { screen, phone, close: async () => (await screenCtx.close(), await phoneCtx.close()) };
}

for (const vp of VIEWPORTS) {
  test.describe(`app /a ${tag(vp)}`, () => {
    test(`approve, approved, sheet ${tag(vp)}`, async ({ browser }) => {
      const { phone, close } = await pair(browser, vp);
      await shoot(phone, `a-approve-${tag(vp)}`);
      await shoot(phone, `a-approve-${tag(vp)}-view`, false);
      await phone.getByRole("button", { name: "Approve" }).click();
      await expect(phone.locator("#ends-text")).toHaveText(/^Ends in /);
      await phone.waitForTimeout(700);
      await shoot(phone, `a-approved-${tag(vp)}`);
      await shoot(phone, `a-approved-${tag(vp)}-view`, false);
      await phone.getByRole("button", { name: /Change the Session Length$/ }).click();
      await expect(phone.getByRole("dialog", { name: "Session Length" })).toBeVisible();
      await phone.waitForTimeout(700);
      await shoot(phone, `a-sheet-${tag(vp)}`, false);
      await close();
    });

    test(`guest drop ${tag(vp)}`, async ({ browser }) => {
      const { phone, close } = await pair(browser, vp);
      const chooser = phone.waitForEvent("filechooser");
      await phone.getByRole("button", { name: "Add a File" }).click();
      await (await chooser).setFiles({
        name: "Quarterly-business-review-FINAL-final-v12-with-appendix-and-speaker-notes.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        buffer: readFileSync("test/fixtures/decks/sample-deck.pptx"),
      });
      await expect(phone.getByRole("button", { name: "Send" })).toBeVisible();
      await phone.waitForTimeout(600);
      await shoot(phone, `a-offer-${tag(vp)}`, false);
      await phone.getByRole("button", { name: "Send" }).click();
      await expect(phone.getByRole("heading", { level: 1 })).toHaveText(/^Sent to /);
      await phone.waitForTimeout(600);
      await shoot(phone, `a-sent-${tag(vp)}`, false);
      // A wrong type: the toast over the list.
      await close();
    });

    test(`refusal toast ${tag(vp)}`, async ({ browser }) => {
      const { phone, close } = await pair(browser, vp);
      const chooser = phone.waitForEvent("filechooser");
      await phone.getByRole("button", { name: "Add a File" }).click();
      await (await chooser).setFiles({ name: "notes.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
      await expect(phone.getByRole("alert")).toBeVisible();
      await phone.waitForTimeout(500);
      await shoot(phone, `a-toast-${tag(vp)}`, false);
      await close();
    });
  });
}
