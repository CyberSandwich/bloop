// The viewer's park over a fake DOM: just enough of the element API that viewer.js and ui.js touch.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Item, ScreenView } from "../../src/shared/protocol.ts";

type Listener = (e: { type: string; key?: string; target?: unknown; preventDefault?: () => void }) => void;

class Node {
  hidden = false;
  disabled = false;
  textContent = "";
  children: Node[] = [];
  style: Record<string, unknown> = { setProperty: () => {} };
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
  constructor(readonly tag: string) {}
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
    for (const k of kids) if (typeof k !== "string") this.children.push(k);
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
    for (const c of this.children) {
      if (c.tag === sel) return c;
      const deep = c.querySelector(sel);
      if (deep) return deep;
    }
    return null;
  }
  querySelectorAll(sel: string): Node[] {
    return this.children.flatMap((c) => [...(c.tag === sel ? [c] : []), ...c.querySelectorAll(sel)]);
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
const photo: Item = { kind: "file", name: "Dog.jpg", type: "jpg", size: 70_000 };
const deck: Item = { kind: "file", name: "Sample deck.pptx", type: "pptx", size: 82_000 };
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

// Specifiers in variables: the node tsconfig has no DOM lib, so it must not follow these imports into page code.
const VIEWER = "../../public/js/viewer.js";
const UI = "../../public/js/core/ui.js";
interface Viewer {
  render(v: ScreenView | null): void;
  park(line: string): void;
  take(url: string, item: number, mode: "view"): boolean;
  present(on: boolean): void;
  presentable(): boolean;
}
let createViewer: (deps: { relink: (i: number) => Promise<boolean>; onChange: () => void }) => Viewer;
beforeAll(async () => {
  vi.stubGlobal("document", doc);
  vi.stubGlobal("location", { origin: ORIGIN });
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("ResizeObserver", Sized);
  vi.stubGlobal("IntersectionObserver", Observer);
  vi.stubGlobal("Image", class extends Node {});
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "60px" }));
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.stubGlobal("Element", Node);
  vi.stubGlobal("HTMLElement", Node);
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

  it("an image taken while parked is kept but not drawn until render", () => {
    const { v, el } = setup();
    v.render(view);
    const before = el("frame").children[0];
    v.park("You're Offline");
    expect(v.take(`${ORIGIN}/f/abc/Dog.jpg`, 0, "view")).toBe(true);
    expect(el("view").hidden).toBe(true);
    expect(el("frame").children[0]).toBe(before);
    v.render(view);
    expect(el("frame").children[0]?.attrs.get("src")).toBe(`${ORIGIN}/f/abc/Dog.jpg`);
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
    v.render(view);
    v.present(true);
    v.park("You're Offline");
    expect(el("view").hidden).toBe(false);
    expect(el("frame").hidden).toBe(true);
    expect(el("prev").hidden).toBe(true);
    expect(el("next").hidden).toBe(true);
    expect(el("parked").hidden).toBe(false);
    expect(el("parked").textContent).toBe("You're Offline");
    expect(exitFullscreen).not.toHaveBeenCalled();
    v.render(view);
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

  it("sits at the stage foot under a scrolling document, whatever its pages measure", () => {
    const { v, el } = setup();
    v.render({ ...view, items: [deck] } as ScreenView);
    place(el);
    Object.assign(el("frame").querySelector("img") as Node, { offsetTop: 100, offsetHeight: 4000 });
    el("frame").classList.add("is-scroll");
    resized();
    expect(el("controls").style.top).toBe("920px");
  });
});
