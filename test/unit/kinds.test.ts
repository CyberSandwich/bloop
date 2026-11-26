// What an item is shown as, and the order a session stores (src/worker/items.ts).
import { describe, expect, it } from "vitest";
import { EXTENSION_TYPES } from "../../public/js/shared/names.js";
import type { FileType, ItemKind } from "../../src/shared/protocol.ts";
import { type ItemDraft, kindOf, orderItems } from "../../src/worker/items.ts";
import { asItem, claimedOwner, DECK, GUEST_FILE, MAX_MINUTES, must, sec, T0, VEVOX } from "./machine-helpers.ts";

const ITEM_KINDS: readonly ItemKind[] = ["deck", "pdf", "doc", "sheet", "text", "image", "video"];
const lib = (ref: string, name: string) => asItem({ source: "library", ref, name, type: "pptx" });

describe("kindOf", () => {
  it("maps every file type to its viewer", () => {
    const types: FileType[] = ["pptx", "pdf", "jpg", "png", "mp4", "mov"];
    expect(Object.fromEntries(types.map((t) => [t, kindOf(t)]))).toEqual({
      pptx: "deck",
      pdf: "pdf",
      jpg: "image",
      png: "image",
      mp4: "video",
      mov: "video",
    });
  });

  it("has a kind for every type the extension list declares", () => {
    for (const type of Object.values(EXTENSION_TYPES)) expect(ITEM_KINDS, type).toContain(kindOf(type));
  });
});

describe("orderItems", () => {
  it("files by name, then links by title, without changing the input", () => {
    const b = asItem({ ...DECK, ref: "b", name: "b.pptx" });
    const a = asItem({ ...DECK, ref: "a", name: "A.pdf", type: "pdf" });
    const input: ItemDraft[] = [VEVOX, b, a];
    expect(orderItems(input).map((i) => i.ref)).toEqual(["a", "b", "demo-vevox"]);
    expect(input.map((i) => i.ref)).toEqual(["demo-vevox", "b", "a"]);
  });

  it("keeps the caller's order when every item is a library file, in a new array", () => {
    const input = [lib("c:1", "Zebra.pptx"), lib("a:1", "Apple.pptx"), lib("b:1", "Mango.pptx")];
    const out = orderItems(input);
    expect(out.map((i) => i.ref)).toEqual(["c:1", "a:1", "b:1"]);
    expect(out).not.toBe(input);
  });

  it("sorts as before when any item is not a library file", () => {
    const zebra = lib("c:1", "Zebra.pptx");
    const apple = lib("a:1", "Apple.pptx");
    expect(orderItems([zebra, asItem(GUEST_FILE), apple]).map((i) => i.ref)).toEqual(["a:1", "g/abc", "c:1"]);
    expect(orderItems([zebra, VEVOX, apple]).map((i) => i.ref)).toEqual(["a:1", "c:1", "demo-vevox"]);
  });

  it("an empty list stays empty", () => {
    expect(orderItems([])).toEqual([]);
  });

  it("the machine stores library items in the order approved, and gives ids by that place", () => {
    const items = [lib("c:1", "Zebra.pptx"), lib("a:1", "Apple.pptx")];
    const { next } = must(claimedOwner("demo"), { e: "approve", now: T0 + sec(5), items, minutes: MAX_MINUTES });
    expect(next.session?.items.map((i) => [i.id, i.ref])).toEqual([
      ["i1", "c:1"],
      ["i2", "a:1"],
    ]);
  });
});
