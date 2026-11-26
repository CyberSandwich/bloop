// Another item cross-fades in over the last, on the screen's stage and the phone remote's preview (design.md section
// 8): 200 ms of opacity on --ease-out, the new item decoded first; a page turn and reduced motion swap at once. Every
// frame is sampled, so a blank frame or an undecoded first frame fails. CI only.
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { atRest, heading, oneDevice, PHONE, pick } from "./one-device.ts";

type Part = {
	inert: boolean;
	opacity: number;
	area: number;
	decoded: boolean;
	timing: string[];
};

/** Samples the item parts under `root` every frame until the returned stop; hands back one entry a frame. */
async function sample(
	page: Page,
	root: string,
): Promise<() => Promise<Part[][]>> {
	// A string: the node tsconfig has no DOM types. JSON-quoted, so the selector is data.
	await page.evaluate(`(() => {
    window.sampled = [];
    const tick = () => {
      const parts = [...(document.querySelector(${JSON.stringify(root)})?.children ?? [])].filter((n) =>
        n.matches("picture, canvas, video, .item-card, .stand-in"));
      window.sampled.push(parts.map((n) => {
        const face = n.localName === "picture" ? n.querySelector("img") : n;
        const box = face.getBoundingClientRect();
        return {
          inert: n.inert,
          opacity: Number(getComputedStyle(face).opacity),
          area: box.width * box.height,
          decoded: !(face instanceof HTMLImageElement) || (face.complete && face.naturalWidth > 0),
          timing: face.getAnimations().map((a) => a.effect.getTiming().duration + " " + a.effect.getTiming().easing),
        };
      }));
      window.sampling = requestAnimationFrame(tick);
    };
    tick();
  })()`);
	return async () =>
		(await page.evaluate(
			"(() => { cancelAnimationFrame(window.sampling); return window.sampled; })()",
		)) as Part[][];
}

const easeOut = async (page: Page) =>
	(await page.evaluate(
		'getComputedStyle(document.documentElement).getPropertyValue("--ease-out").trim()',
	)) as string;

/** Long enough that a fade, had one started, would show in the sample. */
const pastFade = (page: Page) => page.waitForTimeout(400);

/** Until the sample holds a cross-fade run to its end: two items seen, then one left and no 200 ms fade running. */
const faded = (page: Page, root: string) =>
	expect
		.poll(() =>
			page.evaluate(`(() => {
        const r = document.querySelector(${JSON.stringify(root)});
        const one = [...r.children].filter((n) => n.matches("picture, canvas, video, .item-card, .stand-in")).length === 1;
        const running = r.getAnimations({ subtree: true }).some((a) => a.effect.getTiming().duration === 200);
        return window.sampled.some((f) => f.length === 2) && one && !running;
      })()`),
		)
		.toBe(true);

/** The change cross-faded: both items in one frame, the new one mid-fade on the token, never a blank frame. */
async function expectCrossfade(page: Page, frames: Part[][]) {
	const timing = `200 ${await easeOut(page)}`;
	expect(
		frames.some((f) => f.length === 2 && f.filter((p) => p.inert).length === 1),
	).toBe(true);
	expect(
		frames.some((f) =>
			f.some((p) => !p.inert && p.opacity > 0.05 && p.opacity < 0.95),
		),
	).toBe(true);
	expect(
		frames.some((f) => f.some((p) => !p.inert && p.timing.includes(timing))),
	).toBe(true);
	expect(
		frames.filter((f) => !f.some((p) => p.area > 0 && p.opacity >= 0.5)).length,
		"a blank frame",
	).toBe(0);
	expect(
		frames.filter((f) => f.some((p) => !p.inert && !p.decoded)).length,
		"an undecoded first frame",
	).toBe(0);
	expect(frames.at(-1)?.length, "the last item left at the end").toBe(1);
}

/** The swap was at once: one item a frame, no animation on it. */
function expectSwap(frames: Part[][]) {
	expect(frames.length).toBeGreaterThan(5);
	expect(
		frames.filter((f) => f.length !== 1 || f.some((p) => p.timing.length > 0)),
	).toEqual([]);
}

test.describe("the screen's stage", () => {
	test.use(PHONE);

	test("an item change cross-fades on --ease-out with no blank frame; a page turn and reduced motion swap at once", async ({
		page,
	}) => {
		await oneDevice(page);
		await atRest(page.locator("main"));

		let stop = await sample(page, "#frame");
		await pick(page, "Sample deck.pptx");
		await faded(page, "#frame");
		await expectCrossfade(page, await stop());

		await atRest(page.locator("main"));
		stop = await sample(page, "#frame");
		await page.locator("#next").tap();
		await expect(page.locator("#dots")).toHaveText("2 / 2");
		await pastFade(page);
		expectSwap(await stop());

		await page.emulateMedia({ reducedMotion: "reduce" });
		stop = await sample(page, "#frame");
		await pick(page, "Dog.jpg");
		await pastFade(page);
		expectSwap(await stop());
	});
});

test.describe("the phone remote's preview", () => {
	let contexts: BrowserContext[] = [];
	test.afterEach(async () => {
		for (const c of contexts) await c.close();
		contexts = [];
	});

	test("an item change cross-fades with no blank frame; a page turn and reduced motion swap at once", async ({
		browser,
	}) => {
		const screenContext = await browser.newContext({
			viewport: { width: 1440, height: 900 },
		});
		const phoneContext = await browser.newContext(PHONE);
		contexts = [screenContext, phoneContext];
		const screen = await screenContext.newPage();
		await screen.goto("/s?mode=demo");
		await expect(screen.locator("#qr-panel")).not.toHaveClass(
			/\bis-swapping\b/,
		);
		await expect(screen.locator("#typed-code")).toHaveText(
			/^[A-Z0-9]{3} [A-Z0-9]{3}$/,
		);
		const code = (
			(await screen.locator("#typed-code").textContent()) ?? ""
		).replace(/\s/g, "");
		const phone = await phoneContext.newPage();
		await phone.goto(`/a?c=${code}`);
		await phone.getByRole("button", { name: /^Approve/ }).tap();
		await expect(heading(screen)).toHaveText("Dog.jpg");
		const row = (name: string) =>
			phone
				.locator("#file-list")
				.getByRole("button", {
					name: new RegExp(`^${name.replace(".", "\\.")}`),
				});
		const preview = phone.locator(".preview");

		await row("Sample deck.pptx").tap();
		await expect(preview).toHaveAttribute(
			"aria-label",
			"Sample deck.pptx, Slide 1 of 2",
		);
		// The label is set at once; the first page lands after it decodes. A later tap before that has no last to fade.
		await expect(preview.locator("picture")).toHaveCount(1);
		await atRest(preview);

		let stop = await sample(phone, ".preview");
		await row("Sample deck.pdf").tap();
		await expect(preview).toHaveAttribute(
			"aria-label",
			"Sample deck.pdf, Page 1 of 2",
		);
		await faded(phone, ".preview");
		await expectCrossfade(phone, await stop());

		stop = await sample(phone, ".preview");
		await phone.locator(".bubbles [data-step='1']").tap();
		await expect(preview).toHaveAttribute(
			"aria-label",
			"Sample deck.pdf, Page 2 of 2",
		);
		await pastFade(phone);
		expectSwap(await stop());

		await phone.emulateMedia({ reducedMotion: "reduce" });
		stop = await sample(phone, ".preview");
		await row("Sample deck.pptx").tap();
		await expect(preview).toHaveAttribute(
			"aria-label",
			/^Sample deck\.pptx, Slide/,
		);
		await pastFade(phone);
		expectSwap(await stop());
	});
});
