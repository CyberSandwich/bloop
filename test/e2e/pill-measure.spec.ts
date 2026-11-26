// Throwaway: measures the screen pill's boxes. Fails on purpose so the numbers land in the CI error output.
import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { expect, type Page, test } from "@playwright/test";
import { heading, open, SCREEN, typedCodeOf } from "./pairing.ts";

function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(Buffer.alloc((width + 1) * height))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const MEASURE = `(() => {
  const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map((n) => Math.round(n * 10) / 10); };
  const cs = (e, ...p) => { const s = getComputedStyle(e); return Object.fromEntries(p.map((k) => [k, s[k]])); };
  const q = (s) => document.querySelector(s);
  const pill = q("#controls");
  const ids = ["b-present", "b-continue", "b-open", "b-download", "b-pdf", "b-waitlist"];
  return {
    vw: innerWidth,
    pane: r(q("#pane")), paneCs: cs(q("#pane"), "paddingLeft", "paddingRight", "width"),
    pill: r(pill), pillCs: cs(pill, "left", "transform", "position", "paddingLeft", "paddingRight", "display"),
    pillStyle: pill.getAttribute("style"),
    dots: r(q("#dots")), dotsHidden: q("#dots").hidden, dotsDisplay: getComputedStyle(q("#dots")).display,
    dotsText: q("#dots").textContent,
    dotsAnims: q("#dots").getAnimations().map((a) => [a.playState, a.effect && a.effect.getComputedTiming().endTime]),
    buttons: Object.fromEntries(ids.map((i) => [i, { box: r(q("#" + i)), hidden: q("#" + i).hidden, display: getComputedStyle(q("#" + i)).display }])),
    rail: r(q("#side")), railCs: cs(q("#side"), "display", "position"), railHidden: q("#side").hidden,
    items: r(q("#items")), handle: r(q("#handle")),
    media: r(q("#frame :is(picture img, canvas, video, .item-card)")),
    frame: r(q("#frame")), view: r(q("#view")),
    bodyClass: document.body.className,
  };
})()`;

const SETTLED = `(() => {
  const p = document.getElementById("controls");
  return !p.getAnimations({ subtree: true }).some((a) => a.effect?.getComputedTiming().endTime !== Infinity);
})()`;

async function measure(page: Page, label: string) {
  await expect.poll(() => page.evaluate(SETTLED)).toBe(true);
  await page.waitForTimeout(800);
  await expect.poll(() => page.evaluate(SETTLED)).toBe(true);
  return { label, ...((await page.evaluate(MEASURE)) as object) };
}

async function approveStart(browser: Parameters<typeof open>[0]) {
  const screen = await open(browser, "screen", "/s?mode=demo");
  await expect(heading(screen.page)).toHaveText("Demo Room");
  const code = await typedCodeOf(screen.page);
  const phone = await open(browser, "phone", `/a?c=${code}`);
  await expect(phone.page.getByRole("button", { name: "Approve" })).toBeEnabled();
  return { screen, phone };
}

for (const width of [SCREEN.width, 390]) {
  test(`pill measure at ${width}`, async ({ browser }) => {
    const out: object[] = [];
    const height = width === SCREEN.width ? SCREEN.height : 844;

    // multi-item: the demo catalog
    {
      const { screen, phone } = await approveStart(browser);
      await screen.page.setViewportSize({ width, height });
      await phone.page.getByRole("button", { name: "Approve" }).click();
      await expect(screen.page.locator("#items > li .item")).toHaveCount(4);
      await expect(screen.page.getByRole("img", { name: "Dog.jpg" })).toBeVisible();
      out.push(await measure(screen.page, `multi ${width}`));
      await screen.page.evaluate(
        `[...document.querySelectorAll("#items .item")].find((b) => b.textContent.startsWith("Sample deck.pdf")).click()`,
      );
      await screen.page.waitForTimeout(1500);
      await screen.page
        .locator("#dots")
        .waitFor({ state: "visible", timeout: 30000 })
        .catch(() => undefined);
      out.push(await measure(screen.page, `pdf ${width}`));
      await screen.context.close();
      await phone.context.close();
    }

    // single guest photo, then single guest file card
    const guests: [string, Buffer | string][] = [
      ["Board.png", png(1200, 800)],
      ["sample-deck.pptx", readFileSync("test/fixtures/decks/sample-deck.pptx")],
    ];
    for (const [name, bytes] of guests) {
      const { screen, phone } = await approveStart(browser);
      await screen.page.setViewportSize({ width, height });
      const status = await phone.page.evaluate(
        async ([n, b]) => {
          const g = globalThis as unknown as {
            localStorage: { getItem(k: string): string | null };
            fetch: (u: string, i: object) => Promise<{ status: number }>;
          };
          const res = await g.fetch("/api/drop", {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${g.localStorage.getItem("bloop.pid")}`,
              "Content-Type": "application/octet-stream",
              "X-Bloop-Name": encodeURIComponent(n as string),
            },
            body: new Uint8Array(b as number[]),
          });
          return res.status;
        },
        [name, [...(bytes as Buffer)]] as const,
      );
      expect(status).toBe(200);
      await expect(heading(screen.page)).toHaveText("Sent by a Guest");
      await screen.page.getByRole("button", { name: "Open" }).click();
      await expect(heading(screen.page)).toHaveText(name);
      if (name.endsWith(".png")) await expect(screen.page.getByRole("img", { name })).toBeVisible();
      out.push(await measure(screen.page, `guest ${name} ${width}`));
      await screen.context.close();
      await phone.context.close();
    }

    const json = JSON.stringify(out);
    console.log(`PILLM ${json}`);
    throw new Error(`PILLM ${json}`);
  });
}
