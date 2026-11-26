// The upload pill's face over a fake DOM (just what ui.js, loader.js and pill.js touch), and the binding's strings.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeNode } from "./client-upload-dom.ts";

const calm = { matches: false };
// Typed here, not by import: the node tsconfig has no DOM lib, so it must not follow these imports into page code.
let pillModule: { pill: (face: object) => { node: unknown; update: (patch: object) => void; leave: () => void } };
let bindingModule: {
  refusalToast: (name: string, code: string, maxMB: number | undefined) => { title: string; body: string };
};

beforeAll(async () => {
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("document", {
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
    body: new FakeNode("body"),
  });
  vi.stubGlobal("matchMedia", () => calm);
  // Specifiers in variables, for the same reason.
  const PILL = "../../public/js/core/pill.js";
  const BINDING = "../../public/js/core/upload-pill.js";
  pillModule = await import(PILL);
  bindingModule = await import(BINDING);
});
afterEach(() => {
  calm.matches = false;
  vi.useRealTimers();
});

const make = (face: object = {}) => {
  const host = new FakeNode("body");
  const part = pillModule.pill({ host: host as never, title: "Lecture 5.pptx", line: "Starting", ...face });
  const node = part.node as unknown as FakeNode;
  return { host, part, node, bar: node.byClass("loader") as FakeNode };
};

describe("the pill's face", () => {
  it("is a glass pill with a progress bar named for the upload, a title and a line, in the page", () => {
    const { host, node, bar } = make({ label: "Uploading Lecture 5.pptx", fill: 0.5 });
    expect(host.kids).toEqual([node]);
    expect(node.classes.has("glass")).toBe(true);
    expect(bar.getAttribute("role")).toBe("progressbar");
    expect(bar.getAttribute("aria-label")).toBe("Uploading Lecture 5.pptx");
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(node.byClass("up-title")?.textContent).toBe("Lecture 5.pptx");
    expect(node.byClass("up-line")?.textContent).toBe("Starting");
  });

  it("shows the whole percent, and no value while there is nothing to show yet", () => {
    const { part, bar } = make({ fill: null });
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
    part.update({ fill: 0.337 });
    expect(bar.getAttribute("aria-valuenow")).toBe("34");
    part.update({ fill: 1 });
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
  });

  it("sweeps its sheen only while told to, and a line change leaves the title alone", () => {
    const { part, node } = make({ sheen: true });
    expect(node.classes.has("moving")).toBe(true);
    part.update({ sheen: false, line: "Waiting for a Connection" });
    expect(node.classes.has("moving")).toBe(false);
    expect(node.byClass("up-line")?.textContent).toBe("Waiting for a Connection");
    expect(node.byClass("up-title")?.textContent).toBe("Lecture 5.pptx");
  });

  it("announces a changed title to the page, and never a changed line", () => {
    const { part, node } = make();
    const live = node.find((n) => n.getAttribute("role") === "status") as FakeNode;
    expect(live.textContent).toBe("Lecture 5.pptx");
    part.update({ line: "34 of 88 MB" });
    part.update({ line: "35 of 88 MB" });
    expect(live.textContent).toBe("Lecture 5.pptx");
    part.update({ title: "Checking Your File" });
    expect(live.textContent).toBe("Checking Your File");
  });

  it("holds the slot's controls at its end, and replaces them", () => {
    const { part, node } = make();
    const close = new FakeNode("button");
    part.update({ slot: [close as never] });
    expect(node.byClass("up-slot")?.kids).toEqual([close]);
    part.update({ slot: [] });
    expect(node.byClass("up-slot")?.kids).toEqual([]);
  });

  it("is a button over its face only when it holds several files", () => {
    const { part, node } = make();
    const press = node.byClass("up-press") as FakeNode;
    expect(press.hidden).toBe(true);
    const open = vi.fn();
    part.update({ press: open });
    expect(press.hidden).toBe(false);
    press.click();
    expect(open).toHaveBeenCalledOnce();
    // The progress bar keeps its own role: the button is a sibling, never its child.
    expect(press.getAttribute("aria-label")).toBe("Lecture 5.pptx");
    expect(node.byClass("loader")?.find((n) => n === press)).toBeUndefined();
  });

  it("splits a long name so its head ellipsizes and its end stays", () => {
    const { node } = make({ title: "A very long lecture name for week 5.pptx" });
    expect(node.byClass("head")?.textContent).toBe("A very long lecture name for w");
    expect(node.byClass("tail")?.textContent).toBe("eek 5.pptx");
  });

  it("leaves with the toast's 200 ms exit", () => {
    vi.useFakeTimers();
    const { part, node } = make();
    part.leave();
    expect(node.classes.has("out")).toBe(true);
    expect(node.removed).toBe(false);
    vi.advanceTimersByTime(199);
    expect(node.removed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(node.removed).toBe(true);
  });

  it("under reduced motion it leaves at once, with no exit to play", () => {
    calm.matches = true;
    const { part, node } = make();
    part.leave();
    expect(node.removed).toBe(true);
    expect(node.classes.has("out")).toBe(false);
  });
});

describe("the refusal toasts", () => {
  it("say the spec's strings for each code, naming the file where the spec does", () => {
    const t = bindingModule.refusalToast;
    expect(t("a.exe", "bad_type", undefined)).toEqual({
      title: "This File Type Isn't Supported",
      body: "bloop takes decks, documents, PDFs, spreadsheets, text, photos and videos.",
    });
    expect(t("a.pptx", "empty", undefined).title).toBe("This File Is Empty");
    expect(t("a.pptx", "too_large", 500)).toEqual({ title: "File Too Large", body: "bloop takes files up to 500 MB." });
    for (const code of ["quota_exceeded", "library_full"])
      expect(t("a.pptx", code, undefined)).toEqual({
        title: "Not Enough Space",
        body: "Delete files or empty the trash to add this one.",
      });
    expect(t("Lecture 5.pptm", "macro_content", undefined)).toEqual({
      title: "Lecture 5.pptm Can't Be Added",
      body: "This file has macros. Save a copy without them as .pptx.",
    });
    expect(t("Notes.docm", "macro_content", undefined).body).toBe(
      "This file has macros. Save a copy without them as .docx.",
    );
    expect(t("a.pdf", "encrypted", undefined).body).toBe(
      "This file is password protected. Remove the password, then add it again.",
    );
    expect(t("a.pdf", "bad_structure", undefined).body).toBe(
      "This file is damaged. Open it on your computer and save it again.",
    );
  });

  it("never states a size cap it was not given", () => {
    expect(bindingModule.refusalToast("a.pptx", "too_large", undefined).body).not.toMatch(/\d/);
  });

  it("a code without a string of its own reads as the plain can't-be-added", () => {
    expect(bindingModule.refusalToast("a.pptx", "storage_full", undefined)).toEqual({
      title: "a.pptx Can't Be Added",
      body: "Try again in a moment.",
    });
  });
});
