// The upload pill's face over a fake DOM (just what ui.js, loader.js and pill.js touch), and the binding's strings.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeNode } from "./client-upload-dom.ts";

const calm = { matches: false };
// Typed here, not by import: the node tsconfig has no DOM lib, so it must not follow these imports into page code.
let pillModule: { pill: (face: object) => { node: unknown; update: (patch: object) => void; leave: () => void } };
let bindingModule: {
  refusalToast: (
    name: string,
    code: string,
    maxMB: number | undefined,
  ) => { title: string; status?: string; say: string };
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
  const BINDING = "../../public/js/core/upload-refusals.js";
  pillModule = await import(PILL);
  bindingModule = await import(BINDING);
});
afterEach(() => {
  calm.matches = false;
  vi.useRealTimers();
});

const make = (face: object = {}) => {
  const host = new FakeNode("body");
  const part = pillModule.pill({ host: host as never, title: "Lecture 5.pptx", status: "Starting", ...face });
  const node = part.node as unknown as FakeNode;
  return { host, part, node, bar: node.byClass("loader") as FakeNode };
};

describe("the pill's face", () => {
  it("is a glass pill with a progress bar named for the upload, and a title with its status, in the page", () => {
    const { host, node, bar } = make({ label: "Uploading Lecture 5.pptx", fill: 0.5 });
    expect(host.kids).toEqual([node]);
    expect(node.classes.has("glass")).toBe(true);
    expect(bar.getAttribute("role")).toBe("progressbar");
    expect(bar.getAttribute("aria-label")).toBe("Uploading Lecture 5.pptx");
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(node.byClass("up-title")?.textContent).toBe("Lecture 5.pptx \u00b7 Starting");
    expect(node.byClass("up-line")).toBeUndefined();
  });

  it("shows the whole percent, and no value while there is nothing to show yet", () => {
    const { part, bar } = make({ fill: null });
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
    part.update({ fill: 0.337 });
    expect(bar.getAttribute("aria-valuenow")).toBe("34");
    part.update({ fill: 1 });
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
  });

  it("sweeps its sheen only while told to, and a status change leaves the name alone", () => {
    const { part, node } = make({ sheen: true });
    expect(node.classes.has("moving")).toBe(true);
    part.update({ sheen: false, status: "Waiting" });
    expect(node.classes.has("moving")).toBe(false);
    expect(node.byClass("up-status")?.textContent).toBe(" \u00b7 Waiting");
    expect(node.byClass("tail")?.parent).toBe(node.byClass("up-title"));
    expect(node.byClass("head")?.textContent).toBe("Lecture 5.pptx");
  });

  it("is one line: the text holds the title and nothing else, and an empty status leaves no dot", () => {
    const { part, node } = make();
    expect(node.byClass("up-text")?.kids).toEqual([node.byClass("up-title")]);
    part.update({ status: "" });
    expect(node.byClass("up-title")?.textContent).toBe("Lecture 5.pptx");
  });

  it("has no live region of its own: the page's one persistent region speaks for it", () => {
    const { part, node } = make();
    expect(node.find((n) => n.getAttribute("role") === "status")).toBeUndefined();
    part.update({ title: "Checking Your File", status: "" });
    expect(node.find((n) => n.getAttribute("role") === "status")).toBeUndefined();
    expect(node.byClass("up-title")?.textContent).toBe("Checking Your File");
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
    part.update({ label: "Uploading 3 Files" });
    expect(press.getAttribute("aria-label")).toBe("Uploading 3 Files");
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
      say: "bloop takes decks, documents, PDFs, spreadsheets, text, photos and videos.",
    });
    expect(t("a.pptx", "empty", undefined).title).toBe("This File Is Empty");
    expect(t("a.pptx", "too_large", 500)).toEqual({ title: "File Too Large", say: "bloop takes files up to 500 MB." });
    expect(t("a.pptx", "quota_exceeded", undefined)).toEqual({
      title: "Not Enough Space",
      say: "Delete files or empty the trash to add this one.",
    });
    expect(t("a.pptx", "library_full", undefined).title).toBe("Your Library Is Full");
    expect(t("Lecture 5.pptm", "macro_content", undefined)).toEqual({
      title: "Lecture 5.pptm",
      status: "Can't Be Added",
      say: "This file has macros. Save a copy without them as .pptx.",
    });
    expect(t("Notes.docm", "macro_content", undefined).say).toBe(
      "This file has macros. Save a copy without them as .docx.",
    );
    expect(t("a.pdf", "encrypted", undefined).say).toBe(
      "This file is password protected. Remove the password, then add it again.",
    );
    expect(t("a.pdf", "bad_structure", undefined).say).toBe(
      "This file is damaged. Open it on your computer and save it again.",
    );
  });

  it("never states a size cap it was not given", () => {
    expect(bindingModule.refusalToast("a.pptx", "too_large", undefined).say).not.toMatch(/\d/);
  });

  it("a code without a string of its own reads as the plain can't-be-added", () => {
    expect(bindingModule.refusalToast("a.pptx", "no_such_code", undefined)).toEqual({
      title: "a.pptx",
      status: "Can't Be Added",
      say: "Try again in a moment.",
    });
  });
});
