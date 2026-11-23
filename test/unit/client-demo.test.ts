import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nextSlide, openTarget, SLIDES } from "../../public/js/core/demo.js";

const ORIGIN = "https://bloop.example";

describe("DEMO-01 the demo screen's own open", () => {
  it("fetches the link PowerPoint would have fetched, on this origin only", () => {
    const url = `${ORIGIN}/f/abc/Sample-deck.pptx`;
    expect(openTarget(`ms-powerpoint:ofv|u|${url}`, ORIGIN)).toBe(url);
    expect(openTarget(url, ORIGIN)).toBe(url);
    expect(openTarget("ms-powerpoint:ofv|u|https://evil.example/f/abc/x.pptx", ORIGIN)).toBeNull();
    expect(openTarget("https://evil.example/f/abc/x.pdf", ORIGIN)).toBeNull();
    expect(openTarget("not a url", ORIGIN)).toBeNull();
  });

  it("steps through the slides without running past either end", () => {
    expect(nextSlide(0, 1)).toBe(1);
    expect(nextSlide(SLIDES.length - 1, 1)).toBe(SLIDES.length - 1);
    expect(nextSlide(0, -1)).toBe(0);
    expect(nextSlide(1, -1)).toBe(0);
  });

  it("every sample slide is served same-origin as AVIF and WebP (tools/render-slides.py)", () => {
    expect(SLIDES.length).toBeGreaterThan(1);
    for (const base of SLIDES) {
      expect(base).toMatch(/^\/img\/[a-z0-9-]+$/);
      for (const ext of ["avif", "webp"]) expect(existsSync(`public${base}.${ext}`), `${base}.${ext}`).toBe(true);
    }
  });
});
