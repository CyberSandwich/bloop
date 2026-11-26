import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeNode {
  className = "";
  textContent = "";
  kids: (FakeNode | string)[] = [];
  append(...n: (FakeNode | string)[]) {
    this.kids.push(...n);
  }
}

// A specifier in a variable: the node tsconfig has no DOM lib, so it must not follow this import into page code.
const MODULE = "../../public/js/core/upload-toast.js";
const shown: { title: FakeNode; error?: boolean; body?: string }[] = [];

beforeEach(() => {
  shown.length = 0;
  vi.resetModules();
  vi.stubGlobal("document", { createElement: () => new FakeNode(), createDocumentFragment: () => new FakeNode() });
  vi.doMock("../../public/js/core/toast.js", () => ({ toast: (t: (typeof shown)[number]) => shown.push(t) }));
});
afterEach(() => {
  vi.doUnmock("../../public/js/core/toast.js");
  vi.unstubAllGlobals();
});

const pieces = (node: FakeNode) => node.kids.map((k) => (typeof k === "string" ? k : [k.className, k.textContent]));

describe("the upload toasts", () => {
  it("a status makes the title one line: the name split head and tail, then the status, then the hidden sentence", async () => {
    const { toast } = (await import(MODULE)) as { toast: (t: Record<string, unknown>) => void };
    toast({
      title: "A very long lecture name for week 5.pptx",
      status: "Can't Be Added",
      say: "It is damaged.",
      error: true,
    });
    expect(shown[0]?.error).toBe(true);
    expect(pieces(shown[0]?.title as FakeNode)).toEqual([
      ["head", "A very long lecture name for w"],
      ["tail", "eek 5.pptx"],
      ["st", " · Can't Be Added"],
      ["sr", "It is damaged."],
    ]);
  });

  it("without a status the title is plain text, and the sentence is still hidden text", async () => {
    const { toast } = (await import(MODULE)) as { toast: (t: Record<string, unknown>) => void };
    toast({ title: "File Too Large", say: "bloop takes files up to 500 MB." });
    expect(pieces(shown[0]?.title as FakeNode)).toEqual(["File Too Large", ["sr", "bloop takes files up to 500 MB."]]);
    toast({ title: "T" });
    expect(pieces(shown[1]?.title as FakeNode)).toEqual(["T"]);
  });
});
