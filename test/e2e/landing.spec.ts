// The landing against docs/design.md section 13 at the three check widths. CI only.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

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
declare const innerHeight: number;
declare const getComputedStyle: (el: El) => {
  visibility: string;
  lineHeight: string;
  transform: string;
  backgroundColor: string;
  color: string;
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

    test("every feature card opens on a still warm band, its glyph on a glass tile centered in it", async ({
      page,
    }) => {
      await page.goto("/");
      const cards = (await page.evaluate(`[...document.querySelectorAll("#features .cell")].map((cell) => {
        const band = cell.querySelector(":scope > .band");
        const tile = band && band.querySelector(":scope > .band-tile.glass");
        const svg = tile && tile.querySelector("svg");
        if (!svg) return null;
        const c = cell.getBoundingClientRect(), b = band.getBoundingClientRect(), t = tile.getBoundingClientRect();
        const h = cell.querySelector("h3").getBoundingClientRect();
        const style = getComputedStyle(band), before = getComputedStyle(band, "::before");
        return {
          height: Math.round(b.height),
          flush: [b.top - c.top, b.left - c.left, c.right - b.right].map(Math.round),
          corners: [style.borderTopLeftRadius, style.borderBottomLeftRadius],
          // The glyph box, before the house optical scale (--glyph) draws it smaller, as every icon is sized.
          tile: [Math.round(t.width), Math.round(t.height), getComputedStyle(svg).width],
          // The tile's center within 1 px of the band's, across and down.
          centered: [t.left + t.width / 2 - (b.left + b.width / 2), t.top + t.height / 2 - (b.top + b.height / 2)].map(
            (d) => Math.abs(d) <= 1,
          ),
          // The title and body stay left, at the card's text inset.
          text: Math.round(h.left - c.left),
          still: before.animationName,
          backdrop: before.backgroundImage.includes("radial-gradient"),
        };
      })`)) as unknown[];
      expect(cards).toHaveLength(6);
      const height = vp.width < 768 ? 80 : 96;
      for (const card of cards)
        expect(card).toEqual({
          height,
          flush: [0, 0, 0],
          corners: ["24px", "0px"],
          tile: [56, 56, "28px"],
          centered: [true, true],
          text: 24,
          still: "none",
          backdrop: true,
        });
      // The six bands are not stamped from one mold.
      const placed = await page.evaluate(`[...document.querySelectorAll("#features .band")].map((b) => {
        const s = getComputedStyle(b, "::before");
        return s.scale + " " + s.rotate + " " + s.translate;
      })`);
      expect(new Set(placed as string[]).size).toBe(6);
    });

    test("the hero loads the source for its width, and every image below the fold waits to be scrolled to", async ({
      page,
    }) => {
      await page.goto("/");
      await page.waitForLoadState("load");
      const imgs = await page.evaluate(() =>
        [
          ...(document.querySelectorAll("img") as Iterable<El & { loading: string; currentSrc: string; src: string }>),
        ].map((img) => ({
          src: img.currentSrc,
          file: img.src,
          lazy: img.loading === "lazy",
          below: img.getBoundingClientRect().top >= innerHeight,
          hero: img.closest(".stage") !== null,
        })),
      );
      const hero = imgs.find((i) => i.hero);
      expect(hero?.lazy).toBe(false);
      expect(hero?.src).toMatch(/\/img\/hero-viewer-(750|1100|1600|2200)\./);
      const raster = imgs.filter((i) => !i.hero && !i.file.endsWith(".svg"));
      expect(raster.length).toBeGreaterThan(0);
      for (const i of raster) expect(i, i.file).toMatchObject({ lazy: true, below: true });
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

    test("the text gap from Terms to Security equals the text gap from Security to Waitlist, within 1 px", async ({
      page,
    }) => {
      test.skip(vp.width < 640, "the links fold into the menu");
      await page.goto("/");
      await page.evaluate(() => document.fonts?.ready);
      // A string, since Range is a DOM type this tsconfig lacks; text edges, not link boxes, are what the eye sees.
      const [termsToSecurity = 0, securityToWaitlist = 99] = (await page.evaluate(`(() => {
        const text = (s) => { const r = document.createRange(); r.selectNodeContents(document.querySelector(s)); return r.getBoundingClientRect(); };
        const t = text('.nav-links a[href="/terms"]'), s = text('.nav-links a[href="/security"]'), w = text(".nav .waitlist");
        return [s.left - t.right, w.left - s.right];
      })()`)) as number[];
      expect(Math.abs(termsToSecurity - securityToWaitlist)).toBeLessThanOrEqual(1);
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

    test("Connect's share rows and provider rows start their names at one x, and each head is a title and a chip", async ({
      page,
    }) => {
      await page.goto("/");
      const xs =
        (await page.evaluate(`(() => [...document.querySelectorAll(".rows li")].filter((li) => li.querySelector(".icon")).map((li) => {
        const range = document.createRange();
        range.selectNodeContents(li.lastChild);
        return Math.round((range.getBoundingClientRect().left - li.getBoundingClientRect().left) * 10) / 10;
      }))()`)) as number[];
      expect(xs).toHaveLength(8);
      for (const x of xs) expect(Math.abs(x - (xs[0] ?? 0))).toBeLessThanOrEqual(1);
      const heads = (await page.evaluate(`[...document.querySelectorAll(".group-head")].map((h) => {
        const title = h.querySelector("h3").getBoundingClientRect();
        const chip = h.querySelector(".status").getBoundingClientRect();
        return [title.left < chip.left, Math.abs((title.top + title.bottom) / 2 - (chip.top + chip.bottom) / 2) < 8];
      })`)) as boolean[][];
      expect(heads).toEqual([
        [true, true],
        [true, true],
      ]);
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

    test("the nav reaches Features, Articles, Privacy, Terms and Security", async ({ page }) => {
      await page.goto("/");
      const nav = page.getByRole("navigation", { name: "Primary" });
      if (vp.width < 640) {
        await expect(nav.getByRole("link", { name: "Privacy" })).toBeHidden();
        await nav.getByRole("button", { name: "Menu" }).click();
      }
      for (const name of ["Features", "Articles", "Privacy", "Terms", "Security"])
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

    test("Back to the landing keeps its place", async ({ page }) => {
      await page.goto("/");
      await page.evaluate("scrollTo(0, 1500)");
      await page.getByRole("contentinfo").getByRole("link", { name: "Privacy" }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Privacy Notice");
      await page.goBack();
      await expect(page).toHaveURL("/");
      await expect.poll(() => page.evaluate("scrollY")).toBeGreaterThan(0);
    });

    test("the ink between two sheen bands is narrower than the word, so the word is never all ink", async ({
      page,
    }) => {
      await page.goto("/");
      const [word, tile] = (await page.evaluate(`(() => {
        const el = document.querySelector(".sheen");
        return [el.getBoundingClientRect().width, parseFloat(getComputedStyle(el).backgroundSize)];
      })()`)) as number[];
      // The gradient is transparent over the first 35% and last 2% of each tile.
      expect(0.37 * (tile ?? 0)).toBeLessThan(word ?? 0);
    });

    test("the sheen pauses while the hero is off screen", async ({ page }) => {
      await page.goto("/");
      const sheen = page.locator(".sheen");
      await expect(sheen).not.toHaveClass(/is-paused/);
      const state = () => page.evaluate(`document.querySelector(".sheen").getAnimations()[0]?.playState`);
      await expect.poll(state).toBe("running");
      // WCAG 2.2.2: the endless sweep stops while the hero holds focus.
      await page.locator(".hero").getByRole("link", { name: "Try the Demo" }).focus();
      await expect.poll(state).toBe("paused");
      await page.evaluate("document.activeElement.blur()");
      await page.evaluate("scrollTo(0, 2500)");
      await expect(sheen).toHaveClass(/is-paused/);
    });

    test("the sheen keeps sweeping under a pointer while the follower loads", async ({ page }) => {
      test.skip(vp.touch, "no hovering pointer");
      await page.route("**/js/sheen-follow.js", async (route) => {
        await new Promise((done) => setTimeout(done, 1500));
        await route.continue();
      });
      await page.goto("/");
      await page.locator(".hero h1").hover();
      await page.waitForTimeout(300);
      expect(await page.evaluate(`document.querySelector(".sheen").getAnimations()[0]?.playState`)).toBe("running");
    });

    test("a hover over the word fades the band to ink and stops the sweep when the follower fails to load", async ({
      page,
    }) => {
      test.skip(vp.touch, "no hovering pointer");
      await page.route("**/js/sheen-follow.js", (route) => route.abort());
      await page.goto("/");
      const state = () => page.evaluate(`document.querySelector(".sheen").getAnimations()[0]?.playState`);
      await page.locator(".sheen").hover();
      await expect.poll(state).toBe("paused");
      await expect
        .poll(() => page.evaluate(`getComputedStyle(document.querySelector(".sheen")).color`))
        .toBe("rgb(30, 30, 28)");
      await page.mouse.move(0, vp.height - 1);
      await expect.poll(state).toBe("running");
    });

    test("a mouse press on a hero link leaves the band sweeping: only keyboard focus fades it", async ({ page }) => {
      test.skip(vp.touch, "no pressing pointer to hold");
      await page.goto("/");
      await page.locator(".hero").getByRole("link", { name: "Try the Demo" }).hover();
      await page.mouse.down();
      await page.waitForTimeout(700);
      expect(await page.evaluate(`getComputedStyle(document.querySelector(".sheen")).color`)).toBe("rgba(0, 0, 0, 0)");
      expect(await page.evaluate(`document.querySelector(".sheen").getAnimations()[0]?.playState`)).toBe("running");
    });

    test("holding focus in the hero fades the band to ink while the sweep stops, and focus leaving fades it back", async ({
      page,
    }) => {
      await page.goto("/");
      await page.evaluate(`(() => {
        const el = document.querySelector(".sheen");
        const out = (window.sheenInk = []);
        const tick = () => {
          const m = getComputedStyle(el).color.match(/^rgba\\(.*,\\s*([\\d.]+)\\)$|\\/\\s*([\\d.]+)\\)$/);
          out.push(m ? parseFloat(m[1] ?? m[2]) : 1);
          requestAnimationFrame(tick);
        };
        tick();
      })()`);
      const alphas = async () => (await page.evaluate("window.sheenInk.splice(0)")) as number[];
      await page.locator(".hero").getByRole("link", { name: "Try the Demo" }).focus();
      await page.waitForTimeout(700);
      const fadeIn = await alphas();
      // Every frame rises toward ink in several steps, never one: the band is not left frozen and visible.
      const steps = (a: number[]) => a.filter((v, i) => i > 0 && v !== a[i - 1]).length;
      expect(Math.min(...fadeIn)).toBeGreaterThanOrEqual(0);
      expect(fadeIn.at(-1)).toBe(1);
      expect(steps(fadeIn)).toBeGreaterThan(3);
      for (const [i, v] of fadeIn.entries()) expect(v, `frame ${i}`).toBeGreaterThanOrEqual(fadeIn[i - 1] ?? 0);
      await page.evaluate("document.activeElement.blur()");
      await page.waitForTimeout(700);
      const fadeOut = await alphas();
      expect(fadeOut.at(-1)).toBe(0);
      expect(steps(fadeOut)).toBeGreaterThan(3);
    });

    test("a pointer entering the word eases the band from its sweep to the pointer, with no jump", async ({ page }) => {
      test.skip(vp.touch, "no hovering pointer");
      await page.goto("/");
      const [left, width, y, em] = (await page.evaluate(`(() => {
        const r = document.querySelector(".sheen").getBoundingClientRect();
        return [r.left, r.width, r.top + r.height / 2, parseFloat(getComputedStyle(document.querySelector(".sheen")).fontSize)];
      })()`)) as [number, number, number, number];
      const tile = 5 * em;
      const x = left + width / 2;
      const sheen = page.locator(".sheen");
      // The first visit fetches the follower and leaves it loaded.
      await expect(async () => {
        await page.mouse.move(x, y);
        await page.mouse.move(x + 2, y);
        await expect(sheen).toHaveClass(/is-following/, { timeout: 250 });
      }).toPass();
      await page.mouse.move(0, vp.height - 1);
      await expect(sheen).not.toHaveClass(/is-following/);
      // The band where the pointer will put it, in px of the tile (the module's own mapping).
      const goal = ((((x - left) / tile - 0.66) % 1) + 1) % 1;
      const wrap = (d: number) => ((((d + tile / 2) % tile) + tile) % tile) - tile / 2;
      const position = () =>
        page.evaluate(
          `parseFloat(getComputedStyle(document.querySelector(".sheen")).backgroundPosition)`,
        ) as Promise<number>;
      // Wait until the sweep has the band far from the pointer, so a jump on entry cannot hide.
      await expect
        .poll(async () => Math.abs(wrap(goal * tile - (await position()))), { timeout: 5000 })
        .toBeGreaterThan(0.3 * tile);
      await page.evaluate(`(() => {
        const out = (window.sheenFrames = []);
        const tick = (now) => {
          out.push([now, parseFloat(getComputedStyle(document.querySelector(".sheen")).backgroundPosition)]);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      })()`);
      await page.waitForTimeout(50);
      const before = await position();
      const gap = Math.abs(wrap(goal * tile - before));
      await page.mouse.move(x, y);
      await page.waitForTimeout(900);
      const frames = (await page.evaluate("window.sheenFrames")) as [number, number][];
      // No frame covers more than part of the way: a teleport covers all of it.
      let moved = 0;
      for (const [i, [t, p]] of frames.entries()) {
        const [t0, p0] = frames[i - 1] ?? [t, p];
        const step = Math.abs(wrap(p - p0));
        moved = Math.max(moved, step);
        expect(step, `frame ${i}`).toBeLessThan(0.6 * gap + 2.5 * em * ((t - t0) / 1000));
      }
      expect(moved).toBeGreaterThan(0);
      expect(Math.abs(wrap(goal * tile - (await position())))).toBeLessThan(2);
    });

    test("a pointer coming back during the leave ramp takes the band from where it is drawn, with no jump", async ({
      page,
    }) => {
      test.skip(vp.touch, "no hovering pointer");
      await page.goto("/");
      const [left, width, y, em] = (await page.evaluate(`(() => {
        const r = document.querySelector(".sheen").getBoundingClientRect();
        return [r.left, r.width, r.top + r.height / 2, parseFloat(getComputedStyle(document.querySelector(".sheen")).fontSize)];
      })()`)) as [number, number, number, number];
      const tile = 5 * em;
      const x = left + width / 2;
      const sheen = page.locator(".sheen");
      await expect(async () => {
        await page.mouse.move(x, y);
        await page.mouse.move(x + 2, y);
        await expect(sheen).toHaveClass(/is-following/, { timeout: 250 });
      }).toPass();
      await page.waitForTimeout(900);
      await page.evaluate(`(() => {
        const out = (window.sheenFrames = []);
        const tick = (now) => {
          out.push([now, parseFloat(getComputedStyle(document.querySelector(".sheen")).backgroundPosition)]);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      })()`);
      await page.mouse.move(0, vp.height - 1);
      // Late in the 300 ms ramp, where it has drawn the band furthest from where the pointer left it.
      await page.waitForTimeout(250);
      await page.mouse.move(x, y);
      await page.waitForTimeout(700);
      const frames = (await page.evaluate("window.sheenFrames")) as [number, number][];
      const wrap = (d: number) => ((((d + tile / 2) % tile) + tile) % tile) - tile / 2;
      expect(frames.length).toBeGreaterThan(10);
      for (const [i, [t, p]] of frames.entries()) {
        const [t0, p0] = frames[i - 1] ?? [t, p];
        const limit = 2.5 * em * ((t - t0) / 1000) * 1.1 + 2;
        expect(Math.abs(wrap(p - p0)), `frame ${i}`).toBeLessThanOrEqual(limit);
      }
    });

    test("the band follows the pointer over the h1 and resumes where it was left, with no jump", async ({ page }) => {
      test.skip(vp.touch, "no hovering pointer");
      await page.goto("/");
      const word = (await page.evaluate(`(() => {
        const r = document.querySelector(".sheen").getBoundingClientRect();
        return [r.left, r.width, r.top + r.height / 2, parseFloat(getComputedStyle(document.querySelector(".sheen")).fontSize)];
      })()`)) as [number, number, number, number];
      const [left, width, y, em] = word;
      const tile = 5 * em;
      const sheen = page.locator(".sheen");
      // The first move over the h1 fetches the follower; the next one starts it.
      await expect(async () => {
        await page.mouse.move(left + width * 0.1, y);
        await page.mouse.move(left + width * 0.12, y);
        await expect(sheen).toHaveClass(/is-following/, { timeout: 250 });
      }).toPass();
      const frame = async () =>
        (await page.evaluate(
          `new Promise((done) => requestAnimationFrame(() => done(parseFloat(getComputedStyle(document.querySelector(".sheen")).backgroundPosition))))`,
        )) as number;
      // Settled: the eased follow (about 120 ms) has landed on the pointer.
      const settled = async () => {
        await page.waitForTimeout(900);
        return frame();
      };
      // The band moves with the pointer, one to one, wrapping at the tile, and trails it: one frame after a
      // step it has covered part of the distance, not all of it.
      const wrap = (d: number) => ((((d + tile / 2) % tile) + tile) % tile) - tile / 2;
      let x = left + width * 0.12;
      let pos = await settled();
      for (const f of [0.25, 0.4, 0.55, 0.7, 0.85]) {
        const nx = left + width * f;
        await page.mouse.move(nx, y);
        const first = await frame();
        expect(Math.abs(wrap(first - pos))).toBeGreaterThan(0);
        expect(Math.abs(wrap(first - pos))).toBeLessThan(0.7 * (nx - x));
        const next = await settled();
        expect(Math.abs(wrap(next - pos - (nx - x)))).toBeLessThan(2);
        [x, pos] = [nx, next];
      }
      // On leave, every frame for 400 ms: no step beyond the sweep's own speed (2.5em a second).
      await page.evaluate(`(() => {
        const out = (window.sheenFrames = []);
        const t0 = performance.now();
        const tick = (now) => {
          out.push([now, parseFloat(getComputedStyle(document.querySelector(".sheen")).backgroundPosition)]);
          if (now - t0 < 700) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      })()`);
      await page.waitForTimeout(100);
      await page.mouse.move(0, vp.height - 1);
      await page.waitForTimeout(800);
      const frames = (await page.evaluate("window.sheenFrames")) as [number, number][];
      expect(frames.length).toBeGreaterThan(10);
      for (const [i, [t, p]] of frames.entries()) {
        const [t0, p0] = frames[i - 1] ?? [t, p];
        const limit = 2.5 * em * ((t - t0) / 1000) * 1.1 + 2;
        expect(Math.abs(wrap(p - p0)), `frame ${i}`).toBeLessThanOrEqual(limit);
      }
      await expect(sheen).not.toHaveClass(/is-following/);
    });

    test("no image drawn under 64 px loads a source over 240 px wide", async ({ page }) => {
      await page.goto("/");
      await page.locator(".frag-list").scrollIntoViewIfNeeded();
      await expect.poll(() => page.evaluate(`[...document.images].every((i) => i.complete)`)).toBe(true);
      const small = (await page.evaluate(`[...document.images]
        .filter((i) => i.getBoundingClientRect().width < 64)
        .map((i) => [i.currentSrc, i.naturalWidth])`)) as [string, number][];
      expect(small.length).toBeGreaterThan(0);
      for (const [src, width] of small) expect(width, src).toBeLessThanOrEqual(240);
    });

    test("the 5 backdrop drifts pause off screen and in a hidden tab", async ({ page }) => {
      await page.goto("/");
      const states = () =>
        page.evaluate(`[...document.querySelectorAll(".frag, .panel, .close-panel")].map((el) =>
          el.getAnimations({ subtree: true }).filter((a) => a.animationName === "drift").map((a) => a.playState).join())`);
      // Below the fold at the top of the page.
      await expect.poll(states).toEqual(["paused", "paused", "paused", "paused", "paused"]);
      await page.locator(".close-panel").scrollIntoViewIfNeeded();
      await expect.poll(async () => ((await states()) as string[]).at(-1)).toBe("running");
      await page.evaluate(`(() => {
        Object.defineProperty(document, "hidden", { value: true, configurable: true });
        document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
      })()`);
      await expect.poll(states).toEqual(["paused", "paused", "paused", "paused", "paused"]);
    });

    test("the Approve still's rows toggle their tick, and Present and Download press without leaving", async ({
      page,
    }) => {
      await page.goto("/");
      const still = page.locator(".step").nth(1).getByRole("group", { name: "Example" });
      const vevox = still.getByRole("button", { name: "Vevox" });
      await expect(vevox).toHaveAttribute("aria-pressed", "false");
      await expect(vevox.locator(".frag-tick")).toBeHidden();
      await vevox.click();
      await expect(vevox).toHaveAttribute("aria-pressed", "true");
      await expect(vevox.locator(".frag-tick")).toBeVisible();
      const dog = still.getByRole("button", { name: "Dog.jpg" });
      await dog.click();
      await expect(dog).toHaveAttribute("aria-pressed", "false");
      const pill = page.locator(".step").nth(2).getByRole("group", { name: "Example" });
      await pill.getByRole("button", { name: "Present" }).click();
      await pill.getByRole("button", { name: "Download" }).click();
      await expect(page).toHaveURL(/\/$/);
      // The deck's tile is its first page, loaded once scrolled near.
      const deck = still.getByRole("button", { name: "Sample deck.pptx" }).locator("img");
      await deck.scrollIntoViewIfNeeded();
      await expect
        .poll(() => deck.evaluate((el) => (el as unknown as { naturalWidth: number }).naturalWidth))
        .toBeGreaterThan(0);
    });

    test("a question opens and closes", async ({ page }) => {
      await page.goto("/");
      const item = page.locator(".faq details").filter({ hasText: "What stays on the room PC?" });
      await item.locator("summary").click();
      await expect(item).toHaveAttribute("open", "");
      await expect(item.getByRole("link", { name: "See what can stay." })).toBeVisible();
      await item.locator("summary").click();
      await expect(item).not.toHaveAttribute("open", "");
    });
  });
}

const WHY =
  "The cloud promised your files would be everywhere. Instead, every room PC asks for your password, and every sign-in opens everything you own, just to show one slide. A USB stick only ever carried what you chose. bloop brings that back, without the stick.";
// Each word's fill, 0 faint to 1 ink, from its background x position (100% faint, 0% ink).
const fills = (page: Page) =>
  page.evaluate(`[...document.querySelectorAll(".why-words > *")].map(
    (w) => 1 - parseFloat(getComputedStyle(w).backgroundPositionX) / 100)`) as Promise<number[]>;
// Scrolls so the paragraph's top sits `progress` of its height above the view's center, plus `px` lower:
// 0 is its top at the center, 1 its bottom at the center (the fill's range).
const scrollWhyTo = (page: Page, progress: number, px = 0) =>
  page.evaluate(`(() => {
    const r = document.querySelector(".why p").getBoundingClientRect();
    scrollBy(0, r.top - (innerHeight / 2 - ${progress} * r.height + ${px}));
  })()`);
const faint = (page: Page) => expect.poll(async () => new Set(await fills(page))).toEqual(new Set([0]));
const ink = (page: Page) => expect.poll(async () => new Set(await fills(page))).toEqual(new Set([1]));

// 844x390: a phone on its side, where the paragraph is taller than half the view.
for (const vp of [VIEWPORTS[0], VIEWPORTS[2], { name: "844x390", width: 844, height: 390, touch: true }]) {
  test.describe(`the why at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.width === 390 });

    test("the words fill in reading order, one at a time, with axe green mid-fill", async ({ page }) => {
      await page.goto("/");
      expect(new Set(await fills(page))).toEqual(new Set([0]));
      // Midway: ink words, then at most one in motion, then faint ones.
      await scrollWhyTo(page, 0.5);
      await expect.poll(async () => (await fills(page))[0]).toBe(1);
      const mid = await fills(page);
      expect(mid.at(-1)).toBe(0);
      expect(mid.filter((f) => f > 0.001 && f < 0.999).length).toBeLessThanOrEqual(1);
      for (let i = 1; i < mid.length; i++) expect(mid[i], `word ${i}`).toBeLessThanOrEqual(mid[i - 1] ?? 1);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await scrollWhyTo(page, 1, -1);
      await ink(page);
    });

    test("the fill starts as the paragraph's top reaches the view's center and ends, in view, as its bottom does", async ({
      page,
    }) => {
      await page.goto("/");
      // From mid-fill back, so the faint read is the timeline's, not the page's first frame.
      await scrollWhyTo(page, 0.5);
      await expect.poll(async () => (await fills(page))[0]).toBe(1);
      await scrollWhyTo(page, 0, 10);
      await faint(page);
      await scrollWhyTo(page, 0, -10);
      await expect.poll(async () => (await fills(page))[0]).toBeGreaterThan(0);
      await scrollWhyTo(page, 1, 10);
      await expect.poll(async () => (await fills(page)).at(-1)).toBeLessThan(1);
      await scrollWhyTo(page, 1, -1);
      await ink(page);
      const bottom = (await page.evaluate(`document.querySelector(".why p").getBoundingClientRect().bottom`)) as number;
      expect(bottom).toBeLessThan(vp.height);
    });

    test("a screen reader reads one sentence", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("region", { name: "Why bloop" })).toMatchAriaSnapshot(
        `- region "Why bloop":\n  - paragraph: ${JSON.stringify(WHY)}`,
      );
    });
  });
}

test.describe("reduced motion", () => {
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

  test("the why is plain ink", async ({ page }) => {
    await page.goto("/");
    const [image, fill, color] = (await page.evaluate(`(() => {
      const c = getComputedStyle(document.querySelector(".why-words > *"));
      return [c.backgroundImage, c.webkitTextFillColor, c.color];
    })()`)) as string[];
    expect(image).toBe("none");
    expect(fill).toBe(color);
  });

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

  test("the phone shows the desktop screenshot in the stage's frame at 16 px, and still tilts", async ({ page }) => {
    await page.goto("/");
    const img = page.locator(".stage img");
    await expect
      .poll(() => img.evaluate((el) => (el as unknown as { currentSrc: string }).currentSrc))
      .toMatch(/\/img\/hero-viewer-(750|1100|1600|2200)\.(avif|webp)$/);
    const style = await page.locator(".stage").evaluate((el) => {
      const c = getComputedStyle(el as unknown as El) as unknown as Record<string, string>;
      return [c.borderRadius, c.overflow, c.boxShadow === "none"];
    });
    expect(style).toEqual(["16px", "hidden", false]);
    // The layout box, not the bounding box: the stage is tilted and scaled while it enters.
    const [w = 0, h = 1] = await img.evaluate((el) => [
      (el as unknown as { offsetWidth: number }).offsetWidth,
      (el as unknown as { offsetHeight: number }).offsetHeight,
    ]);
    expect(Math.abs(w / h - 1440 / 828)).toBeLessThan(0.01);
    await page.locator(".stage").scrollIntoViewIfNeeded();
    expect(
      await page
        .locator(".stage")
        .evaluate((el) => (el as unknown as { getAnimations(): unknown[] }).getAnimations().length),
    ).toBeGreaterThan(0);
  });
});

test.describe("desktop nav", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the logo pill and the links pill center as one pair, 16 to 24 apart", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => document.fonts?.ready);
    const box = (selector: string) =>
      page.locator(selector).evaluate((el) => {
        const r = (el as unknown as El).getBoundingClientRect();
        return { left: r.left, right: r.right };
      });
    const logo = await box(".nav-logo");
    const pill = await box(".nav-pill");
    expect(Math.abs(logo.left - (1440 - pill.right))).toBeLessThanOrEqual(1);
    const gap = pill.left - logo.right;
    expect(gap).toBeGreaterThanOrEqual(16);
    expect(gap).toBeLessThanOrEqual(24);
  });
});

test.describe("phone menu", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the sheet shows within 250 ms of a tap, and its entry animates only transform and opacity, 200 ms or less", async ({
    page,
  }) => {
    await page.goto("/");
    await page.evaluate(`(() => {
      window.__menu = {};
      addEventListener("pointerdown", () => { window.__menu.down = performance.now(); }, { capture: true });
      const sheet = document.getElementById("nav-links");
      const seen = () => {
        if (sheet.matches(":popover-open") && sheet.getBoundingClientRect().height > 0) window.__menu.shown = performance.now();
        else requestAnimationFrame(seen);
      };
      requestAnimationFrame(seen);
    })()`);
    await page.getByRole("button", { name: "Menu" }).tap();
    await expect.poll(() => page.evaluate("window.__menu.shown - window.__menu.down")).toBeLessThan(250);
    await expect(
      page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Privacy" }),
    ).toBeVisible();
    const props = (await page.evaluate(`document.getElementById("nav-links").getAnimations().map((a) => [
      a.transitionProperty ?? "", Number(a.effect.getTiming().duration)])`)) as [string, number][];
    for (const [prop, ms] of props) {
      expect(["opacity", "transform", "display", "overlay"], prop).toContain(prop);
      expect(ms).toBeLessThanOrEqual(200);
    }
  });

  test("the open sheet lays a light scrim over the hero, and a tap on it closes the sheet", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Menu" }).tap();
    await expect(page.locator("#nav-links")).toBeVisible();
    const scrim = await page.evaluate(
      `getComputedStyle(document.getElementById("nav-links"), "::backdrop").backgroundColor`,
    );
    expect(scrim).toBe("rgba(0, 0, 0, 0.18)");
    await page.touchscreen.tap(195, 800);
    await expect(page.locator("#nav-links")).toBeHidden();
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

test.describe("forced colors", () => {
  test.use({ viewport: { width: 1440, height: 900 }, forcedColors: "active" });

  test("glass and pills keep their edge as a border, the links list inside its pill does not", async ({ page }) => {
    await page.goto("/");
    const borders = (await page.evaluate(`(() => {
      const of = (s) => { const c = getComputedStyle(document.querySelector(s)); return c.borderTopWidth + " " + c.borderTopStyle; };
      return [".nav-logo", ".nav-pill", ".hero .btn.primary", ".btn.waitlist", ".frag-list", ".frag-btn", ".group", ".status", ".close-card", ".band-tile", ".nav-links"].map(of);
    })()`)) as string[];
    expect(borders).toEqual([...Array(10).fill("1px solid"), "0px none"]);
    // The band's color may drop; the glyph keeps the system's text color.
    const glyph = page.locator(".band-tile svg").first();
    expect(await glyph.evaluate((el) => getComputedStyle(el as unknown as El).color)).not.toMatch(
      /rgba\(.*, 0\)|transparent/,
    );
  });
});

test.describe("forced colors on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, forcedColors: "active" });

  test("the open menu sheet has a border", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Menu" }).tap();
    await expect(
      page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Privacy" }),
    ).toBeVisible();
    expect(await page.evaluate(`getComputedStyle(document.getElementById("nav-links")).borderTopStyle`)).toBe("solid");
  });
});

test.describe("no popover (Safari 15, 16)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the links show as a row of their own, the dead menu button hides, and a link still works", async ({ page }) => {
    // As those engines parse it: :popover-open is an unknown pseudo-class and the popover attributes mean nothing.
    await page.route(/\/css\/site\.css$/, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replaceAll(":popover-open", ":-x-popover-open") });
    });
    await page.route(/\/$/, async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(" popover>", ">").replace(/ popovertarget="[^"]+"/, "");
      await route.fulfill({ response, body });
    });
    await page.addInitScript(
      `for (const m of ["showPopover", "hidePopover", "togglePopover"]) delete HTMLElement.prototype[m];`,
    );
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("button", { name: "Menu" })).toBeHidden();
    for (const name of ["Features", "Articles", "Privacy", "Waitlist"])
      await expect(nav.getByRole("link", { name })).toBeVisible();
    // The row sits under the pills, inside the view, and scrolls itself rather than the page.
    const [pillBottom, rowTop, rowLeft, rowRight, scrollWidth] = (await page.evaluate(`(() => {
      const pill = document.querySelector(".nav-pill").getBoundingClientRect();
      const row = document.getElementById("nav-links").getBoundingClientRect();
      return [pill.bottom, row.top, row.left, row.right, document.documentElement.scrollWidth];
    })()`)) as number[];
    expect(rowTop).toBeGreaterThan(pillBottom ?? 0);
    // As wide as the nav row (10 in from each side), not boxed inside the links pill.
    expect(Math.round(rowLeft ?? 0)).toBe(10);
    expect(Math.round(rowRight ?? 0)).toBe(380);
    expect(scrollWidth).toBeLessThanOrEqual(390);
    // Solid glass on the row and the links pill, with no backdrop filter, scrolled or not.
    const fills = `["nav-links", "nav-pill"].map((c) => getComputedStyle(document.querySelector("." + c)).backgroundColor)`;
    expect(await page.evaluate(fills)).toEqual(["rgba(255, 255, 255, 0.92)", "rgba(255, 255, 255, 0.92)"]);
    await nav.getByRole("link", { name: "Features" }).click();
    await expect(page.locator("#features h2")).toBeInViewport();
    await expect(page.locator(".nav")).toHaveClass(/is-scrolled/);
    expect(await page.evaluate(fills)).toEqual(["rgba(255, 255, 255, 0.92)", "rgba(255, 255, 255, 0.92)"]);
    expect(errors).toEqual([]);
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
