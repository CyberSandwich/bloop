// The binding of engine snapshots to the pill (core/upload-pill.js): what each state reads, its controls and its toasts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeNode } from "./client-upload-dom.ts";

const ENGINE = "../../public/js/core/upload.js";
const BINDING = "../../public/js/core/upload-pill.js";

interface Snap {
  id: number;
  name: string;
  size: number;
  state: string;
  loaded: number;
  fraction: number;
  error?: string;
  fileId?: string;
}
const file = (over: Partial<Snap> = {}): Snap => ({
  id: 1,
  name: "Lecture 5.pptx",
  size: 88 * 1024 * 1024,
  state: "uploading",
  loaded: 34 * 1024 * 1024,
  fraction: 0.39,
  ...over,
});
const batch = (files: Snap[], more: object = {}) => ({
  files,
  active: files.some((f) => !["saved", "sent", "refused", "paused", "canceled"].includes(f.state)),
  total: files.reduce((n, f) => n + f.size, 0),
  loaded: files.reduce((n, f) => n + f.loaded, 0),
  fraction: 0.39,
  etaMs: null,
  ...more,
});

let host: FakeNode;
let emit: (b: unknown) => void;
let toasts: { title: string; body: string; error?: boolean }[];
let engine: { added: unknown[][]; canceled: number[]; resumed: unknown[][]; disposed: number };

async function mount(options: object = {}) {
  vi.resetModules();
  toasts = [];
  engine = { added: [], canceled: [], resumed: [], disposed: 0 };
  const actual = await vi.importActual<{ formatBytes: unknown; etaLabel: unknown }>(ENGINE);
  vi.doMock(ENGINE, () => ({
    formatBytes: actual.formatBytes,
    etaLabel: actual.etaLabel,
    createUploader: ({ onChange }: { onChange: (b: unknown) => void }) => {
      emit = onChange;
      return {
        add: (files: unknown[]) => engine.added.push(files),
        cancel: (id: number) => engine.canceled.push(id),
        resume: (...args: unknown[]) => engine.resumed.push(args),
        dispose: () => engine.disposed++,
      };
    },
  }));
  vi.doMock("../../public/js/core/lazy.js", () => ({ styled: async () => {} }));
  vi.doMock("../../public/js/core/toast.js", () => ({ toast: (t: (typeof toasts)[number]) => toasts.push(t) }));
  // A specifier in a variable: the node tsconfig has no DOM lib, so it must not follow this import into page code.
  const { mountUploads } = (await import(BINDING)) as {
    mountUploads: (options: object) => Promise<{ add: (files: never[]) => unknown; dispose: () => void }>;
  };
  return mountUploads({ host: host as never, ...options });
}
const pillNode = () => host.byClass("up-pill");
const title = () => pillNode()?.byClass("up-title")?.textContent;
const line = () => pillNode()?.byClass("up-line")?.textContent;
const bar = () => pillNode()?.byClass("loader");

beforeEach(() => {
  host = new FakeNode("body");
  vi.useFakeTimers();
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("document", {
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
    body: host,
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock(ENGINE);
  vi.doUnmock("../../public/js/core/lazy.js");
  vi.doUnmock("../../public/js/core/toast.js");
});

describe("one file", () => {
  it("reads Starting with no fill before the first byte, then the share and the time left", async () => {
    await mount();
    emit(batch([file({ state: "starting", loaded: 0, fraction: 0 })]));
    expect(title()).toBe("Lecture 5.pptx");
    expect(line()).toBe("Starting");
    expect(bar()?.getAttribute("aria-valuenow")).toBeNull();
    expect(bar()?.getAttribute("aria-label")).toBe("Uploading Lecture 5.pptx");
    emit(batch([file()], { etaMs: 90_000 }));
    expect(line()).toBe("34 of 88 MB · 2 min left");
    expect(bar()?.getAttribute("aria-valuenow")).toBe("39");
    emit(batch([file({ loaded: 80 * 1024 * 1024 })], { etaMs: 30_000 }));
    expect(line()).toBe("80 of 88 MB · Under a minute left");
    emit(batch([file()], { etaMs: null }));
    expect(line()).toBe("34 of 88 MB");
  });

  it("has a Cancel named for the file that cancels it", async () => {
    await mount();
    emit(batch([file()]));
    const close = pillNode()?.byClass("up-close") as FakeNode;
    expect(close.getAttribute("aria-label")).toBe("Cancel Upload of Lecture 5.pptx");
    close.click();
    expect(engine.canceled).toEqual([1]);
  });

  it("holds the fill and drops the sheen while waiting, and says what to do after two minutes", async () => {
    await mount();
    emit(batch([file({ state: "waiting" })]));
    expect(line()).toBe("Waiting for a Connection");
    expect(pillNode()?.classes.has("moving")).toBe(false);
    expect(bar()?.getAttribute("aria-valuenow")).toBe("39");
    vi.advanceTimersByTime(120_000);
    expect(line()).toBe("Keep this page open. It finishes when you're back online.");
    emit(batch([file()]));
    emit(batch([file({ state: "waiting" })]));
    expect(line()).toBe("Waiting for a Connection");
  });

  it("checking: the title says so, the file is the line, the fill is full, and there is no way to cancel", async () => {
    await mount();
    emit(batch([file({ state: "checking", fraction: 0.99 })]));
    expect(title()).toBe("Checking Your File");
    expect(line()).toBe("Lecture 5.pptx");
    expect(bar()?.getAttribute("aria-valuenow")).toBe("100");
    expect(pillNode()?.byClass("up-close")).toBeUndefined();
    expect(pillNode()?.classes.has("moving")).toBe(true);
  });

  it("Saved leaves after 2 s; with Add to Up Next it stays 8 s and the action ticks the file", async () => {
    const upNext = vi.fn(async () => {});
    await mount({ upNext });
    emit(batch([file({ state: "saved", loaded: 88 * 1024 * 1024, fraction: 1, fileId: "f1" })]));
    expect(title()).toBe("Saved");
    expect(line()).toBe("Lecture 5.pptx");
    const act = pillNode()?.byClass("up-act") as FakeNode;
    expect(act.textContent).toBe("Add to Up Next");
    vi.advanceTimersByTime(7_999);
    expect(pillNode()?.removed).toBe(false);
    act.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(upNext).toHaveBeenCalledWith("f1");
    expect(title()).toBe("Added to Up Next");
    await vi.advanceTimersByTimeAsync(2200);
    expect(host.kids.filter((k) => k.classes.has("up-pill") && !k.removed)).toEqual([]);
  });

  it("Saved with no Up Next to join leaves after 2 s and offers nothing", async () => {
    await mount({ upNext: null });
    emit(batch([file({ state: "saved", loaded: 88 * 1024 * 1024, fraction: 1, fileId: "f1" })]));
    expect(pillNode()?.byClass("up-act")).toBeUndefined();
    vi.advanceTimersByTime(2000 + 200);
    expect(host.kids.filter((k) => k.classes.has("up-pill") && !k.removed)).toEqual([]);
  });

  it("a guest's file reads Sent", async () => {
    await mount({ kind: "guest", pid: "ref.secret" });
    emit(batch([file({ state: "sent", fraction: 1 })]));
    expect(title()).toBe("Sent");
  });

  it("stays while the pointer or focus is on it", async () => {
    await mount();
    emit(batch([file({ state: "saved", fraction: 1 })]));
    for (const fn of pillNode()?.listeners.get("pointerenter") ?? []) fn();
    vi.advanceTimersByTime(10_000);
    expect(pillNode()?.removed).toBe(false);
    for (const fn of pillNode()?.listeners.get("pointerleave") ?? []) fn();
    vi.advanceTimersByTime(1000 + 200);
    expect(host.kids.every((k) => k.removed)).toBe(true);
  });
});

describe("several files", () => {
  const three = [
    file({ id: 1, name: "a.pptx", size: 100, loaded: 100, state: "saved", fraction: 1 }),
    file({ id: 2, name: "b.pdf", size: 100, loaded: 40, state: "uploading" }),
    file({ id: 3, name: "c.pdf", size: 100, loaded: 0, state: "queued", fraction: 0 }),
  ];

  it("is one pill for the batch, a button that opens the sheet", async () => {
    await mount();
    emit(batch(three, { total: 300, loaded: 140, fraction: 140 / 300, etaMs: 120_000 }));
    expect(title()).toBe("Uploading 3 Files");
    expect(line()).toBe("0 of 1 KB · 2 min left");
    expect(pillNode()?.byClass("up-press")?.hidden).toBe(false);
    expect(pillNode()?.byClass("up-close")).toBeUndefined();
  });

  it("ends as 3 Files Saved, and 2 Files Saved when one was refused, with a toast for the refusal", async () => {
    await mount();
    const saved = three.map((f) => ({ ...f, state: "saved", loaded: f.size, fraction: 1 }));
    emit(batch(saved));
    expect(title()).toBe("3 Files Saved");
    emit(
      batch([saved[0] as Snap, saved[1] as Snap, file({ id: 3, name: "c.exe", state: "refused", error: "bad_type" })]),
    );
    expect(title()).toBe("2 Files Saved");
    expect(toasts).toEqual([
      {
        title: "This File Type Isn't Supported",
        body: "bloop takes decks, documents, PDFs, spreadsheets, text, photos and videos.",
        error: true,
      },
    ]);
  });

  it("tells each refusal once", async () => {
    await mount();
    const refused = file({ id: 3, name: "c.exe", state: "refused", error: "bad_type" });
    emit(batch([refused]));
    emit(batch([refused]));
    expect(toasts).toHaveLength(1);
  });
});

describe("a paused row", () => {
  const paused = file({ id: 4, state: "paused", loaded: 0, fraction: 0 });

  it("reads Is Paused with Choose File, and shows nothing for a batch that is not there", async () => {
    await mount();
    emit(batch([paused]));
    expect(title()).toBe("Lecture 5.pptx Is Paused");
    expect(line()).toBe("Choose the file again to finish.");
    expect(pillNode()?.byClass("up-act")?.textContent).toBe("Choose File");
    expect(bar()?.getAttribute("aria-valuenow")).toBeNull();
  });

  it("dismissing it cancels the paused upload", async () => {
    await mount();
    emit(batch([paused]));
    const close = pillNode()?.byClass("up-close") as FakeNode;
    close.click();
    expect(engine.canceled).toEqual([4]);
  });

  it("the pill goes when nothing is paused or running", async () => {
    await mount();
    emit(batch([paused]));
    emit(batch([]));
    vi.advanceTimersByTime(200);
    expect(host.kids.every((k) => k.removed)).toBe(true);
  });

  it("a canceled file is told once as Upload Canceled", async () => {
    await mount();
    emit(batch([file({ state: "canceled" })]));
    emit(batch([file({ state: "canceled" })]));
    expect(toasts).toEqual([{ title: "Upload Canceled", body: "Lecture 5.pptx wasn't added." }]);
  });
});

describe("the page's handle", () => {
  it("adds files to the engine, and dispose lets go of it and the pill", async () => {
    const handle = await mount();
    const f = { name: "a.pptx" };
    handle.add([f as never]);
    expect(engine.added).toEqual([[f]]);
    emit(batch([file()]));
    handle.dispose();
    vi.advanceTimersByTime(200);
    expect(engine.disposed).toBe(1);
    expect(host.kids.every((k) => k.removed)).toBe(true);
  });
});
