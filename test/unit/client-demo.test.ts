import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  halves,
  openTarget,
  PHOTO_THUMB,
  pageMode,
  pagesOf,
  placeControls,
  SLIDES,
  stepPage,
  thumbOf,
} from "../../public/js/core/demo.js";
import { orderItems } from "../../public/js/shared/session.js";
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
    expect(orderItems(items).map((i) => (i.kind === "file" ? i.name : i.title))).toEqual([
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

  it("the tap zones are the slide box's two halves, never the paper beside it", () => {
    expect(halves({ left: 65, top: 0, width: 926, height: 579 })).toEqual([
      { left: 65, top: 0, width: 463, height: 579 },
      { left: 528, top: 0, width: 463, height: 579 },
    ]);
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

  describe("the control pill goes where the item shows widest", () => {
    // A column 140 wide (156 with its gap) and 112 tall, a 60 pill (76 with its gap) under.
    const at = { reserve: 156, gap: 76, stack: 112 };
    const where = (ratio: number, w: number, h: number, listFits: boolean) =>
      placeControls(ratio, w, h, { ...at, listFits });

    it("under the list when that gives the item the whole stage", () => {
      expect(where(1.5, 1072, 780, true)).toBe("list");
      expect(where(1.6, 1072, 603, true)).toBe("list");
    });

    it("on the item's right when the list is not there, or the item is height-bound enough to tie", () => {
      expect(where(2 / 3, 1072, 603, false)).toBe("right");
      expect(where(2 / 3, 1072, 780, true)).toBe("right");
      // Height-bound, a stack on its right costs it nothing: it ties the list's, and the attached one wins.
      expect(where(1.5, 1000, 400, true)).toBe("right");
    });

    it("under the item for a wide one on a tall or roomy stage", () => {
      expect(where(1.6, 466, 880, false)).toBe("below");
      expect(where(1.6, 912, 600, false)).toBe("below");
      expect(where(1.6, 834, 1194, true)).toBe("below");
    });

    it("a phone keeps it under for a portrait image too: a column would cost more width than the pill costs height", () => {
      expect(where(2 / 3, 342, 600, false)).toBe("below");
    });

    it("a column taller than the item never goes on its right; nothing fitting keeps it under", () => {
      expect(where(4, 1000, 90, false)).toBe("below");
      expect(where(1, 40, 40, false)).toBe("below");
    });
  });
});
