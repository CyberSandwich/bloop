import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A browser module: the Worker and test tsconfigs have no DOM, so it loads by a variable specifier.
const MODULE = "../../public/js/sheen-follow.js";
const {
  offsetAt,
  timeAt,
}: { offsetAt: (x: number, width: number, em: number) => number; timeAt: (o: number) => number } = await import(MODULE);

const css = readFileSync("public/css/site.css", "utf8");
const source = readFileSync("public/js/sheen-follow.js", "utf8");
const TILE = 5;
const SWEEP_MS = 2000;
const WORD = 440;
const EM = 100;

/** Where the sweep's keyframe has the tile at a time: one tile per sweep, from the first frame. */
const sweepOffsetAt = (ms: number) => (ms % SWEEP_MS) / SWEEP_MS;

describe("the sheen follows the pointer (design.md section 8)", () => {
  it("the module's constants are the stylesheet's: a 5em tile, a 2 s sweep, the band's core at 66%", () => {
    expect(source).toMatch(/const TILE_EM = 5;/);
    expect(source).toMatch(/const SWEEP_MS = 2000;/);
    expect(source).toMatch(/const BAND = 0\.66;/);
    expect(css).toMatch(/var\(--robin\) 66%/);
    expect(css).toMatch(/0 0 \/ 5em 100% repeat-x/);
    expect(css).toMatch(/animation: sweep 2s linear/);
    expect(css).toMatch(/calc\(var\(--sheen-x\) \* 5em\) 0/);
  });

  it.each([0, 40, 123, 220, 301, 440])("puts a band's center under the pointer at x = %d", (x) => {
    const offset = offsetAt(x, WORD, EM);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThan(1);
    // The band's center in the tile is 66% along; tiles repeat every 5em.
    const center = (offset + 0.66) * TILE * EM;
    const gap = (center - x) / (TILE * EM);
    expect(Math.abs(gap - Math.round(gap))).toBeLessThan(1e-9);
  });

  it("moves with the pointer: a longer x is a later band position, until the wrap", () => {
    const a = offsetAt(100, WORD, EM);
    const b = offsetAt(150, WORD, EM);
    expect(b - a).toBeCloseTo(50 / (TILE * EM), 9);
  });

  it("keeps the band over the word when the pointer is on the h1 beside it", () => {
    expect(offsetAt(-300, WORD, EM)).toBe(offsetAt(0, WORD, EM));
    expect(offsetAt(WORD + 300, WORD, EM)).toBe(offsetAt(WORD, WORD, EM));
  });

  it.each([0, 0.1, 0.34, 0.66, 0.999])("resumes at the paused offset %d: frame 0 of the sweep equals it", (offset) => {
    // A negative animation-delay of timeAt(offset) starts the keyframe at that time.
    expect(sweepOffsetAt(timeAt(offset))).toBeCloseTo(offset, 12);
  });

  it("a sweep from any pointer position resumes where the pointer left it", () => {
    for (let x = 0; x <= WORD; x += 11) {
      const paused = offsetAt(x, WORD, EM);
      expect(sweepOffsetAt(timeAt(paused))).toBeCloseTo(paused, 12);
    }
  });
});
