import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A browser module: the Worker and test tsconfigs have no DOM, so it loads by a variable specifier.
const MODULE = "../../public/js/sheen-follow.js";
const {
  offsetAt,
  timeAt,
  easeTo,
}: {
  offsetAt: (x: number, width: number, em: number) => number;
  timeAt: (o: number) => number;
  easeTo: (from: number, to: number, dt: number) => number;
} = await import(MODULE);

/** Steps a follow of `to` from `from` at a frame rate for some ms. */
function run(from: number, to: number, fps: number, ms: number) {
  let x = from;
  for (let t = 0; t < ms - 1e-9; t += 1000 / fps) x = easeTo(x, to, 1000 / fps);
  return x;
}

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

  describe("the eased follow", () => {
    it("reaches the same x at the same time at 30, 60 and 120 fps", () => {
      for (const ms of [100, 200, 500]) {
        const at60 = run(0, 300, 60, ms);
        expect(Math.abs(run(0, 300, 120, ms) - at60)).toBeLessThan(0.01);
        expect(Math.abs(run(0, 300, 30, ms) - at60)).toBeLessThan(0.01);
      }
    });

    it("lags the pointer instead of jumping to it, then converges under half a pixel", () => {
      const first = easeTo(0, 300, 1000 / 60);
      expect(first).toBeGreaterThan(0);
      expect(first).toBeLessThan(60);
      expect(run(0, 300, 60, 100)).toBeLessThan(300 - 100);
      expect(300 - run(0, 300, 60, 1500)).toBeLessThan(0.5);
    });

    it("moves toward the pointer from either side and never overshoots", () => {
      for (const [from, to] of [
        [0, 300],
        [300, 0],
      ] as [number, number][]) {
        let x = from;
        for (let i = 0; i < 200; i++) {
          const next = easeTo(x, to, 16);
          expect(Math.abs(to - next)).toBeLessThanOrEqual(Math.abs(to - x));
          x = next;
        }
      }
    });

    it("a negative or stalled frame gap neither reverses nor leaps", () => {
      expect(easeTo(10, 100, -5)).toBe(10);
      expect(easeTo(10, 100, 5000)).toBe(easeTo(10, 100, 64));
    });
  });
});
