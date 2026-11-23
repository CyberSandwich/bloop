import { describe, expect, it } from "vitest";
import { migrate, SCHEMA_KEY, SCHEMA_VERSION } from "../../src/worker/do/schema.ts";
import { policyOf, withHeaders } from "../../src/worker/headers.ts";
import {
  fileAt,
  type ItemRef,
  itemView,
  LINK_HOSTS,
  linkAllowed,
  MAX_ITEMS,
  orderItems,
} from "../../src/worker/items.ts";
import { type Machine, transition } from "../../src/worker/machine.ts";
import { effectivePurpose } from "../../src/worker/seams/open-path/links.ts";
import { openPathFor } from "../../src/worker/seams/open-path/select.ts";
import { CONTENT_TYPES } from "../../src/worker/seams/open-path/stream.ts";
import { screenView } from "../../src/worker/views.ts";
import {
  asItem,
  CFG,
  claimedOwner,
  DECK,
  fx,
  GUEST_FILE,
  MAX_MINUTES,
  must,
  offered,
  sec,
  T0,
  VEVOX,
} from "./machine-helpers.ts";

const kv = (entries: Record<string, unknown> = {}) => {
  const map = new Map<string, unknown>(Object.entries(entries));
  return {
    map,
    get: <T>(k: string) => map.get(k) as T | undefined,
    put: (k: string, v: unknown) => void map.set(k, v),
  };
};
/** A userinfo part, built so no literal credential URL sits in the source. */
const USERINFO = ["user", "pw"].join(":");

describe("LINK-01 link items: https only, on an allowed host", () => {
  it("allows the allowlisted hosts over https", () => {
    for (const host of LINK_HOSTS) expect(linkAllowed(`https://${host}/`)).toBe(true);
    expect(linkAllowed("https://www.vevox.com/join/123?x=1#y")).toBe(true);
  });

  it("refuses other schemes, hosts, look-alikes, credentials, ports and junk", () => {
    for (const url of [
      "http://www.vevox.com/",
      "javascript:alert(1)",
      "data:text/html,hi",
      "https://evil.example/",
      "https://www.vevox.com.evil.example/",
      "https://evilwww.vevox.com/",
      "https://www.vevox.com@evil.example/",
      `https://${USERINFO}@www.vevox.com/`,
      "https://www.vevox.com:8443/",
      "//www.vevox.com/",
      "www.vevox.com",
      "",
      `https://www.vevox.com/${"a".repeat(2100)}`,
    ]) {
      expect(linkAllowed(url), url).toBe(false);
    }
  });

  it("a link reaches a view as url and title only, and is never a file to mint for", () => {
    expect(itemView(VEVOX)).toEqual({ kind: "link", url: "https://www.vevox.com/", title: "Vevox" });
    expect(fileAt([VEVOX], 0)).toBeNull();
  });
});

describe("IMG-01 image items: fixed image types under nosniff", () => {
  const open = openPathFor("stream", []);
  const image = (type: "jpg" | "png" | "webp") => ({
    name: `Dog.${type}`,
    type,
    size: 3,
    url: null,
    body: async () => ({
      ok: true as const,
      stream: new ReadableStream<Uint8Array>({
        start(c) {
          // HTML bytes under an image name: the type still comes from the item, never from the bytes.
          c.enqueue(new TextEncoder().encode("<b>"));
          c.close();
        },
      }),
      length: 3,
    }),
  });

  it("an image link is always the inline view, or a download", () => {
    for (const type of ["jpg", "png", "webp"] as const) {
      expect(effectivePurpose(type, "protocol")).toBe("view");
      expect(effectivePurpose(type, "pdf")).toBe("view");
      expect(effectivePurpose(type, "view")).toBe("view");
      expect(effectivePurpose(type, "download")).toBe("download");
    }
    expect(effectivePurpose("pdf", "view")).toBe("pdf");
    expect(effectivePurpose("pptx", "view")).toBe("pdf");
    expect(effectivePurpose("pptx", "protocol")).toBe("protocol");
  });

  it("serves the fixed image type inline, sandboxed, no-store and nosniff", async () => {
    const want = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" } as const;
    for (const type of ["jpg", "png", "webp"] as const) {
      expect(CONTENT_TYPES[type]).toBe(want[type]);
      const r = await open.serve(new Request("https://bloop.test/f/t/Dog.jpg"), image(type), "view");
      const res = withHeaders(r, policyOf(r, "api"));
      expect(res.headers.get("Content-Type")).toBe(want[type]);
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Content-Disposition")).toBe("inline");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox; frame-ancestors 'none'");
    }
  });

  it("an image download is an attachment", async () => {
    const r = await open.serve(new Request("https://bloop.test/f/t/Dog.jpg"), image("jpg"), "download");
    const res = withHeaders(r, policyOf(r, "api"));
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Content-Disposition")).toBe("attachment");
  });
});

describe("SRC-01 screen-view: the view carries items, never a source ref", () => {
  it("names, types, sizes and link urls only", () => {
    const step = transition(
      claimedOwner(),
      { e: "approve", now: T0 + sec(5), items: [asItem({ ...DECK, size: 10 }), VEVOX], maxMinutes: MAX_MINUTES },
      CFG,
    );
    if (!step.ok) throw new Error(step.error);
    const meta = {
      screenRef: "r",
      mode: "demo" as const,
      roomId: null,
      roomName: null,
      screenSecretHash: "h",
      createdAt: T0,
    };
    const view = screenView(meta, step.next, { origin: "https://bloop.test", machine: CFG }, T0 + sec(6));
    expect(view.items).toEqual([
      { kind: "file", name: "Deck.pptx", type: "pptx", size: 10 },
      { kind: "link", url: "https://www.vevox.com/", title: "Vevox" },
    ]);
    expect(JSON.stringify(view)).not.toContain("deck-1");
    expect(JSON.stringify(view)).not.toContain("demo-vevox");
  });
});

describe("orderItems", () => {
  it("files by name, then links by title, without changing the input", () => {
    const b = asItem({ ...DECK, ref: "b", name: "b.pptx" });
    const a = asItem({ ...DECK, ref: "a", name: "A.pdf", type: "pdf" });
    const input: ItemRef[] = [VEVOX, b, a];
    expect(orderItems(input).map((i) => i.ref)).toEqual(["a", "b", "demo-vevox"]);
    expect(input.map((i) => i.ref)).toEqual(["demo-vevox", "b", "a"]);
  });
});

describe("Screen object schema steps", () => {
  const { file: _, ...rest } = { file: DECK, approvedAt: 1, endsAt: 2, openMode: null, firstOpenAt: null, mints: 0 };
  const v1Session = { file: DECK, ...rest };
  const link = { tokenHash: "h", purpose: "protocol", mintedAt: 0, firstFetchAt: null, fetches: 0, revoked: false };

  it("turns a stored single file into a one-item list and gives each link record item 0", () => {
    const store = kv({ meta: { mode: "demo" }, machine: { state: "approved", session: v1Session }, links: [link] });
    migrate(store);
    expect((store.map.get("machine") as Machine).session).toEqual({ ...rest, items: [asItem(DECK)], mints: [0] });
    expect(store.map.get("links")).toEqual([{ ...link, item: 0 }]);
    expect(store.map.get(SCHEMA_KEY)).toBe(SCHEMA_VERSION);
  });

  it("leaves a machine with no session alone, and runs once", () => {
    const store = kv({ meta: {}, machine: { state: "waiting", session: null } });
    migrate(store);
    expect(store.map.get("machine")).toEqual({ state: "waiting", session: null });
    const current = { state: "approved", session: { items: [VEVOX] } };
    store.put("machine", current);
    migrate(store);
    expect(store.map.get("machine")).toBe(current);
  });

  it("version 2 to 3: a session-wide mint count stands for every item, so no item gains mints it did not have", () => {
    const v2 = { items: [asItem(DECK), VEVOX], approvedAt: 1, endsAt: 2, openMode: null, firstOpenAt: null, mints: 3 };
    const store = kv({ meta: {}, schemaVersion: 2, machine: { state: "open", session: v2 } });
    migrate(store);
    expect((store.map.get("machine") as Machine).session?.mints).toEqual([3, 3]);
    expect(store.map.get(SCHEMA_KEY)).toBe(3);
  });

  it("does nothing to a fresh object (create writes the current version)", () => {
    const store = kv();
    migrate(store);
    expect(store.map.size).toBe(0);
  });
});

describe("machine: a session holds a list of items", () => {
  const PDF = asItem({ source: "mock", ref: "pdf-1", name: "Atlas.pdf", type: "pdf" });
  const DOG = asItem({ source: "mock", ref: "dog-1", name: "Dog.jpg", type: "jpg" });
  const approve = (m: Machine, items: ItemRef[]) =>
    transition(m, { e: "approve", now: T0 + sec(5), items, maxMinutes: MAX_MINUTES }, CFG);

  it("orders files by name, then links, and launches the first file", () => {
    const step = approve(claimedOwner(), [VEVOX, asItem(DECK), DOG, PDF]);
    if (!step.ok) throw new Error(step.error);
    expect(step.next.session?.items.map((i) => i.ref)).toEqual(["pdf-1", "deck-1", "dog-1", "demo-vevox"]);
    expect(fx(step.effects, "mint")).toEqual([{ fx: "mint", purpose: "protocol", item: 0 }]);
  });

  it("mints nothing when the session holds links only", () => {
    const step = approve(claimedOwner(), [VEVOX]);
    if (!step.ok) throw new Error(step.error);
    expect(step.next.state).toBe("approved");
    expect(fx(step.effects, "mint")).toEqual([]);
  });

  it("refuses an empty list, a repeated ref and more than MAX_ITEMS", () => {
    const many = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => asItem({ ...DECK, ref: `d${i}` }));
    expect(approve(claimedOwner(), [])).toEqual({ ok: false, error: "bad_request" });
    expect(approve(claimedOwner(), [asItem(DECK), asItem(DECK)])).toEqual({ ok: false, error: "bad_request" });
    expect(approve(claimedOwner(), many)).toEqual({ ok: false, error: "bad_request" });
    expect(approve(claimedOwner(), many.slice(0, MAX_ITEMS)).ok).toBe(true);
  });

  it("SRC-02 idor: a live approve needs every item, links too, in the listed ids", () => {
    const listed = must(claimedOwner("live"), { e: "listed", now: T0 + sec(2), ids: ["deck-1"] }).next;
    expect(approve(listed, [asItem(DECK), VEVOX])).toEqual({ ok: false, error: "file_not_found" });
    const both = must(claimedOwner("live"), { e: "listed", now: T0 + sec(2), ids: ["deck-1", "demo-vevox"] }).next;
    expect(approve(both, [asItem(DECK), VEVOX]).ok).toBe(true);
  });

  it("is idempotent for the same set in any order", () => {
    const step = approve(claimedOwner(), [asItem(DECK), PDF]);
    if (!step.ok) throw new Error(step.error);
    const again = approve(step.next, [PDF, asItem(DECK)]);
    expect(again.ok && again.next).toBe(step.next);
    expect(approve(step.next, [PDF])).toEqual({ ok: false, error: "wrong_state" });
  });

  it("PAIR-11 screen-events: a screen mints only for an approved file, never a link or an index out of range", () => {
    const step = approve(claimedOwner(), [asItem(DECK), DOG, VEVOX]);
    if (!step.ok) throw new Error(step.error);
    const opening = must(step.next, { e: "launched", now: T0 + sec(6), mode: "protocol" }).next;
    const fallback = (item: number | null) =>
      transition(opening, { e: "fallback", now: T0 + sec(7), mode: "download", item, maxMints: 5 }, CFG);
    expect(fallback(2)).toEqual({ ok: false, error: "file_not_found" });
    expect(fallback(3)).toEqual({ ok: false, error: "file_not_found" });
    expect(fallback(-1)).toEqual({ ok: false, error: "file_not_found" });
    const dog = fallback(1);
    expect(dog.ok && fx(dog.effects, "mint")).toEqual([{ fx: "mint", purpose: "download", item: 1 }]);
    const launched = fallback(null);
    expect(launched.ok && fx(launched.effects, "mint")).toEqual([{ fx: "mint", purpose: "download", item: 0 }]);
  });

  it("PC-02 sid-powers: the mint budget is per item; spending one item's leaves every other item its own", () => {
    const step = approve(claimedOwner(), [asItem(DECK), PDF]);
    if (!step.ok) throw new Error(step.error);
    expect(step.next.session?.mints).toEqual([0, 0]);
    let m = must(step.next, { e: "launched", now: T0 + sec(6), mode: "protocol" }).next;
    const mint = (item: number) =>
      transition(m, { e: "fallback", now: T0 + sec(7), mode: "download", item, maxMints: 2 }, CFG);
    for (const item of [0, 0]) {
      const ok = mint(item);
      if (!ok.ok) throw new Error(ok.error);
      m = ok.next;
    }
    expect(mint(0)).toEqual({ ok: false, error: "mint_limit" });
    expect(m.session?.mints).toEqual([2, 0]);
    const other = mint(1);
    expect(other.ok && other.next.session?.mints).toEqual([2, 1]);
  });

  it("a guest offer is a one-item list", () => {
    expect(offered().session?.items).toEqual([asItem(GUEST_FILE)]);
  });
});
