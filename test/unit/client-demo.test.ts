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
const deck: Item = { kind: "file", id: "t1", name: "Sample deck.pptx", type: "pptx", size: 82_000 };
const pdf: Item = { kind: "file", id: "t2", name: "Sample deck.pdf", type: "pdf", size: 83_000 };
const photo: Item = { kind: "file", id: "t3", name: "Dog.jpg", type: "jpg", size: 70_000 };
const link: Item = { kind: "link", id: "t4", url: "https://www.vevox.com/", title: "Vevox" };
const demo = { mode: "demo", kind: "owner" } as const;

describe("one list order", () => {
  it("files by name, then links by title, as the machine orders the approved items", () => {
    const items: Item[] = [
      { kind: "link", id: "t5", url: "https://www.vevox.com/", title: "Vevox" },
      { kind: "file", id: "t6", name: "Sample deck.pptx", type: "pptx", size: 1 },
      { kind: "file", id: "t7", name: "Dog.jpg", type: "jpg", size: 1 },
      { kind: "file", id: "t8", name: "Sample deck.pdf", type: "pdf", size: 1 },
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

  describe("the controls take the first free spot: under the item, at the stage's bottom right, under the list, floating", () => {
    // A 60 pill, a column 140 wide and 112 tall, an inset of 12.
    const need = { pill: 60, stackW: 140, stackH: 112, inset: 12 };
    /** The item as it fills a stage: by its ratio. */
    const where = (ratio: number, w: number, h: number, rail: boolean) => {
      const iw = Math.min(w, h * ratio);
      return placeControls({ w: iw, h: iw / ratio }, { w, h }, { ...need, rail });
    };

    it("1 under the item, when the slack above and below it holds the pill and its inset", () => {
      // 1440 x 900: the stage is 1072 x 876, the wide photo 1072 x 715; 161 spare >= 72.
      expect(where(1.5, 1072, 876, false)).toBe("under");
      expect(where(1.6, 912, 700, false)).toBe("under");
      // The slack is exactly the pill plus the inset.
      expect(placeControls({ w: 100, h: 528 }, { w: 100, h: 600 }, { ...need, rail: false })).toBe("under");
    });

    it("2 at the bottom right, for a tall item whose side slack holds the column", () => {
      // 600 x 900 in 1072 x 876: 584 wide, 244 each side >= 152.
      expect(where(2 / 3, 1072, 876, false)).toBe("right");
      expect(where(2 / 3, 1072, 876, true)).toBe("right");
    });

    it("3 under the list, when neither slack holds it and the rail has room", () => {
      // 1000 x 575: the stage is 632 x 455, the 3:2 photo 632 x 421: 34 spare, and no side slack.
      expect(where(1.5, 632, 455, true)).toBe("rail");
    });

    it("4 floating over the item, when the list is full", () => {
      expect(where(1.5, 632, 455, false)).toBe("float");
    });

    it("a slack one pixel short falls to the next spot", () => {
      expect(placeControls({ w: 100, h: 529 }, { w: 100, h: 600 }, { ...need, rail: false })).toBe("float");
      expect(placeControls({ w: 100, h: 529 }, { w: 100, h: 600 }, { ...need, rail: true })).toBe("rail");
      expect(placeControls({ w: 100, h: 600 }, { w: 100 + 2 * 151.9, h: 600 }, { ...need, rail: true })).toBe("rail");
    });

    it("a column taller than the stage never goes on the right", () => {
      expect(placeControls({ w: 40, h: 90 }, { w: 1000, h: 90 }, { ...need, rail: false })).toBe("float");
    });
  });
});
