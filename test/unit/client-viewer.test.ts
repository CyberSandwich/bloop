// The viewer's park over a fake DOM: just enough of the element API that viewer.js and ui.js touch.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Item, ScreenView } from "../../src/shared/protocol.ts";

type Listener = (e: {
  type: string;
  key?: string;
  clientX?: number;
  target?: unknown;
  preventDefault?: () => void;
}) => void;

class Node {
  hidden = false;
  disabled = false;
  textContent = "";
  children: Node[] = [];
  style: Record<string, unknown> = {
    setProperty: (k: string, v: string) => {
      this.style[k] = v;
    },
    removeProperty: (k: string) => {
      delete this.style[k];
    },
  };
  attrs = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  classes = new Set<string>();
  classList = {
    toggle: (c: string, on?: boolean) => ((on ?? !this.classes.has(c)) ? this.classes.add(c) : this.classes.delete(c)),
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
  };
  offsetLeft = 0;
  offsetTop = 0;
  offsetWidth = 0;
  offsetHeight = 0;
  naturalWidth = 0;
  naturalHeight = 0;
  width = 0;
  height = 0;
  parent: Node | null = null;
  /** What a canvas last drew: the URL its fake bitmap came from. */
  drawn = "";
  constructor(readonly tag: string) {}
  get localName() {
    return this.tag;
  }
  get firstElementChild(): Node | null {
    return this.children[0] ?? null;
  }
  set src(v: string) {
    this.attrs.set("src", v);
  }
  get src() {
    return this.attrs.get("src") ?? "";
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
    if (k === "class") for (const c of v.split(" ")) this.classes.add(c);
  }
  getContext() {
    return { drawImage: (b: { src: string }) => (this.drawn = b.src) };
  }
  animate() {
    return { finished: Promise.resolve() };
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  /** One compound selector: a tag or a .class, after any ancestor tags ("picture img"). */
  is(sel: string): boolean {
    const parts = sel.trim().split(/\s+/);
    const own = parts.pop() ?? "";
    if (!(own.startsWith(".") ? this.classes.has(own.slice(1)) : this.tag === own)) return false;
    let up = this.parent;
    for (const want of parts.reverse()) {
      while (up && up.tag !== want) up = up.parent;
      if (!up) return false;
      up = up.parent;
    }
    return true;
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  addEventListener(t: string, f: Listener) {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), f]);
  }
  append(...kids: (Node | string)[]) {
    for (const k of kids)
      if (typeof k !== "string") {
        k.parent = this;
        this.children.push(k);
      }
  }
  replaceChildren(...kids: (Node | string)[]) {
    this.children = [];
    this.append(...kids);
  }
  matches() {
    return false;
  }
  focus() {
    doc.activeElement = this;
  }
  hidePopover() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, bottom: 0 };
  }
  requestFullscreen() {
    doc.fullscreenElement = this;
    return Promise.resolve();
  }
  contains(n: unknown): boolean {
    return n === this || this.children.some((c) => c.contains(n));
  }
  querySelector(sel: string): Node | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  /** Document order; a selector list matches any of its parts. */
  querySelectorAll(sel: string): Node[] {
    const any = sel.split(",");
    return this.children.flatMap((c) => [...(any.some((s) => c.is(s)) ? [c] : []), ...c.querySelectorAll(sel)]);
  }
}

const ids = [
  "side",
  "items",
  "handle",
  "view",
  "frame",
  "prev",
  "next",
  "dots",
  "parked",
  "controls",
  "pane",
  "b-end",
  "b-stop",
];
const byId = new Map<string, Node>();
const docListeners = new Map<string, Listener[]>();
const exitFullscreen = vi.fn(() => Promise.resolve());
const doc = {
  body: new Node("body"),
  fullscreenElement: null as Node | null,
  activeElement: null as Node | null,
  fullscreenEnabled: true,
  exitFullscreen,
  getElementById: (id: string) => byId.get(id) ?? null,
  createElement: (tag: string) => new Node(tag),
  createElementNS: (_: string, tag: string) => new Node(tag),
  addEventListener: (t: string, f: Listener) => docListeners.set(t, [...(docListeners.get(t) ?? []), f]),
};
const fire = (t: string) => {
  for (const f of docListeners.get(t) ?? []) f({ type: t });
};
class Observer {
  observe() {}
  disconnect() {}
}
/** The latest viewer's fit, as its ResizeObserver would run it. */
let resized = () => {};
class Sized extends Observer {
  constructor(fit: () => void) {
    super();
    resized = fit;
  }
}

const ORIGIN = "https://bloop.example";
const photo: Item = { kind: "file", id: "t1", name: "Dog.jpg", type: "jpg", size: 70_000 };
const deck: Item = { kind: "file", id: "t2", name: "Sample deck.pptx", type: "pptx", size: 82_000 };
const view = {
  state: "open",
  mode: "demo",
  kind: "owner",
  items: [photo],
  openMode: "view",
  endsAt: 1,
  endReason: null,
  now: 0,
} as unknown as ScreenView;

/** A view link answers its own URL as the body, so a canvas's drawing names the link it came from. */
const echo = (url: string) =>
  Promise.resolve(new Response(url, { headers: { "Content-Type": "image/jpeg", "Content-Length": `${url.length}` } }));
/** The size every fake photo decodes to. */
let bitmap = { width: 1500, height: 1000 };
/** Lets the fake fetch, read and decode settle. */
const settle = () => new Promise((done) => setTimeout(done, 0));
/** The link the stage's photo was drawn from, or "" while it is not drawn. */
const shownFrom = (frame: Node) => frame.querySelector("canvas")?.drawn ?? "";

// Specifiers in variables: the node tsconfig has no DOM lib, so it must not follow these imports into page code.
const VIEWER = "../../public/js/viewer.js";
const UI = "../../public/js/core/ui.js";
interface Viewer {
  render(v: ScreenView | null): void;
  park(line: string): void;
  take(url: string, item: number, mode: "view"): boolean;
  present(on: boolean): void;
  presentable(): boolean;
  item(): Item | null;
  at(): number;
}
let createViewer: (deps: { relink: (i: number) => Promise<boolean>; onChange: () => void }) => Viewer;
beforeAll(async () => {
  vi.stubGlobal("document", doc);
  vi.stubGlobal("location", { origin: ORIGIN });
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("ResizeObserver", Sized);
  vi.stubGlobal("IntersectionObserver", Observer);
  vi.stubGlobal("Image", class extends Node {});
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: (name: string) => (name === "--inset" ? "16px" : "60px"),
  }));
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.stubGlobal("Element", Node);
  vi.stubGlobal("HTMLElement", Node);
  vi.stubGlobal("fetch", echo);
  vi.stubGlobal("createImageBitmap", async (blob: Blob) => ({ src: await blob.text(), ...bitmap, close() {} }));
  ({ createViewer } = await import(VIEWER));
});

let relinked: () => void;
const setup = () => {
  byId.clear();
  docListeners.clear();
  for (const id of ids) byId.set(id, new Node("div"));
  const parked = byId.get("parked");
  if (parked) parked.hidden = true;
  const v = createViewer({
    relink: () =>
      new Promise<boolean>((done) => {
        relinked = () => done(false);
      }),
    onChange: () => {},
  });
  return { v, el: (id: string) => byId.get(id) as Node };
};

beforeEach(() => {
  doc.fullscreenElement = null;
  doc.fullscreenEnabled = true;
  doc.body.classes.clear();
  exitFullscreen.mockClear();
  bitmap = { width: 1500, height: 1000 };
});

describe("the photo's loader (design.md section 6, Loader)", () => {
  /** A view link whose bytes arrive when the test says, out of `total`. */
  const slow = (total: number | null, status = 200) => {
    let push: (n: number) => void = () => {};
    let end: () => void = () => {};
    const aborted: string[] = [];
    vi.stubGlobal("fetch", (url: string, init: { signal: AbortSignal }) => {
      init.signal.addEventListener("abort", () => aborted.push(url));
      if (status !== 200) return Promise.resolve(new Response(null, { status }));
      return new Promise<Response>((answer, fail) => {
        init.signal.addEventListener("abort", () => fail(new Error("aborted")));
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            push = (n) => c.enqueue(new TextEncoder().encode("x".repeat(n)));
            end = () => c.close();
          },
        });
        const headers: Record<string, string> = { "Content-Type": "image/jpeg" };
        if (total !== null) headers["Content-Length"] = String(total);
        answer(new Response(body, { headers }));
      });
    });
    return { push: (n: number) => push(n), end: () => end(), aborted };
  };
  afterEach(() => vi.stubGlobal("fetch", echo));

  it("holds the stage while the photo loads, its progress rising with the bytes; the photo then fades in over it", async () => {
    const net = slow(100);
    const { v, el } = setup();
    v.take(`${ORIGIN}/f/abc/Dog.jpg`, 0, "view");
    v.render(view);
    const part = el("frame").children[0];
    expect(part?.classes.has("loader")).toBe(true);
    expect(part?.classes.has("stand-in")).toBe(true);
    expect(part?.attrs.get("role")).toBe("progressbar");
    expect(part?.attrs.get("aria-label")).toBe("Loading Dog.jpg");
    await settle();
    expect(part?.attrs.get("aria-valuenow")).toBe("0");
    net.push(40);
    await settle();
    expect(part?.attrs.get("aria-valuenow")).toBe("40");
    expect(part?.style["--progress"]).toBe("0.4");
    expect(v.presentable()).toBe(false);
    net.push(60);
    net.end();
    await settle();
    expect(part?.attrs.get("aria-valuenow")).toBe("100");
    v.render(view);
    // The photo lands over its own loader, which leaves once the fade is done.
    expect(el("frame").children.map((c) => c.tag)).toEqual(["div", "canvas"]);
    expect(el("frame").children[1]?.attrs.get("aria-label")).toBe("Dog.jpg");
    await settle();
    expect(el("frame").children.map((c) => c.tag)).toEqual(["canvas"]);
    expect(v.presentable()).toBe(true);
  });

  it("stays indeterminate when the length is unknown: no value, the sheen alone", async () => {
    const net = slow(null);
    const { v, el } = setup();
    v.take(`${ORIGIN}/f/abc/Dog.jpg`, 0, "view");
    v.render(view);
    net.push(40);
    await settle();
    const part = el("frame").children[0];
    expect(part?.attrs.has("aria-valuenow")).toBe(false);
    expect(part?.style["--progress"]).toBeUndefined();
  });

  it("a photo that fails to load shows the item's card, never a loader that never ends", async () => {
    slow(100, 500);
    const { v, el } = setup();
    v.take(`${ORIGIN}/f/abc/Dog.jpg`, 0, "view");
    await settle();
    v.render(view);
    expect(el("view").classes.has("is-card")).toBe(true);
    expect(el("frame").querySelector(".loader")).toBeNull();
  });

  it("the session's end stops a photo still on its way", async () => {
    const net = slow(100);
    const { v } = setup();
    v.take(`${ORIGIN}/f/abc/Dog.jpg`, 0, "view");
    v.render(view);
    v.render(null);
    expect(net.aborted).toEqual([`${ORIGIN}/f/abc/Dog.jpg`]);
  });

  it("a photo still decoding when the session ends is closed, never drawn", async () => {
    let decoded: (b: object) => void = () => {};
    const close = vi.fn();
    const draw = vi.spyOn(Node.prototype, "getContext");
    vi.stubGlobal("createImageBitmap", () => new Promise((done) => (decoded = done)));
    try {
      const { v } = setup();
      v.take(`${ORIGIN}/f/abc/Dog.jpg`, 0, "view");
      v.render(view);
      await settle();
      v.render(null);
      decoded({ ...bitmap, close });
      await settle();
      expect(close).toHaveBeenCalledOnce();
      expect(draw).not.toHaveBeenCalled();
    } finally {
      draw.mockRestore();
      vi.stubGlobal("createImageBitmap", async (blob: Blob) => ({ src: await blob.text(), ...bitmap, close() {} }));
    }
  });

  it("decodes with the photo's own orientation, and a fresh link for a photo already drawn keeps it on stage", async () => {
    const options: unknown[] = [];
    vi.stubGlobal("createImageBitmap", async (blob: Blob, o: unknown) => {
      options.push(o);
      return { src: await blob.text(), ...bitmap, close() {} };
    });
    try {
      const { v, el } = setup();
      v.take(`${ORIGIN}/f/abc/Dog.jpg`, 0, "view");
      await settle();
      v.render(view);
      const drawn = el("frame").querySelector("canvas");
      expect(drawn).not.toBeNull();
      v.take(`${ORIGIN}/f/def/Dog.jpg`, 0, "view");
      await settle();
      expect(el("frame").querySelector(".loader")).toBeNull();
      expect(el("frame").querySelector("canvas")).toBe(drawn);
      expect(shownFrom(el("frame"))).toBe(`${ORIGIN}/f/abc/Dog.jpg`);
      expect(options).toEqual([{ imageOrientation: "from-image" }]);
    } finally {
      vi.stubGlobal("createImageBitmap", async (blob: Blob) => ({ src: await blob.text(), ...bitmap, close() {} }));
    }
  });
});

describe("DEMO-01 the viewer parks for a transient state", () => {
  it("a relink that lands while parked paints nothing; render paints again", async () => {
    const { v, el } = setup();
    v.render(view);
    expect(el("view").hidden).toBe(false);
    v.park("You're Offline");
    expect(el("view").hidden).toBe(true);
    relinked();
    await Promise.resolve();
    await Promise.resolve();
    expect(el("view").hidden).toBe(true);
    v.render(view);
    expect(el("view").hidden).toBe(false);
    // The refused relink shows the item's card, not a stand-in that never loads.
    expect(el("view").classes.has("is-card")).toBe(true);
  });

  it("an image taken while parked is kept but not drawn until render", async () => {
    const { v, el } = setup();
    v.render(view);
    const before = el("frame").children[0];
    v.park("You're Offline");
    expect(v.take(`${ORIGIN}/f/abc/Dog.jpg`, 0, "view")).toBe(true);
    await settle();
    expect(el("view").hidden).toBe(true);
    expect(el("frame").children[0]).toBe(before);
    v.render(view);
    expect(shownFrom(el("frame"))).toBe(`${ORIGIN}/f/abc/Dog.jpg`);
  });

  it("a file sorting in ahead of a loaded image leaves the selected item showing its own image", async () => {
    const { v, el } = setup();
    v.render(view);
    v.take(`${ORIGIN}/f/abc/Dog.jpg`, 0, "view");
    await settle();
    const guest: Item = { kind: "file", name: "Aardvark.txt", type: "txt", size: 10 } as unknown as Item;
    v.render({ ...view, items: [guest, photo] } as ScreenView);
    expect(v.at()).toBe(1);
    expect(shownFrom(el("frame"))).toBe(`${ORIGIN}/f/abc/Dog.jpg`);
  });

  it("an image taken before the first render is shown by that render", async () => {
    const { v, el } = setup();
    expect(v.take(`${ORIGIN}/f/abc/Dog.jpg`, 0, "view")).toBe(true);
    await settle();
    v.render(view);
    expect(shownFrom(el("frame"))).toBe(`${ORIGIN}/f/abc/Dog.jpg`);
  });

  it("two files with one name keep their own state: identity includes the count of same-named items before it", async () => {
    const { v, el } = setup();
    const twin = { ...photo } as Item;
    v.render({ ...view, items: [photo, twin] } as ScreenView);
    v.take(`${ORIGIN}/f/one/Dog.jpg`, 0, "view");
    v.take(`${ORIGIN}/f/two/Dog.jpg`, 1, "view");
    await settle();
    v.render({ ...view, items: [photo, twin, deck] } as ScreenView);
    expect(shownFrom(el("frame"))).toBe(`${ORIGIN}/f/one/Dog.jpg`);
  });

  it("a key while parked pages nothing: the deck resumes on the page it was on", () => {
    const { v, el } = setup();
    const deckView = { ...view, items: [deck] } as ScreenView;
    v.render(deckView);
    expect(el("dots").textContent).toBe("1 / 2");
    v.park("You're Offline");
    for (const f of docListeners.get("keydown") ?? []) f({ type: "keydown", key: "PageDown", preventDefault() {} });
    expect(el("view").hidden).toBe(true);
    v.render(deckView);
    expect(el("dots").textContent).toBe("1 / 2");
    expect(el("frame").querySelector("img")?.getAttribute("data-page")).toBe("0");
  });

  it("presenting it holds the stage with the status line, resumes in place, and only a real end leaves", () => {
    const { v, el } = setup();
    const page = { ...view, items: [deck] } as ScreenView;
    v.render(page);
    v.present(true);
    v.park("You're Offline");
    expect(el("view").hidden).toBe(false);
    expect(el("frame").hidden).toBe(true);
    expect(el("prev").hidden).toBe(true);
    expect(el("next").hidden).toBe(true);
    expect(el("parked").hidden).toBe(false);
    expect(el("parked").textContent).toBe("You're Offline");
    expect(exitFullscreen).not.toHaveBeenCalled();
    v.render(page);
    expect(el("frame").hidden).toBe(false);
    expect(el("parked").hidden).toBe(true);
    expect(exitFullscreen).not.toHaveBeenCalled();
    v.render(null);
    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(doc.body.classes.has("is-presenting")).toBe(false);
  });

  it("leaving full screen while parked hides the stage; leaving it while shown ends presenting only", () => {
    const { v, el } = setup();
    v.render(view);
    v.present(true);
    v.park("You're Offline");
    doc.fullscreenElement = null;
    fire("fullscreenchange");
    expect(el("view").hidden).toBe(true);
    expect(doc.body.classes.has("is-presenting")).toBe(false);
    v.render(view);
    v.present(true);
    doc.fullscreenElement = null;
    fire("fullscreenchange");
    expect(el("view").hidden).toBe(false);
    expect(doc.body.classes.has("is-presenting")).toBe(false);
  });
});

describe("presenting is one layout, with or without browser full screen", () => {
  const deckView = { ...view, items: [deck] } as ScreenView;

  it("a page or a loaded photo can be presented even where the browser has no full screen", () => {
    doc.fullscreenEnabled = false;
    const { v, el } = setup();
    v.render(deckView);
    expect(v.presentable()).toBe(true);
    v.present(true);
    expect(doc.body.classes.has("is-presenting")).toBe(true);
    expect(el("b-stop").hidden).toBe(false);
    expect(doc.fullscreenElement).toBeNull();
  });

  describe("Stop Presenting follows the pointer to the top of the window", () => {
    const move = (el: (id: string) => Node, y: number, pointerType = "mouse") => {
      for (const f of el("view").listeners.get("pointermove") ?? [])
        f({ type: "pointermove", clientY: y, pointerType } as never);
    };
    const start = (reducedMotion = false) => {
      vi.stubGlobal("matchMedia", () => ({ matches: reducedMotion }));
      vi.stubGlobal("requestAnimationFrame", (f: () => void) => {
        f();
        return 1;
      });
      vi.stubGlobal("cancelAnimationFrame", () => {});
      const s = setup();
      s.v.render(deckView);
      s.v.present(true);
      return s;
    };
    afterEach(() => vi.stubGlobal("matchMedia", () => ({ matches: true })));

    it("is hidden when presenting starts, and a move across the slide does not show it", () => {
      const { el } = start();
      expect(el("view").style["--stop-o"]).toBeUndefined();
      move(el, 400);
      expect(el("view").style["--stop-o"]).toBe("0");
      expect(el("view").classes.has("is-reach")).toBe(false);
    });

    it("ramps from 0 at 160 px to 1 in the top 64 px, and takes a click only from half", () => {
      const { el } = start();
      move(el, 120);
      const o = Number(el("view").style["--stop-o"]);
      expect(o).toBeGreaterThan(0);
      expect(o).toBeLessThan(1);
      expect(el("view").classes.has("is-reach")).toBe(o >= 0.5);
      move(el, 20);
      expect(el("view").style["--stop-o"]).toBe("1");
      expect(el("view").classes.has("is-reach")).toBe(true);
    });

    it("has no ramp under reduced motion: shown in the band, hidden outside it", () => {
      const { el } = start(true);
      move(el, 120);
      expect(el("view").style["--stop-o"]).toBe("0");
      move(el, 20);
      expect(el("view").style["--stop-o"]).toBe("1");
    });

    it("a touch move never shows it, a tap on the slide does, and leaving the window hides it", () => {
      const { el } = start();
      move(el, 20, "touch");
      expect(el("view").style["--stop-o"]).toBeUndefined();
      for (const f of el("view").listeners.get("pointerdown") ?? [])
        f({ type: "pointerdown", clientX: 100, pointerType: "touch" } as never);
      for (const f of el("view").listeners.get("pointerup") ?? [])
        f({ type: "pointerup", clientX: 100, pointerType: "touch", target: new Node("div") } as never);
      expect(el("view").classes.has("is-awake")).toBe(true);
      move(el, 20);
      for (const f of el("view").listeners.get("pointerleave") ?? []) f({ type: "pointerleave" } as never);
      expect(el("view").style["--stop-o"]).toBe("0");
    });
  });

  it("focus moves to Stop Presenting and returns to the button that started it", () => {
    const { v, el } = setup();
    v.render(deckView);
    const opener = el("next");
    opener.focus();
    v.present(true);
    expect(doc.activeElement).toBe(el("b-stop"));
    v.present(false);
    expect(doc.activeElement).toBe(opener);
  });

  it("a file joining the list ahead of the selection leaves the same item shown, presenting on", () => {
    const { v } = setup();
    v.render(deckView);
    v.present(true);
    v.render({ ...view, items: [photo, deck] } as ScreenView);
    expect(v.item()).toEqual(deck);
    expect(v.at()).toBe(1);
    expect(doc.body.classes.has("is-presenting")).toBe(true);
  });

  it("a selection that is gone falls back to the same index, clamped, and ends presenting when nothing can be shown", () => {
    const { v } = setup();
    const link = { kind: "link", title: "Vevox", url: "https://vevox.example/x" } as unknown as Item;
    v.render({ ...view, items: [photo, deck] } as ScreenView);
    v.present(true);
    v.render({ ...view, items: [link] } as ScreenView);
    expect(v.at()).toBe(0);
    expect(doc.body.classes.has("is-presenting")).toBe(false);
  });

  it("a swipe's click is stopped and its default prevented, so it never opens a link", () => {
    const { v, el } = setup();
    v.render(deckView);
    v.present(true);
    const press = { type: "pointerdown", clientX: 300 };
    for (const f of el("view").listeners.get("pointerdown") ?? []) f(press);
    for (const f of el("view").listeners.get("pointerup") ?? []) f({ type: "pointerup", clientX: 100 });
    const click = { type: "click", stopPropagation: vi.fn(), preventDefault: vi.fn() };
    for (const f of el("view").listeners.get("click") ?? []) f(click);
    expect(click.stopPropagation).toHaveBeenCalled();
    expect(click.preventDefault).toHaveBeenCalled();
  });

  it("where full screen exists, Present joins it; Stop Presenting and Escape both leave", () => {
    const { v, el } = setup();
    v.render(deckView);
    v.present(true);
    expect(doc.fullscreenElement).toBe(el("view"));
    for (const f of el("b-stop").listeners.get("click") ?? []) f({ type: "click" });
    expect(doc.body.classes.has("is-presenting")).toBe(false);
    expect(el("b-stop").hidden).toBe(true);
    expect(exitFullscreen).toHaveBeenCalledOnce();
    v.present(true);
    for (const f of docListeners.get("keydown") ?? []) f({ type: "keydown", key: "Escape", preventDefault() {} });
    expect(doc.body.classes.has("is-presenting")).toBe(false);
  });
});

describe("the focus ring follows a key", () => {
  it("focusTitle shows the ring after a key and hides it after a pointer", async () => {
    const listeners = new Map<string, Listener>();
    vi.resetModules();
    vi.stubGlobal("addEventListener", (t: string, f: Listener) => listeners.set(t, f));
    const { focusTitle }: { focusTitle: (t: unknown) => void } = await import(UI);
    const title = { focus: vi.fn() };
    listeners.get("keydown")?.({ type: "keydown" });
    focusTitle(title);
    expect(title.focus).toHaveBeenLastCalledWith({ preventScroll: true, focusVisible: true });
    listeners.get("pointerdown")?.({ type: "pointerdown" });
    focusTitle(title);
    expect(title.focus).toHaveBeenLastCalledWith({ preventScroll: true, focusVisible: false });
  });
});

describe("the viewer pill", () => {
  const place = (el: (id: string) => Node) => {
    Object.assign(el("view"), { offsetTop: 80, offsetHeight: 900 });
    el("controls").offsetHeight = 60;
  };

  it("sits 16 under the slide, or under a card when there is no image", () => {
    const { v, el } = setup();
    v.render({ ...view, items: [deck] } as ScreenView);
    place(el);
    Object.assign(el("frame").querySelector("img") as Node, { offsetTop: 100, offsetHeight: 400 });
    resized();
    expect(el("controls").style.top).toBe("596px");
    el("frame").replaceChildren(Object.assign(new Node("div"), { offsetTop: 300, offsetHeight: 200 }));
    resized();
    expect(el("controls").style.top).toBe("596px");
  });

  it("is placed again when an image in the frame loads, since its ratio is known only then", () => {
    const { el } = setup();
    expect(el("frame").listeners.get("load")?.length).toBeGreaterThan(0);
  });

  it("sits at the stage foot under a scrolling document, whatever its pages measure", () => {
    const { v, el } = setup();
    v.render({ ...view, items: [deck] } as ScreenView);
    place(el);
    Object.assign(el("frame").querySelector("img") as Node, { offsetTop: 100, offsetHeight: 4000 });
    el("frame").classList.add("is-scroll");
    resized();
    expect(el("controls").style.top).toBe("904px");
  });

  it("goes to the rail by the list's full height, and the list's cap then reserves the column", async () => {
    const { v, el } = setup();
    // A wide photo that fills the stage: no room under or beside it.
    bitmap = { width: 1000, height: 600 };
    v.take(`${ORIGIN}/f/abc/Dog.jpg`, 0, "view");
    await settle();
    v.render({ ...view, items: [photo, deck] } as ScreenView);
    expect(el("frame").querySelector("canvas")?.width).toBe(1000);
    Object.assign(el("view"), { offsetWidth: 1000, offsetHeight: 600 });
    el("controls").offsetHeight = 120;
    el("side").getBoundingClientRect = () => ({ left: 0, top: 80, bottom: 200 });
    el("b-end").getBoundingClientRect = () => ({ left: 0, top: 844, bottom: 900 });
    // 80 + 600 + 16 + 120 = 816 fits above End's bottom.
    Object.assign(el("side"), { scrollHeight: 600 });
    resized();
    expect(el("pane").classes.has("is-stacked")).toBe(true);
    expect(el("side").style["--reserve"]).toBe("120px");
    // Scrolled, the box is short, yet 80 + 800 + 16 + 120 overflows the foot: the pill floats, the cap is End's again.
    Object.assign(el("side"), { scrollHeight: 800 });
    resized();
    expect(el("pane").classes.has("is-stacked")).toBe(false);
    expect(el("side").style["--reserve"]).toBeUndefined();
  });
});
