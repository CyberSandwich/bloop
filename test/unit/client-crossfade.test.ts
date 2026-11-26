// core/crossfade.js over fake nodes: what fades, what leaves, and when the preview swaps at once.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Loaded by path: the module is browser JS outside the node tsconfig. */
const CROSSFADE = "../../public/js/core/crossfade.js";

class Fake {
  inert = false;
  style: Record<string, string> = {};
  gone = false;
  runs: { keyframes: unknown; timing: { duration: number; easing: string }; cancelled: boolean }[] = [];
  kids: Fake[] = [];
  constructor(readonly localName: string) {}
  querySelector(sel: string) {
    return this.kids.find((k) => k.localName === sel) ?? null;
  }
  getAnimations() {
    return this.runs.filter((r) => !r.cancelled).map((r) => ({ cancel: () => (r.cancelled = true) }));
  }
  animate(keyframes: unknown, timing: { duration: number; easing: string }) {
    this.runs.push({ keyframes, timing, cancelled: false });
    return { finished: Promise.resolve() };
  }
  remove() {
    this.gone = true;
  }
  decode() {
    return Promise.resolve();
  }
  replaceChildren(...kids: Fake[]) {
    this.kids = kids;
  }
}

let reduced = false;
let mod: {
  crossfade: (into: Fake[], out: Fake[]) => void;
  swap: (box: Fake, pic: Fake, count: Fake, other: boolean, live: () => boolean) => void;
};
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeAll(async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
  vi.stubGlobal("document", { documentElement: {} });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => " cubic-bezier(0.22, 1, 0.36, 1)" }));
  mod = await import(CROSSFADE);
});
beforeEach(() => {
  reduced = false;
});

const picture = () => {
  const p = new Fake("picture");
  p.kids = [new Fake("img")];
  return p;
};

describe("crossfade", () => {
  it("fades the new item in and the last out over 200 ms on the --ease-out token, in one grid cell", async () => {
    const [into, out] = [picture(), new Fake("canvas")];
    mod.crossfade([into], [out]);
    // A picture is display: contents: its img is what fades.
    expect(into.runs).toEqual([]);
    expect(into.kids[0]?.runs.map((r) => [r.keyframes, r.timing])).toEqual([
      [{ opacity: [0, 1] }, { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }],
    ]);
    expect(out.runs.map((r) => r.keyframes)).toEqual([{ opacity: [1, 0] }]);
    expect([into.style.gridArea, out.style.gridArea]).toEqual(["1/1", "1/1"]);
    expect([into.inert, out.inert]).toEqual([false, true]);
    await settle();
    expect([into.gone, out.gone]).toEqual([false, true]);
  });

  it("a last item taken back before its fade ends (no longer inert) stays", async () => {
    const out = new Fake("canvas");
    mod.crossfade([], [out]);
    out.inert = false;
    await settle();
    expect(out.gone).toBe(false);
  });

  it("restarts a node's own fade rather than stacking a second", () => {
    const n = new Fake("canvas");
    mod.crossfade([n], []);
    mod.crossfade([n], []);
    expect(n.runs.map((r) => r.cancelled)).toEqual([true, false]);
  });
});

describe("swap, the phone's preview", () => {
  const box = () => {
    const b = new Fake("div");
    b.kids = [picture(), new Fake("span")];
    return b;
  };

  it("another item: the new page over the last, which fades out on top and leaves", async () => {
    const b = box();
    const [last, count] = b.kids as [Fake, Fake];
    const pic = picture();
    mod.swap(b, pic, count, true, () => true);
    await settle();
    expect(b.kids).toEqual([pic, last, count]);
    expect(last.style.cssText).toBe("position:absolute;inset:0");
    expect(last.inert).toBe(true);
    await settle();
    expect(last.gone).toBe(true);
  });

  it("a page turn, reduced motion, or a later page meanwhile: no fade", async () => {
    for (const [other, still, live] of [
      [false, false, true],
      [true, true, true],
    ] as const) {
      reduced = still;
      const b = box();
      const count = b.kids[1] as Fake;
      const pic = picture();
      mod.swap(b, pic, count, other, () => live);
      await settle();
      expect(b.kids).toEqual([pic, count]);
      expect(pic.kids[0]?.runs).toEqual([]);
    }
    const b = box();
    const before = [...b.kids];
    mod.swap(b, picture(), b.kids[1] as Fake, true, () => false);
    await settle();
    expect(b.kids).toEqual(before);
  });
});
