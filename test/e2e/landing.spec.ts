// The landing against docs/design.md section 13 at the three check widths. CI only.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// The callbacks below run in the browser; the test tsconfig has no DOM library, so these names are
// declared here, for this file only.
interface El {
  getBoundingClientRect(): { top: number; bottom: number; left: number; right: number; width: number; height: number };
  textContent: string | null;
  closest(selector: string): El | null;
}
declare const document: {
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): Iterable<El>;
  documentElement: { scrollWidth: number };
  fonts?: { ready: Promise<unknown> };
};
declare const innerWidth: number;
declare const getComputedStyle: (el: El) => {
  visibility: string;
  lineHeight: string;
  transform: string;
  backgroundColor: string;
};

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900, touch: false },
  { name: "834", width: 834, height: 1112, touch: true },
  { name: "390", width: 390, height: 844, touch: true },
] as const;

for (const vp of VIEWPORTS) {
  test.describe(`landing at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.width === 390 });

    test("has no axe violations, no CSP violation and no robin", async ({ page }) => {
      const csp: string[] = [];
      const requests: string[] = [];
      page.on("request", (r) => requests.push(r.url()));
      page.on("console", (m) => {
        if (m.text().includes("Content Security Policy") || m.text().includes("TrustedHTML")) csp.push(m.text());
      });
      await page.goto("/");
      await page.waitForLoadState("load");
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(csp).toEqual([]);
      expect(requests.filter((u) => /robin/.test(u))).toEqual([]);
      expect((await page.content()).toLowerCase()).not.toContain("robin");
    });

    test("the h1 is one line from 640 (two below), with no horizontal scroll and every target at least 44 px", async ({
      page,
    }) => {
      await page.goto("/");
      await page.evaluate(() => document.fonts?.ready);
      const lines = await page.evaluate(() => {
        const h1 = document.querySelector("h1");
        if (!h1) return 99;
        return Math.round(h1.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(h1).lineHeight));
      });
      expect(lines).toBe(vp.width < 640 ? 2 : 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const small = await page.evaluate(() =>
        [...document.querySelectorAll("a, button, summary")]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return (
              getComputedStyle(el).visibility !== "hidden" &&
              r.width > 0 &&
              el.closest(".skip, .faq p, .cell p") === null
            );
          })
          .map((el) => ({ text: el.textContent?.trim(), h: Math.round(el.getBoundingClientRect().height) }))
          .filter((t) => t.h < 44),
      );
      expect(small).toEqual([]);
    });

    test("Try the Demo is the hero's one button, in the first view, and opens the demo screen", async ({ page }) => {
      await page.goto("/");
      const actions = page.locator(".hero .hero-actions").getByRole("link");
      await expect(actions).toHaveCount(1);
      await expect(actions).toHaveText("Try the Demo");
      await expect(actions).toBeInViewport();
      await expect(actions).toHaveAttribute("href", "/demo");
      await actions.click();
      await expect(page).toHaveURL(/\/s\?mode=demo$/);
    });

    test("the hero block sits in the middle of the first view, and the stage starts at the fold", async ({ page }) => {
      await page.goto("/");
      await page.evaluate(() => document.fonts?.ready);
      const box = await page.evaluate(() => {
        const top = document.querySelector(".hero h1")?.getBoundingClientRect().top ?? 0;
        const bottom = document.querySelector(".hero-actions")?.getBoundingClientRect().bottom ?? 0;
        return {
          middle: (top + bottom) / 2,
          stage: document.querySelector(".stage")?.getBoundingClientRect().top ?? 0,
        };
      });
      // The nav's clearance is padded on both sides, so the block's middle is the hero's within a few px.
      expect(Math.abs(box.middle - vp.height / 2)).toBeLessThan(24);
      expect(Math.abs(box.stage - vp.height)).toBeLessThanOrEqual(1);
    });

    test("the logo pill and the links pill are separate and share one height", async ({ page }) => {
      await page.goto("/");
      const box = (selector: string) =>
        page.locator(selector).evaluate((el) => {
          const r = (el as unknown as El).getBoundingClientRect();
          return { top: r.top, left: r.left, right: r.right, height: r.height };
        });
      const logo = await box(".nav-logo");
      const pill = await box(".nav-pill");
      expect(logo.right).toBeLessThan(pill.left);
      expect(logo.height).toBe(pill.height);
      expect(logo.top).toBe(pill.top);
    });

    test("the text gap from Privacy to Security equals the text gap from Security to Waitlist, within 1 px", async ({
      page,
    }) => {
      test.skip(vp.width < 640, "the links fold into the menu");
      await page.goto("/");
      await page.evaluate(() => document.fonts?.ready);
      // A string, since Range is a DOM type this tsconfig lacks; text edges, not link boxes, are what the eye sees.
      const [privacyToSecurity = 0, securityToWaitlist = 99] = (await page.evaluate(`(() => {
        const text = (s) => { const r = document.createRange(); r.selectNodeContents(document.querySelector(s)); return r.getBoundingClientRect(); };
        const p = text('.nav-links a[href="/privacy"]'), s = text('.nav-links a[href="/security"]'), w = text(".nav .waitlist");
        return [s.left - p.right, w.left - s.right];
      })()`)) as number[];
      expect(Math.abs(privacyToSecurity - securityToWaitlist)).toBeLessThanOrEqual(1);
    });

    test("the nav's Waitlist is visible and inside the viewport, on a phone too", async ({ page }) => {
      await page.goto("/");
      const waitlist = page.locator(".nav .waitlist");
      await expect(waitlist).toBeVisible();
      await expect(waitlist).toBeInViewport({ ratio: 1 });
    });

    test("the last letter of Anywhere is inside the painted box", async ({ page }) => {
      await page.goto("/");
      await page.evaluate(() => document.fonts?.ready);
      // The box grows by its padding and the margin takes it back: the title's width is unchanged.
      const [padding = "", margin = ""] = (await page.evaluate(`(() => {
        const c = getComputedStyle(document.querySelector(".sheen"));
        return [c.paddingRight, c.marginRight];
      })()`)) as string[];
      expect(Number.parseFloat(padding) + Number.parseFloat(margin)).toBeCloseTo(0, 1);
      expect(Number.parseFloat(padding)).toBeGreaterThan(0);
    });

    test("the nav stays on top, firms up once scrolled, and its Waitlist opens the form", async ({ page }) => {
      await page.goto("/");
      const nav = page.locator(".nav");
      await expect(nav).not.toHaveClass(/is-scrolled/);
      await expect(nav.getByRole("link", { name: "Waitlist" })).toHaveAttribute(
        "href",
        "https://tally.so/r/Yj4KAN?source=landing",
      );
      await page.mouse.wheel(0, vp.height);
      await expect(nav).toHaveClass(/is-scrolled/);
      await expect(nav.getByRole("link", { name: "bloop" })).toBeInViewport();
    });

    test("the nav reaches Features, Privacy and Security", async ({ page }) => {
      await page.goto("/");
      const nav = page.getByRole("navigation", { name: "Primary" });
      if (vp.width < 640) {
        await expect(nav.getByRole("link", { name: "Privacy" })).toBeHidden();
        await nav.getByRole("button", { name: "Menu" }).click();
      }
      for (const name of ["Features", "Privacy", "Security"])
        await expect(nav.getByRole("link", { name })).toBeVisible();
      await nav.getByRole("link", { name: "Features" }).click();
      await expect(page.locator("#features h2")).toBeInViewport();
      await expect(nav.getByRole("link", { name: "Security" })).toBeVisible({ visible: vp.width >= 640 });
    });

    test("a nav jump leaves no hash behind, so a reload opens at the top", async ({ page }) => {
      await page.goto("/");
      const nav = page.getByRole("navigation", { name: "Primary" });
      if (vp.width < 640) await nav.getByRole("button", { name: "Menu" }).click();
      await nav.getByRole("link", { name: "Features" }).click();
      await expect(page.locator("#features h2")).toBeInViewport();
      await expect.poll(() => page.evaluate("location.hash")).toBe("");
      expect(Number(await page.evaluate("scrollY"))).toBeGreaterThan(0);
      await page.reload();
      expect(Number(await page.evaluate("scrollY"))).toBe(0);
    });

    test("a page opened with a hash jumps there once and drops it", async ({ page }) => {
      await page.goto("/#features");
      await expect(page.locator("#features h2")).toBeInViewport();
      await expect.poll(() => page.evaluate("location.hash")).toBe("");
      await page.reload();
      expect(Number(await page.evaluate("scrollY"))).toBe(0);
    });

    test("a question opens and closes", async ({ page }) => {
      await page.goto("/");
      const item = page.locator(".faq details").filter({ hasText: "What does the room PC keep?" });
      await item.locator("summary").click();
      await expect(item).toHaveAttribute("open", "");
      await expect(item.getByRole("link", { name: "See what can stay." })).toBeVisible();
      await item.locator("summary").click();
      await expect(item).not.toHaveAttribute("open", "");
    });
  });
}

test.describe("reduced motion", () => {
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

  test("the stage rests flat", async ({ page }) => {
    await page.goto("/");
    const stage = page.locator(".stage");
    await expect(stage).toHaveText("");
    await expect(stage.getByRole("img")).toHaveAttribute("alt", /^The bloop viewer/);
    expect(await stage.evaluate((el) => getComputedStyle(el as unknown as El).transform)).toBe("none");
    await stage.scrollIntoViewIfNeeded();
    expect(await stage.evaluate((el) => (el as unknown as { getAnimations(): unknown[] }).getAnimations().length)).toBe(
      0,
    );
  });
});

test.describe("phone hero", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the phone mockup replaces the screenshot, bare of the stage's frame, and still tilts", async ({ page }) => {
    await page.goto("/");
    const img = page.locator(".stage img");
    await expect
      .poll(() => img.evaluate((el) => (el as unknown as { currentSrc: string }).currentSrc))
      .toMatch(/\/img\/hero-phone-(600|900)\.(avif|webp)$/);
    const style = await page.locator(".stage").evaluate((el) => {
      const c = getComputedStyle(el as unknown as El) as unknown as Record<string, string>;
      return [c.borderRadius, c.boxShadow, c.backgroundColor];
    });
    expect(style).toEqual(["0px", "none", "rgba(0, 0, 0, 0)"]);
    // The layout box, not the bounding box: the stage is tilted and scaled while it enters.
    const [w = 0, h = 1] = await img.evaluate((el) => [
      (el as unknown as { offsetWidth: number }).offsetWidth,
      (el as unknown as { offsetHeight: number }).offsetHeight,
    ]);
    expect(Math.abs(w / h - 1155 / 2366)).toBeLessThan(0.01);
    await page.locator(".stage").scrollIntoViewIfNeeded();
    expect(
      await page
        .locator(".stage")
        .evaluate((el) => (el as unknown as { getAnimations(): unknown[] }).getAnimations().length),
    ).toBeGreaterThan(0);
  });
});

test.describe("narrow nav up to 760", () => {
  test.use({ viewport: { width: 700, height: 900 } });

  test("at 700 the links fold into the menu, and its button reads close while the sheet is open", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: "Privacy" })).toBeHidden();
    const button = nav.getByRole("button", { name: "Menu" });
    await expect(button.locator(".menu-open")).toBeVisible();
    await button.click();
    await expect(nav.getByRole("link", { name: "Privacy" })).toBeVisible();
    await expect(button.locator(".menu-close")).toBeVisible();
    await expect(button.locator(".menu-open")).toBeHidden();
  });
});

test.describe("site nav", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const path of ["/privacy", "/security"]) {
    test(`${path} shows its own link as the selected pill`, async ({ page }) => {
      await page.goto(path);
      const current = page.getByRole("navigation", { name: "Primary" }).locator('a[aria-current="page"]');
      await expect(current).toHaveAttribute("href", path);
      expect(await current.evaluate((el) => getComputedStyle(el as unknown as El).backgroundColor)).not.toBe(
        "rgba(0, 0, 0, 0)",
      );
    });
  }
});

test.describe("site pages", () => {
  for (const path of ["/security", "/privacy", "/no-such-page"]) {
    test(`${path} has no axe violations, and its logo goes home`, async ({ page }) => {
      await page.goto(path);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.locator(".nav .brand").click();
      await expect(page).toHaveURL(/\/$/);
    });
  }

  test("/it moves to /security", async ({ page }) => {
    const res = await page.goto("/it");
    expect(new URL(res?.url() ?? "").pathname).toBe("/security");
    await expect(page.locator("h1")).toHaveText("Security");
  });
});
