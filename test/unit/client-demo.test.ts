import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openTarget, PHOTO_THUMB, pageMode, pagesOf, SLIDES, stepPage, thumbOf } from "../../public/js/core/demo.js";
import { inItemOrder } from "../../public/js/core/states.js";
import type { Item } from "../../src/shared/protocol.ts";

const ORIGIN = "https://bloop.example";
const deck: Item = { kind: "file", name: "Sample deck.pptx", type: "pptx", size: 82_000 };
const pdf: Item = { kind: "file", name: "Sample deck.pdf", type: "pdf", size: 83_000 };
const photo: Item = { kind: "file", name: "Dog.jpg", type: "jpg", size: 70_000 };
const link: Item = { kind: "link", url: "https://www.vevox.com/", title: "Vevox" };
const demo = { mode: "demo", kind: "owner" } as const;

describe("one list order", () => {
  it("files by name, then links by title, as the machine orders the approved items", () => {
    const items: Item[] = [
      { kind: "link", url: "https://www.vevox.com/", title: "Vevox" },
      { kind: "file", name: "Sample deck.pptx", type: "pptx", size: 1 },
      { kind: "file", name: "Dog.jpg", type: "jpg", size: 1 },
      { kind: "file", name: "Sample deck.pdf", type: "pdf", size: 1 },
    ];
    expect(inItemOrder(items).map((i) => (i.kind === "file" ? i.name : i.title))).toEqual([
      "Dog.jpg",
      "Sample deck.pdf",
      "Sample deck.pptx",
      "Vevox",
    ]);
  });
});

describe("DEMO-01 the demo screen's own open", () => {
  it("fetches the link PowerPoint would have fetched, on this origin only", () => {
    const url = `${ORIGIN}/f/abc/Sample-deck.pptx`;
    expect(openTarget(`ms-powerpoint:ofv|u|${url}`, ORIGIN)).toBe(url);
    expect(openTarget(url, ORIGIN)).toBe(url);
    expect(openTarget("ms-powerpoint:ofv|u|https://evil.example/f/abc/x.pptx", ORIGIN)).toBeNull();
    expect(openTarget("https://evil.example/f/abc/x.pdf", ORIGIN)).toBeNull();
    expect(openTarget("not a url", ORIGIN)).toBeNull();
  });

  it("steps through the pages without running past either end", () => {
    expect(stepPage(0, 1, 2)).toBe(1);
    expect(stepPage(1, 1, 2)).toBe(1);
    expect(stepPage(0, -1, 2)).toBe(0);
    expect(stepPage(1, -1, 2)).toBe(0);
    expect(stepPage(0, 1, 1)).toBe(0);
  });

  it("every sample page is served same-origin as AVIF and WebP (tools/render-slides.py)", () => {
    expect(SLIDES.length).toBeGreaterThan(1);
    for (const base of SLIDES) {
      expect(base).toMatch(/^\/img\/[a-z0-9-]+$/);
      for (const ext of ["avif", "webp"]) expect(existsSync(`public${base}.${ext}`), `${base}.${ext}`).toBe(true);
    }
    expect(existsSync(`public${PHOTO_THUMB}`)).toBe(true);
  });
});

describe("DEMO-01 what the viewer shows per item", () => {
  it("the demo account's deck and its PDF export show the same pre-rendered pages", () => {
    expect(pagesOf(deck, demo)).toBe(SLIDES);
    expect(pagesOf(pdf, demo)).toBe(SLIDES);
  });

  it("a photo, a link, a guest's own file and anything live have no pages", () => {
    expect(pagesOf(photo, demo)).toBeNull();
    expect(pagesOf(link, demo)).toBeNull();
    expect(pagesOf(deck, { mode: "demo", kind: "guest" })).toBeNull();
    expect(pagesOf(deck, { mode: "live", kind: "owner" })).toBeNull();
  });

  it("thumbnails are page 1 and the photo's own; a link and a guest file get the type tile", () => {
    expect(thumbOf(deck, demo)).toBe(`${SLIDES[0]}.webp`);
    expect(thumbOf(pdf, demo)).toBe(`${SLIDES[0]}.webp`);
    expect(thumbOf(photo, demo)).toBe(PHOTO_THUMB);
    expect(thumbOf(link, demo)).toBeNull();
    expect(thumbOf(deck, { mode: "demo", kind: "guest" })).toBeNull();
    expect(thumbOf(photo, { mode: "live", kind: "owner" })).toBeNull();
  });

  it("a portrait document (an A4 page) scrolls as one column; landscape slides page one at a time", () => {
    expect(pageMode(1240, 1754)).toBe("scroll");
    expect(pageMode(1920, 1200)).toBe("paged");
    expect(pageMode(1000, 1000)).toBe("paged");
  });
});
