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
    getPropertyValue: (k: string) => String(this.style[k] ?? ""),
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
  // A canvas or a video, as in a browser, has no natural size.
  get naturalWidth() {
    return this.tag === "canvas" || this.tag === "video" ? undefined : 0;
  }
  get naturalHeight() {
    return this.tag === "canvas" || this.tag === "video" ? undefined : 0;
  }
  width = 0;
  height = 0;
  /** Only a video has a frame size; anything else reads undefined, as in a browser. */
  frame = { w: 0, h: 0 };
  get videoWidth() {
    return this.tag === "video" ? this.frame.w : undefined;
  }
  get videoHeight() {
    return this.tag === "video" ? this.frame.h : undefined;
  }
  /** A video's pauses and loads, as the viewer asked for them. */
  pauses = 0;
  loads = 0;
  paused = true;
  muted = false;
  ended = false;
  /** What play() answers: a browser that holds sound refuses an unmuted play with NotAllowedError. */
  refuseSound = false;
  /** A policy that blocks all autoplay refuses a muted play too. */
  refuseAll = false;
  plays: boolean[] = [];
  pause() {
    this.pauses += 1;
    this.paused = true;
  }
  play() {
    this.plays.push(this.muted);
    if (this.refuseAll || (this.refuseSound && !this.muted))
      return Promise.reject(new DOMException("held", "NotAllowedError"));
    this.paused = false;
    return Promise.resolve();
  }
  load() {
    this.loads += 1;
  }
  /** Runs this node's listeners for an event, as a media element would fire it. */
  emit(type: string) {
    for (const f of this.listeners.get(type) ?? []) f({ type });
  }
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
  getAnimations() {
    return [];
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  inert = false;
  /** A tag or a .class, either maybe `:not([inert])`. */
  matchesOne(part: string): boolean {
    const live = part.endsWith(":not([inert])");
    const own = live ? part.slice(0, -":not([inert])".length) : part;
    if (live && this.inert) return false;
    return own.startsWith(".") ? this.classes.has(own.slice(1)) : this.tag === own;
  }
  /** One compound selector: a tag or a .class, after any ancestor tags ("picture img"). */
  is(sel: string): boolean {
    const parts = sel.trim().split(/\s+/);
    if (!this.matchesOne(parts.pop() ?? "")) return false;
    let up = this.parent;
    for (const want of parts.reverse()) {
      while (up && !up.matchesOne(want)) up = up.parent;
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
      if (typeof k === "string") this.textContent += k;
      else {
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
  "b-sound",
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
const VIDEO = "../../public/js/viewer-video.js";
interface Viewer {
  render(v: ScreenView | null): void;
  park(line: string): void;
  take(url: string, item: number, mode: "view" | "pdf"): boolean | Promise<boolean>;
  present(on: boolean): void;
  presentable(): boolean;
  item(): Item | null;
  at(): number;
  shown(): { item: string; page: number; present: boolean } | null;
}
type Deps = {
  relink: (i: number) => Promise<boolean>;
  onChange: () => void;
  tapped?: () => void;
  busy?: () => boolean;
};
let createViewer: (deps: Deps) => Viewer;
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
  vi.stubGlobal("innerWidth", 1000);
  vi.stubGlobal("innerHeight", 600);
  vi.stubGlobal("Element", Node);
  vi.stubGlobal("HTMLElement", Node);
  vi.stubGlobal("fetch", echo);
  vi.stubGlobal("createImageBitmap", async (blob: Blob) => ({ src: await blob.text(), ...bitmap, close() {} }));
  ({ createViewer } = await import(VIEWER));
});

let relinked: () => void;
const setup = (more: Partial<Deps> = {}) => {
  byId.clear();
  docListeners.clear();
  for (const id of ids) byId.set(id, new Node("div"));
  const parked = byId.get("parked");
  if (parked) parked.hidden = true;
  // As s.html: the page count starts hidden.
  const dots = byId.get("dots");
  if (dots) dots.hidden = true;
  const v = createViewer({
    relink: () =>
      new Promise<boolean>((done) => {
        relinked = () => done(false);
      }),
    onChange: () => {},
    ...more,
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
    // Under reduced motion (this suite's default) the photo takes its loader's place at once; the cross-fade is e2e.
    expect(el("frame").children.map((c) => c.tag)).toEqual(["canvas"]);
    expect(el("frame").children[0]?.attrs.get("aria-label")).toBe("Dog.jpg");
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

describe("a guest's photo and video on the stage (design.md section 7, Video)", () => {
  const clip: Item = { kind: "file", id: "i1", name: "Talk.mov", type: "mov", size: 5_000_000 };
  const shot: Item = { kind: "file", id: "i1", name: "Board.png", type: "png", size: 90_000 };
  const guestView = (item: Item) => ({ ...view, kind: "guest", items: [item] }) as ScreenView;
  /** Lets the video module's import and its fake events settle. */
  // The viewer's import() and this one share a module record: once this resolves, only the viewer's then() is left.
  const loaded = async () => {
    await import(VIDEO);
    for (let i = 0; i < 3; i += 1) await settle();
  };
  /** The video the module made, wherever it is (still off stage while it loads). */
  const videoOf = (frame: Node, made: Node[]) => frame.querySelector("video") ?? made.at(-1) ?? null;
  /** The metadata of a 16 : 9 recording. */
  const meta = (video: Node | null, w = 1920, h = 1080) => {
    if (!video) return;
    video.frame = { w, h };
    video.emit("loadedmetadata");
  };
  let made: Node[] = [];
  beforeEach(() => {
    made = [];
    vi.stubGlobal("document", {
      ...doc,
      createElement: (tag: string) => {
        const n = new Node(tag);
        if (tag === "video") made.push(n);
        return n;
      },
    });
  });
  afterEach(() => vi.stubGlobal("document", doc));

  it("a guest's photo is drawn through the photo's own path, on a canvas", async () => {
    const { v, el } = setup();
    v.take(`${ORIGIN}/f/abc/board.png`, 0, "view");
    await settle();
    v.render(guestView(shot));
    expect(shownFrom(el("frame"))).toBe(`${ORIGIN}/f/abc/board.png`);
    expect(el("frame").querySelector("canvas")?.attrs.get("aria-label")).toBe("Board.png");
  });

  it("a guest's deck shows its card and never asks for a link", () => {
    const relink = vi.fn(() => new Promise<boolean>(() => {}));
    byId.clear();
    for (const id of ids) byId.set(id, new Node("div"));
    const v = createViewer({ relink, onChange: () => {} });
    v.render({ ...guestView(deck), state: "open" } as ScreenView);
    expect(byId.get("view")?.classes.has("is-card")).toBe(true);
    expect(relink).not.toHaveBeenCalled();
  });

  it("holds the loader, indeterminate and the stage's shape, until the metadata; the video's ratio shapes it; then it fades in", async () => {
    const { v, el } = setup();
    el("view").offsetWidth = 1200;
    el("view").offsetHeight = 800;
    v.take(`${ORIGIN}/f/abc/talk.mov`, 0, "view");
    v.render(guestView(clip));
    const part = el("frame").children[0];
    expect(part?.classes.has("stand-in")).toBe(true);
    expect(part?.attrs.get("aria-label")).toBe("Loading Talk.mov");
    expect(part?.style["--ratio"]).toBe(String(1200 / 800));
    await loaded();
    const video = videoOf(el("frame"), made);
    expect(video?.attrs.get("src")).toBe(`${ORIGIN}/f/abc/talk.mov`);
    // Native controls without download, full screen or casting; no autoplay or mute attribute: play() decides.
    expect(video?.attrs.get("controls")).toBe("");
    expect(video?.attrs.get("controlslist")).toBe("nodownload nofullscreen noremoteplayback noplaybackrate");
    expect(video?.attrs.has("disablepictureinpicture")).toBe(true);
    expect(video?.attrs.has("autoplay")).toBe(false);
    expect(video?.attrs.has("muted")).toBe(false);
    expect(el("frame").querySelector("video")).toBeNull();
    expect(part?.attrs.has("aria-valuenow")).toBe(false);
    expect(v.presentable()).toBe(false);
    // On stage at the metadata: canplay may wait for the Play click on iOS or a data saver.
    (video as Node).frame = { w: 1080, h: 1920 };
    video?.emit("loadedmetadata");
    v.render(guestView(clip));
    expect(video?.style["--ratio"]).toBe(String(1080 / 1920));
    expect(el("frame").children.map((c) => c.tag)).toEqual(["video"]);
    expect(video?.attrs.get("aria-label")).toBe("Talk.mov");
    expect(v.presentable()).toBe(true);
    // Presenting focuses the video, so Space plays and pauses it rather than pressing Stop Presenting.
    v.present(true);
    expect(doc.activeElement).toBe(video);
  });

  it("VID-03 a video the browser cannot play shows This Video Can't Play Here over its kind line, and ends presenting", async () => {
    const { v, el } = setup();
    v.take(`${ORIGIN}/f/abc/talk.mov`, 0, "view");
    v.render(guestView(clip));
    await loaded();
    const video = videoOf(el("frame"), made);
    meta(video);
    v.render(guestView(clip));
    v.present(true);
    // A decoder or network failure mid-play.
    video?.emit("error");
    v.render(guestView(clip));
    const card = el("frame").querySelector(".item-card");
    expect(card?.attrs.get("role")).toBe("alert");
    expect(card?.children.slice(1).map((c) => c.textContent)).toEqual([
      "This Video Can't Play Here",
      "QuickTime video · 4.8 MB",
    ]);
    expect(el("frame").querySelector("video")).toBeNull();
    expect(doc.body.classes.has("is-presenting")).toBe(false);
  });

  it("the session's end empties the video, and its late events change nothing", async () => {
    const { v, el } = setup();
    v.take(`${ORIGIN}/f/abc/talk.mov`, 0, "view");
    v.render(guestView(clip));
    await loaded();
    const video = videoOf(el("frame"), made) as Node;
    v.render(null);
    expect(video.attrs.has("src")).toBe(false);
    expect(video.loads).toBe(1);
    meta(video);
    v.render(guestView(clip));
    expect(el("frame").querySelector("video")).toBeNull();
  });

  it("a video ended before its module arrives is never made", async () => {
    const { v } = setup();
    v.render(guestView(clip));
    v.take(`${ORIGIN}/f/abc/talk.mov`, 0, "view");
    v.render(null);
    await loaded();
    expect(made.length).toBe(0);
  });

  it("a parked stage pauses its video, which waits where it was", async () => {
    const { v, el } = setup();
    v.take(`${ORIGIN}/f/abc/talk.mov`, 0, "view");
    v.render(guestView(clip));
    await loaded();
    const video = videoOf(el("frame"), made) as Node;
    meta(video);
    v.render(guestView(clip));
    v.park("Offline");
    expect(video.pauses).toBe(1);
    v.render(guestView(clip));
    expect(el("frame").querySelector("video")).toBe(video);
  });

  describe("VID-05 sound", () => {
    /** A guest video on stage, its metadata in, as a command or the default tells it. */
    const staged = async (refuseSound = false, more: Partial<Deps> = {}) => {
      const { v, el } = setup(more);
      v.take(`${ORIGIN}/f/abc/talk.mov`, 0, "view");
      v.render(guestView(clip));
      await loaded();
      const video = videoOf(el("frame"), made) as Node;
      video.refuseSound = refuseSound;
      meta(video);
      v.render(guestView(clip));
      await settle();
      return { v, el, video };
    };
    const told = (shown: Partial<NonNullable<ScreenView["shown"]>>, now = 2) =>
      ({ ...guestView(clip), shown: { item: "i1", page: 1, present: false, ...shown }, now }) as ScreenView;
    let active = false;
    beforeEach(() => {
      active = false;
      vi.stubGlobal("navigator", {
        userActivation: {
          get isActive() {
            return active;
          },
        },
      });
    });

    it("VID-05 sound: on stage it plays with sound at once, as the page's first try", async () => {
      const { v, el, video } = await staged();
      expect(video.plays).toEqual([false]);
      expect(video.paused).toBe(false);
      expect(el("b-sound").hidden).toBe(true);
      expect(v.shown()).toMatchObject({ play: true, sound: "on" });
    });

    it("VID-05 sound: a browser that holds sound gets it muted, Tap for Sound, and a blocked report; the tap unmutes", async () => {
      const tapped = vi.fn();
      const { v, el, video } = await staged(true, { tapped });
      await settle();
      expect(video.plays).toEqual([false, true]);
      expect(video.muted).toBe(true);
      expect(video.paused).toBe(false);
      expect(el("b-sound").hidden).toBe(false);
      expect(tapped).toHaveBeenCalledTimes(1);
      expect(v.shown()).toMatchObject({ play: true, sound: "blocked" });
      // The tap is the page's user activation: the video's own volumechange then reports sound on.
      active = true;
      for (const f of el("b-sound").listeners.get("click") ?? []) f({ type: "click" });
      expect(video.muted).toBe(false);
      (video as unknown as { onvolumechange: () => void }).onvolumechange();
      expect(v.shown()).toMatchObject({ sound: "on" });
      expect(el("b-sound").hidden).toBe(true);
      expect(tapped).toHaveBeenCalledTimes(2);
    });

    it("VID-05 sound: an interrupted play (AbortError, a pause meanwhile) is no refusal of sound", async () => {
      const tapped = vi.fn();
      const { v, el, video } = await staged(false, { tapped });
      v.render(told({ sound: "off" }));
      video.play = () => Promise.reject(new DOMException("paused", "AbortError"));
      v.render(told({ sound: "on" }, 3));
      await settle();
      expect(video.muted).toBe(false);
      expect(el("b-sound").hidden).toBe(true);
      expect(v.shown()).toMatchObject({ sound: "on" });
      expect(tapped).not.toHaveBeenCalled();
    });

    it("VID-05 sound: a command pauses, plays and mutes it, once per change; its own events report nothing", async () => {
      const tapped = vi.fn();
      const { v, video } = await staged(false, { tapped });
      v.render(told({ play: false }));
      expect(video.paused).toBe(true);
      const pauses = video.pauses;
      v.render(told({ play: false }, 3));
      expect(video.pauses).toBe(pauses);
      v.render(told({ play: true, sound: "off" }, 4));
      expect(video.muted).toBe(true);
      expect(video.paused).toBe(false);
      // No user activation: the play and pause a command caused are not this screen's hand.
      (video as unknown as { onpause: () => void }).onpause();
      expect(tapped).not.toHaveBeenCalled();
    });

    it("VID-05 sound: the screen's own controls and the end report the state, and a repeat of it reports nothing", async () => {
      const tapped = vi.fn();
      const { v, video } = await staged(false, { tapped });
      active = true;
      video.paused = true;
      (video as unknown as { onpause: () => void }).onpause();
      expect(v.shown()).toMatchObject({ play: false });
      expect(tapped).toHaveBeenCalledTimes(1);
      (video as unknown as { onpause: () => void }).onpause();
      expect(tapped).toHaveBeenCalledTimes(1);
      active = false;
      video.paused = false;
      video.ended = true;
      video.paused = true;
      v.render(told({ play: true }));
      video.paused = true;
      (video as unknown as { onpause: () => void }).onpause();
      expect(v.shown()).toMatchObject({ play: false });
    });

    it("VID-05 sound: a video leaving the stage pauses, and coming back plays again", async () => {
      const deckView = (shown: object, now: number) =>
        ({ ...view, kind: "guest", items: [clip, { ...deck, id: "i2" }], shown, now }) as unknown as ScreenView;
      const { v, video } = await staged();
      v.render(deckView({ item: "i2", page: 1, present: false }, 3));
      expect(video.paused).toBe(true);
      v.render(deckView({ item: "i1", page: 1, present: false }, 4));
      expect(video.paused).toBe(false);
      v.park("Offline");
      expect(video.paused).toBe(true);
      v.render(deckView({ item: "i1", page: 1, present: false }, 4));
      expect(video.paused).toBe(false);
    });

    it("VID-05 sound: a file joining the list leaves the video on stage playing", async () => {
      const { v, el, video } = await staged();
      const pauses = video.pauses;
      const grown = { ...view, kind: "guest", items: [{ ...shot, id: "i0" }, clip], now: 3 };
      v.render({ ...grown, shown: { item: "i1", page: 1, present: false } } as unknown as ScreenView);
      await settle();
      expect(el("frame").querySelector("video")).toBe(video);
      expect(video.pauses).toBe(pauses);
      expect(video.paused).toBe(false);
      expect(v.shown()).toMatchObject({ item: "i1", play: true });
    });

    it("VID-05 sound: a switch to another video lets go of the first: its handlers, and a refusal it answers late", async () => {
      const two: Item = { ...clip, id: "i2", name: "Demo.mov" };
      const list = (item: string, now: number) =>
        ({
          ...view,
          kind: "guest",
          items: [clip, two],
          shown: { item, page: 1, present: false },
          now,
        }) as unknown as ScreenView;
      const tapped = vi.fn();
      const { v, el } = setup({ tapped });
      v.take(`${ORIGIN}/f/abc/talk.mov`, 0, "view");
      v.render(list("i1", 1));
      await loaded();
      const a = videoOf(el("frame"), made) as Node;
      // A's play answers only later, with the refusal a browser holding sound gives.
      let refuse = () => {};
      a.play = () => {
        a.paused = false;
        return new Promise((_, no) => {
          refuse = () => no(new DOMException("held", "NotAllowedError"));
        });
      };
      meta(a);
      v.render(list("i1", 1));
      await settle();
      v.take(`${ORIGIN}/f/abc/demo.mov`, 1, "view");
      v.render(list("i2", 2));
      await loaded();
      const b = videoOf(el("frame"), made) as Node;
      expect(b).not.toBe(a);
      meta(b);
      v.render(list("i2", 2));
      await settle();
      expect(a.paused).toBe(true);
      expect((a as unknown as { onplay: unknown }).onplay).toBeNull();
      expect(b.paused).toBe(false);
      refuse();
      await settle();
      expect(b.muted).toBe(false);
      expect(el("b-sound").hidden).toBe(true);
      expect(v.shown()).toMatchObject({ item: "i2", play: true, sound: "on" });
      expect(tapped).not.toHaveBeenCalled();
    });

    it("VID-05 sound: parked, Tap for Sound is hidden and a tap on it does nothing", async () => {
      const { v, el, video } = await staged(true);
      expect(el("b-sound").hidden).toBe(false);
      v.park("Offline");
      expect(el("b-sound").hidden).toBe(true);
      active = true;
      for (const f of el("b-sound").listeners.get("click") ?? []) f({ type: "click" });
      expect(video.muted).toBe(true);
      expect(video.paused).toBe(true);
    });

    it("VID-05 sound: a command that pauses and mutes at once does both", async () => {
      const { v, video } = await staged();
      v.render(told({ play: false, sound: "off" }));
      expect(video.paused).toBe(true);
      expect(video.muted).toBe(true);
    });

    it("VID-05 sound: a play refused even muted reports blocked and paused, and the tap starts it with sound", async () => {
      const tapped = vi.fn();
      const { v, el, video } = await staged(false, { tapped });
      video.refuseAll = true;
      v.render(told({ sound: "off" }));
      await settle();
      expect(video.paused).toBe(true);
      expect(el("b-sound").hidden).toBe(false);
      expect(v.shown()).toMatchObject({ play: false, sound: "blocked" });
      expect(tapped).toHaveBeenCalledTimes(1);
      // The tap is the gesture the policy waits for.
      video.refuseAll = false;
      active = true;
      for (const f of el("b-sound").listeners.get("click") ?? []) f({ type: "click" });
      expect(video.muted).toBe(false);
      expect(video.paused).toBe(false);
      (video as unknown as { onplay: () => void }).onplay();
      expect(v.shown()).toMatchObject({ play: true, sound: "on" });
      expect(el("b-sound").hidden).toBe(true);
    });

    it("VID-05 sound: with no UserActivation API the screen's own controls and the tap still report", async () => {
      vi.stubGlobal("navigator", {});
      const tapped = vi.fn();
      const { v, el, video } = await staged(true, { tapped });
      await settle();
      expect(v.shown()).toMatchObject({ play: true, sound: "blocked" });
      // After a tap on the page, its sound is allowed.
      video.refuseSound = false;
      for (const f of el("b-sound").listeners.get("click") ?? []) f({ type: "click" });
      (video as unknown as { onvolumechange: () => void }).onvolumechange();
      expect(v.shown()).toMatchObject({ play: true, sound: "on" });
      expect(el("b-sound").hidden).toBe(true);
      video.paused = true;
      (video as unknown as { onpause: () => void }).onpause();
      expect(v.shown()).toMatchObject({ play: false });
      // A command's own events repeat its state: nothing more is reported.
      const reports = tapped.mock.calls.length;
      v.render(told({ play: true, sound: "on" }, 3));
      (video as unknown as { onplay: () => void }).onplay();
      expect(tapped).toHaveBeenCalledTimes(reports);
    });

    it("VID-05 sound: only the current item's own video is set, never another still in the frame", async () => {
      const two: Item = { ...clip, id: "i2", name: "Demo.mov" };
      const list = (shown: object, now: number) =>
        ({
          ...view,
          kind: "guest",
          items: [clip, two],
          shown: { page: 1, present: false, ...shown },
          now,
        }) as unknown as ScreenView;
      const { v, el } = setup();
      v.take(`${ORIGIN}/f/abc/talk.mov`, 0, "view");
      v.render(list({ item: "i1" }, 1));
      await loaded();
      const a = videoOf(el("frame"), made) as Node;
      meta(a);
      v.render(list({ item: "i1" }, 1));
      await settle();
      v.take(`${ORIGIN}/f/abc/demo.mov`, 1, "view");
      v.render(list({ item: "i2" }, 2));
      await loaded();
      const b = made.at(-1) as Node;
      expect(b).not.toBe(a);
      // The old video still in the frame, as a loader waiting on its picture's decode leaves it.
      el("frame").replaceChildren(a);
      v.render(list({ item: "i2", sound: "off" }, 3));
      expect(b.plays).toEqual([]);
      expect(el("b-sound").hidden).toBe(true);
      for (const f of el("b-sound").listeners.get("click") ?? []) f({ type: "click" });
      expect(b.plays).toEqual([]);
    });
  });

  const cantPlay = (frame: Node) => frame.querySelector(".item-card")?.children[1]?.textContent ?? null;

  it("VID-03 a file with no picture (audio alone, a codec this engine cannot draw) shows the card at its metadata", async () => {
    const { v, el } = setup();
    v.take(`${ORIGIN}/f/abc/talk.mov`, 0, "view");
    v.render(guestView(clip));
    await loaded();
    meta(videoOf(el("frame"), made), 0, 0);
    v.render(guestView(clip));
    expect(cantPlay(el("frame"))).toBe("This Video Can't Play Here");
    expect(el("frame").querySelector("video")).toBeNull();
    expect(v.presentable()).toBe(false);
  });

  it("VID-03 no metadata within METADATA_MS shows the card; metadata in time keeps the video", async () => {
    const { METADATA_MS } = await import(VIDEO);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // loaded() without its macrotask settles, which these fake timers would hold.
      const flush = async () => {
        await import(VIDEO);
        for (let i = 0; i < 3; i += 1) await Promise.resolve();
      };
      const slow = setup();
      slow.v.take(`${ORIGIN}/f/abc/talk.mov`, 0, "view");
      slow.v.render(guestView(clip));
      await flush();
      expect(made).toHaveLength(1);
      vi.advanceTimersByTime(METADATA_MS - 1);
      slow.v.render(guestView(clip));
      expect(slow.el("frame").querySelector(".stand-in")).not.toBeNull();
      vi.advanceTimersByTime(1);
      slow.v.render(guestView(clip));
      expect(cantPlay(slow.el("frame"))).toBe("This Video Can't Play Here");

      const quick = setup();
      quick.v.take(`${ORIGIN}/f/abc/talk.mov`, 0, "view");
      quick.v.render(guestView(clip));
      await flush();
      meta(made.at(-1) ?? null);
      vi.advanceTimersByTime(METADATA_MS);
      quick.v.render(guestView(clip));
      expect(cantPlay(quick.el("frame"))).toBeNull();
      expect(quick.v.presentable()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a link off this origin shows the item's card at once and reports it taken, so the launcher never retries a window", () => {
    const { v, el } = setup();
    v.render(guestView(clip));
    expect(v.take("https://elsewhere.example/f/abc/talk.mov", 0, "view")).toBe(true);
    expect(cantPlay(el("frame"))).toBe("This Video Can't Play Here");
    expect(made).toHaveLength(0);
    const photo = setup();
    photo.v.render(guestView(shot));
    expect(photo.v.take("https://elsewhere.example/f/abc/board.png", 0, "view")).toBe(true);
    expect(photo.el("frame").querySelector(".item-card")?.attrs.has("role")).toBe(false);
    // Any other mode keeps the launcher's own answer.
    expect(photo.v.take("https://elsewhere.example/f/abc/board.pdf", 0, "pdf")).toBe(false);
  });

  it("a drag across a presented video is its scrubber, never a swipe: its click goes through", async () => {
    const { v, el } = setup();
    v.take(`${ORIGIN}/f/abc/talk.mov`, 0, "view");
    v.render(guestView(clip));
    await loaded();
    meta(videoOf(el("frame"), made));
    v.render(guestView(clip));
    v.present(true);
    const video = el("frame").querySelector("video");
    for (const f of el("view").listeners.get("pointerdown") ?? [])
      f({ type: "pointerdown", clientX: 300, target: video });
    for (const f of el("view").listeners.get("pointerup") ?? []) f({ type: "pointerup", clientX: 100, target: video });
    const click = { type: "click", stopPropagation: vi.fn(), preventDefault: vi.fn() };
    for (const f of el("view").listeners.get("click") ?? []) f(click);
    expect(click.stopPropagation).not.toHaveBeenCalled();
    expect(click.preventDefault).not.toHaveBeenCalled();
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

  it("two files with one name keep their own state: each is keyed by its server id, which a re-sort never moves", async () => {
    const { v, el } = setup();
    const twin = { ...photo, id: "t9" } as Item;
    v.render({ ...view, items: [photo, twin] } as ScreenView);
    v.take(`${ORIGIN}/f/one/Dog.jpg`, 0, "view");
    v.take(`${ORIGIN}/f/two/Dog.jpg`, 1, "view");
    await settle();
    v.render({ ...view, items: [photo, twin, deck] } as ScreenView);
    expect(shownFrom(el("frame"))).toBe(`${ORIGIN}/f/one/Dog.jpg`);
  });

  it("the page count's segment grows once: a repeat paint leaves it running, a reversal runs it back from there", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    try {
      const { v, el } = setup();
      const dots = el("dots");
      type Run = { cancel: () => void; reverse: () => void; reverses: number; onfinish: unknown };
      const runs: Run[] = [];
      let started = 0;
      Object.assign(dots, {
        animate: () => {
          started += 1;
          const a: Run = {
            reverses: 0,
            onfinish: null,
            cancel: () => runs.splice(runs.indexOf(a), 1),
            reverse: () => {
              a.reverses += 1;
            },
          };
          runs.push(a);
          return a;
        },
        getAnimations: () => runs,
      });
      const deckView = { ...view, items: [deck] } as ScreenView;
      v.render(deckView);
      expect(started).toBe(1);
      expect(dots.textContent).toBe("1 / 2");
      // Every scroll and render repaints the count: mid-flight, the same target restarts nothing.
      v.render(deckView);
      expect(started).toBe(1);
      expect(runs).toHaveLength(1);
      // A switch away mid-flight runs the same animation back, then hides the count.
      v.render({ ...view, items: [photo] } as ScreenView);
      expect(started).toBe(1);
      expect(runs[0]?.reverses).toBe(1);
      expect(typeof runs[0]?.onfinish).toBe("function");
    } finally {
      vi.stubGlobal("matchMedia", () => ({ matches: true }));
    }
  });

  const tap = (node: Node) => {
    for (const f of node.listeners.get("click") ?? []) f({ type: "click" });
  };
  const press = (key: string, more: Record<string, unknown> = {}) => {
    const e = { type: "keydown", key, preventDefault: vi.fn(), ...more };
    for (const f of docListeners.get("keydown") ?? []) f(e);
    return e;
  };
  const deckView = () => ({ ...view, items: [deck] }) as ScreenView;

  it("KEY-01 F5 enters Present and never reloads: held down, shifted, or alternating with Escape", async () => {
    const { v } = setup();
    v.render(deckView());
    await vi.dynamicImportSettled();
    const presenting = () => doc.body.classes.has("is-presenting");
    expect(presenting()).toBe(false);
    expect(press("F5").preventDefault).toHaveBeenCalled();
    expect(presenting()).toBe(true);
    // Presenting: prevented, nothing else (never a reload, never a stop).
    expect(press("F5").preventDefault).toHaveBeenCalled();
    expect(presenting()).toBe(true);
    press("Escape");
    expect(presenting()).toBe(false);
    expect(press("F5", { shiftKey: true }).preventDefault).toHaveBeenCalled();
    expect(presenting()).toBe(true);
    press("Escape");
    // A key held down is no second press, but the reload is still stopped.
    expect(press("F5", { repeat: true }).preventDefault).toHaveBeenCalled();
    expect(presenting()).toBe(false);
    expect(v.shown()?.present).toBe(false);
  });

  it("KEY-01 F5 on a link card (nothing to present) is still kept from reloading, and Ctrl+F5 is the browser's own", async () => {
    const { v } = setup();
    const link: Item = { kind: "link", id: "t7", url: "https://vevox.app/", title: "Vevox" };
    v.render({ ...view, items: [link] } as ScreenView);
    await vi.dynamicImportSettled();
    expect(press("F5").preventDefault).toHaveBeenCalled();
    expect(doc.body.classes.has("is-presenting")).toBe(false);
    v.render(deckView());
    expect(press("F5", { ctrlKey: true }).preventDefault).not.toHaveBeenCalled();
  });

  it("KEY-01 F5 with no viewer up (waiting, ended) is left to the browser", () => {
    const { v } = setup();
    v.render(null);
    expect(press("F5").preventDefault).not.toHaveBeenCalled();
  });

  it("KEY-01 guard: every key a clicker sends is handled; the only inert one is named", async () => {
    // An R400: left and right page, play alternates F5 and Escape, blank sends ".".
    const clicker: [string, "next" | "prev" | "present" | "stop" | "inert"][] = [
      ["PageDown", "next"],
      ["PageUp", "prev"],
      ["F5", "present"],
      ["Escape", "stop"],
      [".", "inert"],
    ];
    const { v, el } = setup();
    v.render(deckView());
    await vi.dynamicImportSettled();
    for (const [key, what] of clicker) {
      const at = el("dots").textContent;
      const presenting = doc.body.classes.has("is-presenting");
      const e = press(key);
      const handled =
        what === "next"
          ? el("dots").textContent === "2 / 2"
          : what === "present"
            ? doc.body.classes.has("is-presenting")
            : what === "stop"
              ? presenting && !doc.body.classes.has("is-presenting")
              : what === "prev"
                ? el("dots").textContent === "1 / 2" && at === "2 / 2"
                : false;
      expect(handled, key).toBe(what !== "inert");
      if (what !== "stop" && what !== "inert") expect(e.preventDefault, key).toHaveBeenCalled();
    }
  });

  it("KEY-01 Home and End go to the first and last page, and report it", async () => {
    const { v, el } = setup();
    v.render(deckView());
    await vi.dynamicImportSettled();
    expect(press("End").preventDefault).toHaveBeenCalled();
    expect(el("dots").textContent).toBe("2 / 2");
    expect(v.shown()?.page).toBe(2);
    press("Home");
    expect(el("dots").textContent).toBe("1 / 2");
    expect(v.shown()?.page).toBe(1);
  });

  it("each item keeps its page: leaving a deck on its last page and coming back lands there; its own row starts over", () => {
    const { v, el } = setup();
    v.render({ ...view, items: [photo, deck] } as ScreenView);
    tap(el("items").children[1]?.children[0] as Node);
    expect(v.shown()).toMatchObject({ item: "t2", page: 1 });
    tap(el("next"));
    expect(v.shown()).toMatchObject({ item: "t2", page: 2 });
    tap(el("items").children[0]?.children[0] as Node);
    expect(v.shown()).toMatchObject({ item: "t1", page: 1 });
    tap(el("items").children[1]?.children[0] as Node);
    expect(v.shown()).toMatchObject({ item: "t2", page: 2 });
    expect(el("dots").textContent).toBe("2 / 2");
    // The row of the item on stage is a restart, as before.
    tap(el("items").children[1]?.children[0] as Node);
    expect(v.shown()).toMatchObject({ item: "t2", page: 1 });
  });

  it("the remembered pages go with the session: after the end a deck opens on its first page", () => {
    const { v, el } = setup();
    v.render({ ...view, items: [photo, deck] } as ScreenView);
    tap(el("items").children[1]?.children[0] as Node);
    tap(el("next"));
    tap(el("items").children[0]?.children[0] as Node);
    v.render(null);
    v.render({ ...view, items: [photo, deck] } as ScreenView);
    tap(el("items").children[1]?.children[0] as Node);
    expect(v.shown()).toMatchObject({ item: "t2", page: 1 });
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
  it("focusTitle shows the ring after a key and hides it after a pointer; the root's .keyed says the same to CSS", async () => {
    const listeners = new Map<string, Listener>();
    const root = new Set<string>();
    vi.resetModules();
    vi.stubGlobal("addEventListener", (t: string, f: Listener) => listeners.set(t, f));
    vi.stubGlobal("document", {
      ...doc,
      documentElement: { classList: { toggle: (c: string, on: boolean) => (on ? root.add(c) : root.delete(c)) } },
    });
    const { focusTitle }: { focusTitle: (t: unknown) => void } = await import(UI);
    const title = { focus: vi.fn() };
    listeners.get("keydown")?.({ type: "keydown" });
    focusTitle(title);
    expect(title.focus).toHaveBeenLastCalledWith({ preventScroll: true, focusVisible: true });
    expect(root.has("keyed")).toBe(true);
    listeners.get("pointerdown")?.({ type: "pointerdown" });
    focusTitle(title);
    expect(title.focus).toHaveBeenLastCalledWith({ preventScroll: true, focusVisible: false });
    expect(root.has("keyed")).toBe(false);
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

describe("PAIR-13 the screen follows the phone, and reports its own taps (design.md section 7, Phone page)", () => {
  const both = (shown: ScreenView["shown"], now = 1) =>
    ({ ...view, items: [photo, deck], shown, now }) as unknown as ScreenView;
  const click = (node: Node) => {
    for (const f of node.listeners.get("click") ?? []) f({ type: "click" });
  };

  it("follows a command's item, page and present, by the item's id", () => {
    const { v, el } = setup();
    v.render(both(null));
    expect(v.at()).toBe(0);
    v.render(both({ item: "t2", page: 2, present: false }));
    expect(v.item()?.id).toBe("t2");
    expect(el("dots").textContent).toBe("2 / 2");
    expect(v.shown()).toMatchObject({ item: "t2", page: 2, present: false });
    v.render(both({ item: "t2", page: 2, present: true }));
    expect(doc.body.classes.has("is-presenting")).toBe(true);
    v.render(both({ item: "t2", page: 1, present: false }));
    expect(doc.body.classes.has("is-presenting")).toBe(false);
    expect(el("dots").textContent).toBe("1 / 2");
  });

  it("a guest file sorting in ahead keeps the commanded item on screen: the id, not the place", () => {
    const { v } = setup();
    v.render(both({ item: "t2", page: 1, present: false }));
    const guest: Item = { kind: "file", id: "t0", name: "A board.png", type: "png", size: 90_000 };
    v.render({ ...view, items: [guest, photo, deck], shown: { item: "t2", page: 1, present: false } } as ScreenView);
    expect(v.item()?.id).toBe("t2");
    expect(v.at()).toBe(2);
  });

  it("a push of the same shown never undoes a tap here: it is followed once", () => {
    const tapped = vi.fn();
    const { v, el } = setup({ tapped });
    v.render(both({ item: "t2", page: 1, present: false }));
    click(el("next"));
    expect(el("dots").textContent).toBe("2 / 2");
    expect(tapped).toHaveBeenCalledTimes(1);
    expect(v.shown()).toMatchObject({ item: "t2", page: 2, present: false });
    // Another push (a list change, a length) still carries the old shown: the screen stays where it was tapped.
    v.render(both({ item: "t2", page: 1, present: false }, 2));
    expect(el("dots").textContent).toBe("2 / 2");
  });

  it("while its own report is on its way, a push is not followed; once back, the stored shown is", () => {
    let busy = true;
    const { v, el } = setup({ tapped: () => {}, busy: () => busy });
    v.render(both({ item: "t2", page: 1, present: false }));
    expect(v.at()).toBe(0);
    busy = false;
    v.render(both({ item: "t2", page: 1, present: false }));
    expect(v.at()).toBe(1);
    click(el("next"));
    busy = true;
    v.render(both({ item: "t2", page: 1, present: false }, 3));
    expect(el("dots").textContent).toBe("2 / 2");
    busy = false;
    v.render(both({ item: "t2", page: 2, present: false }, 4));
    expect(el("dots").textContent).toBe("2 / 2");
  });

  it("reports a row, a step that moves, Present and Stop; a step held at the end, or a follow, reports nothing", () => {
    const tapped = vi.fn();
    const { v, el } = setup({ tapped });
    v.render(both({ item: "t2", page: 2, present: false }));
    expect(tapped).not.toHaveBeenCalled();
    click(el("next"));
    expect(tapped).not.toHaveBeenCalled();
    click(el("prev"));
    expect(tapped).toHaveBeenCalledTimes(1);
    v.present(true);
    expect(v.shown()?.present).toBe(true);
    click(el("b-stop"));
    expect(v.shown()?.present).toBe(false);
    expect(tapped).toHaveBeenCalledTimes(3);
    // Escape when nothing is presented changes nothing to report.
    for (const f of docListeners.get("keydown") ?? []) f({ type: "keydown", key: "Escape", preventDefault() {} });
    expect(tapped).toHaveBeenCalledTimes(3);
    const row = el("items").children[0]?.children[0] as Node;
    click(row);
    expect(v.item()?.id).toBe("t1");
    expect(tapped).toHaveBeenCalledTimes(4);
  });

  it("Present on a photo still on its way is held, and presents once it lands", async () => {
    const { v } = setup();
    v.render(both({ item: "t1", page: 1, present: true }));
    expect(doc.body.classes.has("is-presenting")).toBe(false);
    v.take(`${ORIGIN}/f/abc/Dog.jpg`, 0, "view");
    await settle();
    v.render(both({ item: "t1", page: 1, present: true }));
    expect(doc.body.classes.has("is-presenting")).toBe(true);
    expect(v.shown()).toMatchObject({ item: "t1", page: 1, present: true });
  });

  it("the phone's Present moves no focus: on an untouched page focus shows Stop Presenting for good", () => {
    const { v, el } = setup();
    doc.activeElement = null;
    v.render(both({ item: "t2", page: 1, present: true }));
    expect(doc.body.classes.has("is-presenting")).toBe(true);
    expect(doc.activeElement).toBeNull();
    // The screen's own Present still focuses Stop Presenting, so the keyboard is never lost.
    v.render(both({ item: "t2", page: 1, present: false }, 2));
    v.present(true);
    expect(doc.activeElement).toBe(el("b-stop"));
  });

  it("an id not in the list is ignored, and a link card is reported at page 1 and never presented, so the phone's mark leaves the file", () => {
    const { v } = setup();
    v.render(both({ item: "zz", page: 1, present: false }));
    expect(v.at()).toBe(0);
    const link: Item = { kind: "link", id: "t7", url: "https://vevox.app/", title: "Vevox" };
    v.render({ ...view, items: [link], shown: null } as ScreenView);
    expect(v.shown()).toMatchObject({ item: "t7", page: 1, present: false });
  });

  describe("Present is held only for an item that can present", () => {
    // A guest's deck has no pages and is no photo or video: it is a card, with nothing to present.
    const guest = (shown: ScreenView["shown"], now = 1) =>
      ({ ...view, kind: "guest", items: [photo, deck], shown, now }) as unknown as ScreenView;

    it("selecting a card here drops a Present still waiting on the photo, so it never starts later", () => {
      const { v, el } = setup();
      v.render(guest({ item: "t1", page: 1, present: true }));
      expect(v.shown()?.present).toBe(true);
      click(el("items").children[1]?.children[0] as Node);
      expect(v.item()?.id).toBe("t2");
      expect(v.shown()?.present).toBe(false);
    });

    it("VID-05 sound: a row picked here starts its item as a phone's command does: playing, sound tried again", () => {
      const { v, el } = setup();
      v.render(guest({ item: "t1", page: 1, present: false, play: false, sound: "blocked" }));
      expect(v.shown()).toMatchObject({ play: false, sound: "blocked" });
      click(el("items").children[1]?.children[0] as Node);
      expect(v.shown()).toMatchObject({ item: "t2", play: true, sound: "on" });
    });

    it("VID-05 sound: the row of the item already on stage keeps its play state", () => {
      const { v, el } = setup();
      v.render(guest({ item: "t1", page: 1, present: false, play: false, sound: "off" }));
      click(el("items").children[0]?.children[0] as Node);
      expect(v.shown()).toMatchObject({ item: "t1", play: false, sound: "off" });
    });

    it("a command that presents a card is followed to the card, without Present", () => {
      const { v } = setup();
      v.render(guest({ item: "t2", page: 1, present: true }));
      expect(v.item()?.id).toBe("t2");
      expect(v.shown()?.present).toBe(false);
      expect(doc.body.classes.has("is-presenting")).toBe(false);
    });
  });
});
