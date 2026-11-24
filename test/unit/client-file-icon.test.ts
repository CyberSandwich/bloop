import { describe, expect, it } from "vitest";
import { countdown, hostOf, itemIcon, itemLine, itemName } from "../../public/js/core/format.js";
import type { Item } from "../../src/shared/protocol.ts";

const file = (name: string, type: "pptx" | "pdf" | "jpg" | "png" | "webp", size: number | null = null): Item => ({
  kind: "file",
  id: name,
  name,
  type,
  size,
});
const link: Item = { kind: "link", id: "t1", url: "https://www.vevox.com/join", title: "Vevox" };

describe("item row tile", () => {
  it("uses slides for decks, a document for PDFs, a picture for every image type and a link glyph for links", () => {
    const slides = itemIcon(file("Lecture 4.pptx", "pptx"));
    const doc = itemIcon(file("Handout.pdf", "pdf"));
    const picture = itemIcon(file("Dog.jpg", "jpg"));
    expect(new Set([slides, doc, picture, itemIcon(link)]).size).toBe(4);
    expect(itemIcon(file("a.png", "png"))).toBe(picture);
    expect(itemIcon(file("a.webp", "webp"))).toBe(picture);
  });
});

describe("item row lines", () => {
  it("line 2 is the kind, then the size when there are bytes, then a date only when given", () => {
    expect(itemLine(file("Lecture 4.pptx", "pptx", 81_196))).toBe("PowerPoint · 79 KB");
    expect(itemLine(file("Handout.pdf", "pdf"))).toBe("PDF");
    expect(itemLine(file("Dog.jpg", "jpg", 70_000), "Edited 10 min ago")).toBe(
      "JPEG image · 68 KB · Edited 10 min ago",
    );
    expect(itemLine(file("a.png", "png"))).toBe("PNG image");
    expect(itemLine(file("a.webp", "webp"))).toBe("WebP image");
  });

  it("a link reads Link and its host, named by its title", () => {
    expect(itemLine(link)).toBe("Link · vevox.com");
    expect(itemName(link)).toBe("Vevox");
    expect(itemName(file("Dog.jpg", "jpg"))).toBe("Dog.jpg");
  });

  it("the host drops www. and is empty for a URL that does not parse", () => {
    expect(hostOf("https://www.vevox.com/x")).toBe("vevox.com");
    expect(hostOf("https://app.example.org")).toBe("app.example.org");
    expect(hostOf("not a url")).toBe("");
  });
});

describe("the phone's countdown", () => {
  it.each([
    [59 * 60_000 + 12_000, "59:12"],
    [65_000, "1:05"],
    [90 * 60_000, "90:00"],
    [400, "0:01"],
    [0, "0:00"],
    [-5000, "0:00"],
  ])("%d ms left reads %s", (ms, text) => {
    expect(countdown(ms)).toBe(text);
  });
});
