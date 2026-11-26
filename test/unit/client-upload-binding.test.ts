// The binding of engine snapshots to the pill (core/upload-pill.js): what each state reads, its controls and its toasts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeNode } from "./client-upload-dom.ts";

const ENGINE = "../../public/js/core/upload.js";
const BINDING = "../../public/js/core/upload-pill.js";
const REFUSALS = "../../public/js/core/upload-refusals.js";

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
/** The element with the keyboard's focus. */
const focus: { on: FakeNode | null } = { on: null };
let emit: (b: unknown) => void;
let toasts: { title: string; body: string; error?: boolean; action?: { label: string; run: () => void } }[];
let engine: { added: unknown[][]; canceled: number[]; resumed: unknown[][]; disposed: number };

async function mount(options: object = {}) {
  vi.resetModules();
  toasts = [];
  engine = { added: [], canceled: [], resumed: [], disposed: 0 };
  const actual = await vi.importActual<{ formatBytes: unknown; progressLine: unknown }>(ENGINE);
  vi.doMock(ENGINE, () => ({
    formatBytes: actual.formatBytes,
    progressLine: actual.progressLine,
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
const tap = (node: FakeNode | undefined) => node?.click();
const title = () => pillNode()?.byClass("up-title")?.textContent;
const line = () => pillNode()?.byClass("up-line")?.textContent;
const bar = () => pillNode()?.byClass("loader");

beforeEach(() => {
  host = new FakeNode("body");
  vi.useFakeTimers();
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  focus.on = null;
  vi.stubGlobal("document", {
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
    body: host,
    get activeElement() {
      return focus.on;
    },
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

describe("what holds still while the snapshots change", () => {
  const sheetOf = () => host.kids.find((k) => k.tag === "dialog");
  const pressPill = () => pillNode()?.byClass("up-press")?.click();
  const items = () => sheetOf()?.byClass("up-list")?.kids ?? [];
  const three = (over: Partial<Snap>[] = []) =>
    [
      file({ id: 1, name: "a.pptx", size: 100, loaded: 100, state: "saved", fraction: 1 }),
      file({ id: 2, name: "b.pdf", size: 100, loaded: 40, state: "uploading" }),
      file({ id: 3, name: "c.pdf", size: 100, loaded: 0, state: "queued", fraction: 0 }),
    ].map((f, i) => ({ ...f, ...over[i] }));

  it("the pill's Cancel is the same button on every snapshot, so a tap in progress still lands", async () => {
    await mount();
    emit(batch([file()]));
    const first = pillNode()?.byClass("up-close");
    emit(batch([file({ loaded: 50 * 1024 * 1024 })]));
    emit(batch([file({ loaded: 60 * 1024 * 1024 })], { etaMs: 90_000 }));
    expect(pillNode()?.byClass("up-close")).toBe(first);
  });

  it("the paused row shows again once the pill of the file saved beside it has left", async () => {
    await mount();
    const saved = file({ id: 1, state: "saved", loaded: 88 * 1024 * 1024, fraction: 1 });
    const paused = file({ id: 4, name: "Old.pptx", state: "paused", loaded: 0, fraction: 0 });
    emit(batch([saved, paused]));
    expect(title()).toBe("Saved");
    vi.advanceTimersByTime(2000 + 200);
    emit(batch([saved, paused]));
    const live = host.kids.filter((k) => k.classes.has("up-pill") && !k.removed);
    expect(live.map((k) => k.byClass("up-title")?.textContent)).toEqual(["Old.pptx Is Paused"]);
  });

  it("the sheet's lines change in place while the files and their states hold, and are rebuilt when one changes", async () => {
    await mount();
    emit(batch(three(), { total: 300, loaded: 140 }));
    pressPill();
    expect(sheetOf()?.open).toBe(true);
    const list = sheetOf()?.byClass("up-list");
    const second = items()[1];
    expect(second?.byClass("up-line")?.textContent).toBe("0 of 1 KB");
    emit(batch(three([{}, { loaded: 90 }]), { total: 300, loaded: 190 }));
    expect(sheetOf()?.byClass("up-list")).toBe(list);
    expect(items()[1]).toBe(second);
    expect(second?.byClass("up-line")?.textContent).toBe("0 of 1 KB");
    emit(batch(three([{}, { state: "checking" }]), { total: 300, loaded: 190 }));
    expect(sheetOf()?.byClass("up-list")).not.toBe(list);
    expect(items()[1]?.byClass("up-line")?.textContent).toBe("Checking Your File");
  });

  it("a file that was canceled is not in the sheet", async () => {
    await mount();
    emit(batch(three(), { total: 300, loaded: 140 }));
    pressPill();
    expect(items()).toHaveLength(3);
    emit(batch(three([{}, { state: "canceled" }]), { total: 200, loaded: 100 }));
    expect(items().map((i) => i.byClass("up-title")?.textContent)).toEqual(["a.pptx", "c.pdf"]);
  });
});

describe("the refusal strings", () => {
  const SERVER_CODES = [
    "bad_type",
    "too_large",
    "quota_exceeded",
    "library_full",
    "rate_limited",
    "service_busy",
    "upload_busy",
    "upload_gone",
    "upload_aborted",
    "size_mismatch",
    "bad_structure",
    "macro_content",
    "encrypted",
    "bad_request",
    "length_required",
    "not_found",
    "unauthorized",
    "storage_full",
    "empty",
    "service_down",
  ];

  it("every upload error code has a string of its own, never the fallback and never another code's", async () => {
    await mount();
    const { refusalToast } = (await import(REFUSALS)) as {
      refusalToast: (name: string, code: string, maxMB?: number) => { title: string; body: string };
    };
    const fallback = refusalToast("Talk.pptx", "no_such_code", 500);
    expect(fallback).toEqual({ title: "Talk.pptx Can't Be Added", body: "Try again in a moment." });
    const seen = new Set<string>();
    for (const code of SERVER_CODES) {
      const t = refusalToast("Talk.pptx", code, 500);
      expect(t, code).not.toEqual(fallback);
      expect(seen.has(JSON.stringify(t)), `${code} repeats another code's string`).toBe(false);
      seen.add(JSON.stringify(t));
      expect(`${t.title} ${t.body}`, code).not.toMatch(/\bchecked\b|[\u2013\u2014]/i);
    }
  });

  it("File Too Large names the library's cap, and still says something without it", async () => {
    await mount();
    const { refusalToast } = (await import(REFUSALS)) as {
      refusalToast: (name: string, code: string, maxMB?: number) => { title: string; body: string };
    };
    expect(refusalToast("a.pptx", "too_large", 500)).toEqual({
      title: "File Too Large",
      body: "bloop takes files up to 500 MB.",
    });
    expect(refusalToast("a.pptx", "too_large", undefined).body).not.toBe("");
  });
});

describe("a guest's send", () => {
  it("shows the waiting state when the phone goes offline, instead of nothing", async () => {
    await mount({ kind: "guest", pid: "ref.secret" });
    emit(batch([file({ state: "waiting" })]));
    expect(title()).toBe("Lecture 5.pptx");
    expect(line()).toBe("Waiting for a Connection");
  });

  it("tells the page each snapshot and never toasts a refusal or a cancel: the page has its own states", async () => {
    const seen: unknown[] = [];
    await mount({ kind: "guest", pid: "ref.secret", onChange: (b: unknown) => seen.push(b) });
    const refused = batch([file({ state: "refused", error: "bad_type" })]);
    emit(refused);
    emit(batch([file({ id: 2, state: "canceled" })]));
    expect(seen).toHaveLength(2);
    expect(toasts).toEqual([]);
  });
});

describe("a batch's refusals", () => {
  const sheetOf = () => host.kids.find((k) => k.tag === "dialog");
  const refusedThree = () => [
    file({ id: 1, name: "a.exe", state: "refused", error: "bad_type" }),
    file({ id: 2, name: "b.pptm", state: "refused", error: "macro_content" }),
    file({ id: 3, name: "c.bin", state: "refused", error: "empty" }),
  ];

  it("three refusals are one toast that opens a sheet of three rows, each with its own reason", async () => {
    await mount();
    emit(batch(refusedThree()));
    expect(toasts).toHaveLength(1);
    const [one] = toasts;
    expect(one).toMatchObject({ title: "3 Files Couldn't Be Added", error: true });
    expect(one?.action?.label).toBe("See Why");
    expect(sheetOf()).toBeUndefined();
    one?.action?.run();
    expect(sheetOf()?.open).toBe(true);
    const rows = sheetOf()?.byClass("up-list")?.kids ?? [];
    expect(rows.map((r) => r.byClass("up-title")?.textContent)).toEqual(["a.exe", "b.pptm", "c.bin"]);
    expect(rows.map((r) => r.byClass("up-line")?.textContent)).toEqual([
      "bloop takes decks, documents, PDFs, spreadsheets, text, photos and videos.",
      "This file has macros. Save a copy without them as .pptx.",
      "This File Is Empty",
    ]);
    expect(rows.every((r) => r.byClass("up-close") === undefined)).toBe(true);
  });

  it("tells them when the batch ends, not one by one while it runs, and each only once", async () => {
    await mount();
    const [a, b, c] = refusedThree() as [Snap, Snap, Snap];
    const waiting = file({ id: 4, name: "d.pptx", state: "queued", loaded: 0, fraction: 0 });
    emit(batch([a, waiting]));
    emit(batch([a, b, waiting]));
    expect(toasts).toEqual([]);
    emit(batch([a, b, { ...waiting, state: "saved" }]));
    expect(toasts.map((t) => t.title)).toEqual(["2 Files Couldn't Be Added"]);
    emit(batch([a, b, c, { ...waiting, state: "saved" }]));
    expect(toasts.map((t) => t.title)).toEqual(["2 Files Couldn't Be Added", "This File Is Empty"]);
    emit(batch([a, b, c, { ...waiting, state: "saved" }]));
    expect(toasts).toHaveLength(2);
  });

  it("one refusal among files is that file's own toast, as before", async () => {
    await mount();
    emit(
      batch([
        file({ id: 1, state: "saved", fraction: 1 }),
        file({ id: 2, name: "x.exe", state: "refused", error: "bad_type" }),
      ]),
    );
    expect(toasts.map((t) => t.title)).toEqual(["This File Type Isn't Supported"]);
    expect(toasts[0]?.action).toBeUndefined();
  });

  it("a guest still has no toast", async () => {
    await mount({ kind: "guest", pid: "ref.secret" });
    emit(batch(refusedThree()));
    expect(toasts).toEqual([]);
  });
});

describe("what the page keeps in hand", () => {
  const saved = (id: number, fileId: string) =>
    file({ id, name: `f${id}.pptx`, state: "saved", loaded: 88 * 1024 * 1024, fraction: 1, fileId });

  it("Add to Up Next works again on the next file: one tick does not lock the pill for good", async () => {
    const upNext = vi.fn(async () => {});
    await mount({ upNext });
    emit(batch([saved(1, "f1")]));
    tap(pillNode()?.byClass("up-act"));
    await vi.advanceTimersByTimeAsync(2500);
    emit(batch([saved(1, "f1"), saved(2, "f2")].slice(1)));
    tap(host.kids.filter((k) => k.classes.has("up-pill") && !k.removed)[0]?.byClass("up-act"));
    await vi.advanceTimersByTimeAsync(0);
    expect(upNext.mock.calls).toEqual([["f1"], ["f2"]]);
  });

  it("a tick the page refused can be tried again", async () => {
    const upNext = vi.fn().mockRejectedValueOnce(new Error("full")).mockResolvedValue(undefined);
    await mount({ upNext });
    emit(batch([saved(1, "f1")]));
    const act = pillNode()?.byClass("up-act") as FakeNode;
    act.click();
    await vi.advanceTimersByTimeAsync(0);
    act.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(upNext).toHaveBeenCalledTimes(2);
  });

  it("paused rows are told apart by id: dismissing one shows the next, with its own Cancel", async () => {
    await mount();
    const one = file({ id: 4, name: "One.pptx", state: "paused", loaded: 0, fraction: 0 });
    const two = file({ id: 5, name: "Two.pptx", state: "paused", loaded: 0, fraction: 0 });
    emit(batch([one, two]));
    expect(title()).toBe("One.pptx Is Paused");
    tap(pillNode()?.byClass("up-close"));
    emit(batch([{ ...one, state: "canceled" }, two]));
    expect(title()).toBe("Two.pptx Is Paused");
    expect(pillNode()?.byClass("up-close")?.getAttribute("aria-label")).toBe("Cancel Upload of Two.pptx");
    tap(pillNode()?.byClass("up-close"));
    expect(engine.canceled).toEqual([4, 5]);
  });

  it("a guest cannot cancel a file the server is checking, in the pill or in the sheet", async () => {
    await mount({ kind: "guest", pid: "ref.secret" });
    emit(batch([file({ state: "checking", fraction: 0.99 })]));
    expect(pillNode()?.byClass("up-close")).toBeUndefined();
    emit(
      batch([file({ id: 1, state: "checking" }), file({ id: 2, name: "b.pdf", state: "uploading" })], { total: 200 }),
    );
    tap(pillNode()?.byClass("up-press"));
    const rows = host.kids.find((k) => k.tag === "dialog")?.byClass("up-list")?.kids ?? [];
    expect(rows[0]?.byClass("up-close")).toBeUndefined();
    expect(rows[1]?.byClass("up-close")).toBeDefined();
  });

  it("Cancel's name follows the file it is for, fresh on every snapshot", async () => {
    await mount();
    emit(batch([file()]));
    const close = pillNode()?.byClass("up-close") as FakeNode;
    close.setAttribute("aria-label", "stale");
    emit(batch([file({ loaded: 50 * 1024 * 1024 })]));
    expect(close.getAttribute("aria-label")).toBe("Cancel Upload of Lecture 5.pptx");
  });
});

describe("what a screen reader and the keyboard are given", () => {
  const spoken = () => pillNode()?.byClass("sr")?.textContent;

  it("Waiting for a Connection is announced when it starts, and cleared when it ends", async () => {
    await mount();
    emit(batch([file()]));
    expect(spoken()).toBe("Lecture 5.pptx");
    emit(batch([file({ state: "waiting" })]));
    expect(spoken()).toBe("Waiting for a Connection");
    emit(batch([file({ state: "waiting", loaded: 35 * 1024 * 1024 })]));
    expect(spoken()).toBe("Waiting for a Connection");
    emit(batch([file()]));
    expect(spoken()).toBe("");
    emit(batch([file({ state: "waiting" })]));
    expect(spoken()).toBe("Waiting for a Connection");
  });

  it("a title that changes as the wait ends is what is said", async () => {
    await mount();
    emit(batch([file({ state: "waiting" })]));
    emit(batch([file({ state: "checking", fraction: 0.99 })]));
    expect(spoken()).toBe("Checking Your File");
  });

  it("a wait inside a batch is announced too", async () => {
    await mount();
    emit(batch([file({ id: 1 }), file({ id: 2, name: "b.pdf", state: "queued" })]));
    emit(batch([file({ id: 1 }), file({ id: 2, name: "b.pdf", state: "waiting" })]));
    expect(spoken()).toBe("Waiting for a Connection");
  });

  it("focus returns to what opened the upload when the pill goes with it inside", async () => {
    const trigger = new FakeNode("button");
    await mount({ trigger });
    emit(batch([file({ state: "saved", fraction: 1, fileId: "f1" })]));
    focus.on = pillNode()?.byClass("up-title") as FakeNode;
    vi.advanceTimersByTime(2000 + 200);
    expect(trigger.focused).toBe(1);
  });

  it("focus elsewhere is left where it is", async () => {
    const trigger = new FakeNode("button");
    await mount({ trigger });
    emit(batch([file({ state: "saved", fraction: 1 })]));
    focus.on = new FakeNode("input");
    vi.advanceTimersByTime(2000 + 200);
    expect(trigger.focused).toBe(0);
  });

  it("focus in the sheet returns too when the batch is done", async () => {
    const trigger = new FakeNode("button");
    await mount({ trigger });
    const files = [
      file({ id: 1, name: "a.pptx", state: "saved", fraction: 1 }),
      file({ id: 2, name: "b.pdf", state: "saved", fraction: 1 }),
    ];
    emit(batch(files));
    tap(pillNode()?.byClass("up-press"));
    focus.on = host.kids.find((k) => k.tag === "dialog")?.byClass("up-list") ?? null;
    vi.advanceTimersByTime(2000 + 200);
    expect(trigger.focused).toBe(1);
  });
});
