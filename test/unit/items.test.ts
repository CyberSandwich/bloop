import { describe, expect, it } from "vitest";
import { SLIDES } from "../../public/js/core/demo.js";
import { DEMO_ITEMS } from "../../src/shared/demo-catalog.ts";
import { migrate, SCHEMA_KEY, SCHEMA_VERSION } from "../../src/worker/do/schema.ts";
import { policyOf, withHeaders } from "../../src/worker/headers.ts";
import {
  allowedLink,
  effectivePurpose,
  fileAt,
  type ItemDraft,
  itemView,
  LINK_HOSTS,
  MAX_ITEMS,
  shownFault,
} from "../../src/worker/items.ts";
import { type Machine, transition } from "../../src/worker/machine.ts";
import { openPathFor } from "../../src/worker/seams/open-path/select.ts";
import { CONTENT_TYPES } from "../../src/worker/seams/open-path/stream.ts";
import { screenView } from "../../src/worker/views.ts";
import {
  asItem,
  asStored,
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
import { memKv } from "./sqlite.ts";

const kv = (entries: Record<string, unknown> = {}) => {
  const store = memKv(entries);
  return { ...store, map: store.data };
};
/** A userinfo part, built so no literal credential URL sits in the source. */
const USERINFO = ["user", "pw"].join(":");

describe("LINK-01 link items: https only, on an allowed host", () => {
  it("allows the allowlisted hosts over https and answers the normalized URL, which is all an item stores", () => {
    for (const host of LINK_HOSTS) expect(allowedLink(`https://${host}/`)).toBe(`https://${host}/`);
    expect(allowedLink("https://www.vevox.com/join/123?x=1#y")).toBe("https://www.vevox.com/join/123?x=1#y");
    expect(allowedLink("HTTPS://WWW.VEVOX.COM")).toBe("https://www.vevox.com/");
    // The default port normalizes away; a backslash after the host is only a path.
    expect(allowedLink("https://www.vevox.com:443/x")).toBe("https://www.vevox.com/x");
    expect(allowedLink("https://www.vevox.com\\evil")).toBe("https://www.vevox.com/evil");
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
      "https://www.vevox.com./",
      "https://www.vev\u043ex.com/",
      "https://xn--www-vevox-o5a.com/",
      "https:\\\\evil.example\\www.vevox.com",
      "https:evil.example/www.vevox.com",
      "//www.vevox.com/",
      "www.vevox.com",
      "",
      `https://www.vevox.com/${"a".repeat(2100)}`,
    ]) {
      expect(allowedLink(url), url).toBeNull();
    }
  });

  it("a link reaches a view as id, url and title only, and is never a file to mint for", () => {
    const stored = { ...VEVOX, id: "i1" };
    expect(itemView(stored)).toEqual({ kind: "link", id: "i1", url: "https://www.vevox.com/", title: "Vevox" });
    expect(fileAt([stored], 0)).toBeNull();
  });
});

describe("IMG-01 image items: fixed image types under nosniff", () => {
  const open = openPathFor("stream", []);
  const image = (type: "jpg" | "png") => ({
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
    for (const type of ["jpg", "png"] as const) {
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
    const want = { jpg: "image/jpeg", png: "image/png" } as const;
    for (const type of ["jpg", "png"] as const) {
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
      { e: "approve", now: T0 + sec(5), items: [asItem({ ...DECK, size: 10 }), VEVOX], minutes: MAX_MINUTES },
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
      linkOrigin: "file" as const,
    };
    const cfg = { origin: "https://bloop.test", machine: CFG, library: { largeFileChoiceBytes: 1 } };
    const view = screenView(meta, step.next, cfg, T0 + sec(6));
    expect(view.items).toEqual([
      { kind: "file", id: "i1", name: "Deck.pptx", type: "pptx", size: 10, show: "deck", derived: null },
      { kind: "link", id: "i2", url: "https://www.vevox.com/", title: "Vevox" },
    ]);
    expect(JSON.stringify(view)).not.toContain("deck-1");
    expect(JSON.stringify(view)).not.toContain(DEMO_ITEMS.link.id);
  });
});

describe("Screen object schema steps", () => {
  const { file: _, ...rest } = { file: DECK, approvedAt: 1, endsAt: 2, openMode: null, firstOpenAt: null, mints: 0 };
  const v1Session = { file: DECK, ...rest };
  /** The same session in the current shape: links minted per item, the first included. */
  const { mints: _mints, ...current } = rest;
  const link = { tokenHash: "h", purpose: "protocol", mintedAt: 0, firstFetchAt: null, fetches: 0, revoked: false };
  const seq = { phone: 0, screen: 0 };
  /** What step 8 adds: a session's phone extras and start clock, and a stored deck's kind and flags. */
  const S8 = { extra: {}, firstShownAt: null, startedAt: null, startBy: null };
  const deck8 = { ...asStored(DECK), show: "deck" as const, derived: null };

  it("turns a stored single file into a one-item list and gives each link record item 0", () => {
    const store = kv({ meta: { mode: "demo" }, machine: { state: "approved", session: v1Session }, links: [link] });
    migrate(store);
    expect((store.map.get("machine") as Machine).session).toEqual({
      ...current,
      items: [deck8],
      minted: [1],
      shown: null,
      seq,
      ...S8,
    });
    expect(store.map.get("links")).toEqual([{ ...link, item: 0, ips: [], refused: false }]);
    expect(store.map.get(SCHEMA_KEY)).toBe(SCHEMA_VERSION);
  });

  it("leaves a machine with no session alone, and runs once", () => {
    const store = kv({ meta: {}, machine: { state: "waiting", session: null } });
    migrate(store);
    expect(store.map.get("machine")).toEqual({ state: "waiting", session: null, v: 0, upload: null });
    const current = {
      state: "approved",
      v: 0,
      upload: null,
      session: { items: [{ ...VEVOX, id: "i1" }], shown: null, seq, ...S8 },
    };
    store.put("machine", current);
    migrate(store);
    expect(store.map.get("machine")).toBe(current);
  });

  it("versions 2 to 4: a session-wide extra count stands for every item, then the launch item's free first link is added", () => {
    const v2 = { items: [asItem(DECK), VEVOX], approvedAt: 1, endsAt: 2, openMode: null, firstOpenAt: null, mints: 3 };
    const store = kv({ meta: {}, schemaVersion: 2, machine: { state: "open", session: v2 } });
    migrate(store);
    const session = (store.map.get("machine") as Machine).session;
    expect(session?.minted).toEqual([4, 3]);
    expect(session && "mints" in session).toBe(false);
    expect(store.map.get(SCHEMA_KEY)).toBe(SCHEMA_VERSION);
  });

  it("version 3 to 4: extras per item become links per item, the launch item's first included", () => {
    const v3 = {
      items: [asItem(DECK), VEVOX],
      approvedAt: 1,
      endsAt: 2,
      openMode: null,
      firstOpenAt: null,
      mints: [2, 0],
    };
    const store = kv({ meta: {}, schemaVersion: 3, machine: { state: "open", session: v3 } });
    migrate(store);
    expect((store.map.get("machine") as Machine).session?.minted).toEqual([3, 0]);
  });

  it("version 5 to 6: items gain ids in stored order, the session gains a null `shown` and a zero `seq`", () => {
    const v5 = { ...current, items: [asItem(DECK), VEVOX], minted: [1, 0] };
    const store = kv({ meta: {}, schemaVersion: 5, machine: { state: "open", session: v5 } });
    migrate(store);
    const session = (store.map.get("machine") as Machine).session;
    expect(session?.items.map((i) => i.id)).toEqual(["i1", "i2"]);
    expect(session?.shown).toBeNull();
    expect(session?.seq).toEqual(seq);
  });

  it("PAIR-13 version 6 keeps a `shown` this session could have set, and repairs any other to null", () => {
    /** A demo owner's open session holding the deck (SLIDES.length pages) and a link, with this `shown` and `seq`. */
    const stored = (shown: unknown, items: unknown[] = [asStored(DECK), { ...VEVOX, id: "i2" }], s: unknown = seq) =>
      kv({
        meta: {},
        machine: {
          state: "open",
          mode: "demo",
          pairing: { kind: "owner" },
          session: { ...current, items, minted: [1, 0], shown, seq: s },
        },
      });
    const migrated = (store: ReturnType<typeof kv>) => {
      migrate(store);
      return (store.map.get("machine") as Machine).session;
    };
    const good = { item: "i1", page: 2, present: true };
    expect(migrated(stored(good))?.shown).toEqual(good);
    for (const bad of [
      { x: 1 },
      { ...good, page: 0 },
      { ...good, page: SLIDES.length + 1 },
      { item: "i2", page: 2, present: false },
      { ...good, item: "i9" },
      { ...good, extra: true },
    ]) {
      expect(migrated(stored(bad))?.shown, JSON.stringify(bad)).toBeNull();
    }
    // The screen's report of a link card (page 1) is a `shown` this session could have set.
    const card = { item: "i2", page: 1, present: false };
    expect(migrated(stored(card))?.shown).toEqual(card);
    // A list renumbered because an item lacked an id: the old `shown` may name another item now.
    expect(migrated(stored(good, [asItem(DECK), VEVOX]))?.shown).toBeNull();
    expect(migrated(stored(null, [asStored(DECK)], { phone: "x" }))?.seq).toEqual(seq);
    const kept = { phone: 5, screen: 9 };
    expect(migrated(stored(good, undefined, kept))?.seq).toEqual(kept);
  });

  it("PAIR-13 rollback: a link `shown` run through a link=false validator is null, and the current migrate leaves null alone", () => {
    const items = [deck8, { ...VEVOX, id: "i2" }];
    const view = { mode: "demo" as const, kind: "owner" as const };
    const card = { item: "i2", page: 1, present: false };
    // What a build that refused every link would do to the stored report: it cannot stand there.
    expect(shownFault(items, card, view, false)).toBe("file_not_found");
    expect(shownFault(items, card, view, true)).toBeNull();
    // The repaired (null) `shown` is current-shape data: waking again changes nothing.
    const store = kv({
      meta: {},
      schemaVersion: SCHEMA_VERSION,
      machine: {
        state: "open",
        mode: "demo",
        v: 2,
        upload: null,
        pairing: { kind: "owner", match: "42", confirmed: true, choices: null, phoneSession: null },
        session: { ...current, items, minted: [1, 0], shown: null, seq, ...S8 },
      },
    });
    const before = store.map.get("machine");
    migrate(store);
    expect(store.map.get("machine")).toBe(before);
  });

  it("version 6 to 7: a machine without a whole-number `v` starts it at 0, and one that has it keeps it", () => {
    for (const bad of [undefined, "3", 1.5, null, Number.NaN]) {
      const store = kv({ meta: {}, schemaVersion: 6, machine: { state: "waiting", session: null, v: bad } });
      migrate(store);
      expect((store.map.get("machine") as Machine).v, String(bad)).toBe(0);
    }
    const store = kv({ meta: {}, schemaVersion: 6, machine: { state: "waiting", session: null, v: 12 } });
    migrate(store);
    expect((store.map.get("machine") as Machine).v).toBe(12);
    expect(store.map.get(SCHEMA_KEY)).toBe(SCHEMA_VERSION);
  });

  it("repairs old-shape data whatever the stored version says (a rollback wrote v1 data under version 3)", () => {
    const store = kv({
      meta: {},
      schemaVersion: SCHEMA_VERSION,
      machine: { state: "approved", session: v1Session },
      links: [link],
    });
    migrate(store);
    expect((store.map.get("machine") as Machine).session).toEqual({
      ...current,
      items: [deck8],
      minted: [1],
      shown: null,
      seq,
      ...S8,
    });
    expect(store.map.get("links")).toEqual([{ ...link, item: 0, ips: [], refused: false }]);
  });

  it("version 4 to 5: a link record gains an empty view-link audit state, and one that has it keeps it", () => {
    const kept = { ...link, item: 1, ips: ["x"], refused: true };
    const store = kv({ meta: {}, schemaVersion: 4, links: [{ ...link, item: 0 }, kept] });
    migrate(store);
    expect(store.map.get("links")).toEqual([{ ...link, item: 0, ips: [], refused: false }, kept]);
    expect(store.map.get(SCHEMA_KEY)).toBe(SCHEMA_VERSION);
  });

  it("a current-shape object writes nothing on wake", () => {
    const store = kv({
      meta: { linkOrigin: "file" },
      schemaVersion: SCHEMA_VERSION,
      machine: {
        state: "open",
        v: 3,
        upload: null,
        session: { ...current, items: [deck8], minted: [1], shown: null, seq, ...S8 },
      },
      links: [{ ...link, item: 0, ips: [], refused: false }],
    });
    const writes: string[] = [];
    migrate({
      get: store.get,
      put: (k, v) => {
        writes.push(k);
        store.put(k, v);
      },
    });
    expect(writes).toEqual([]);
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
  const approve = (m: Machine, items: ItemDraft[]) =>
    transition(m, { e: "approve", now: T0 + sec(5), items, minutes: MAX_MINUTES }, CFG);

  it("orders files by name, then links, and launches the first file", () => {
    const step = approve(claimedOwner(), [VEVOX, asItem(DECK), DOG, PDF]);
    if (!step.ok) throw new Error(step.error);
    expect(step.next.session?.items.map((i) => i.ref)).toEqual(["pdf-1", "deck-1", "dog-1", DEMO_ITEMS.link.id]);
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

  it("SRC-02 idor: a live approve needs its item in the listed ids", () => {
    const listed = must(claimedOwner("live"), { e: "listed", now: T0 + sec(2), ids: ["deck-1"] }).next;
    expect(approve(listed, [PDF])).toEqual({ ok: false, error: "file_not_found" });
    expect(approve(listed, [asItem(DECK)]).ok).toBe(true);
  });

  it("a live session takes exactly one file: a live screen has no viewer to reach a second item or a link", () => {
    const listed = must(claimedOwner("live"), {
      e: "listed",
      now: T0 + sec(2),
      ids: ["deck-1", "pdf-1", DEMO_ITEMS.link.id],
    }).next;
    expect(approve(listed, [asItem(DECK), PDF])).toEqual({ ok: false, error: "bad_request" });
    expect(approve(listed, [VEVOX])).toEqual({ ok: false, error: "bad_request" });
    expect(approve(listed, [asItem(DECK), VEVOX])).toEqual({ ok: false, error: "bad_request" });
    expect(approve(listed, [PDF]).ok).toBe(true);
    // The demo has the viewer, so it keeps the whole list.
    expect(approve(claimedOwner("demo"), [asItem(DECK), PDF, VEVOX]).ok).toBe(true);
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
    // Another item's fallback leaves the launched item's served mode alone.
    expect(dog.ok && dog.next.session?.openMode).toBe("protocol");
    const launched = fallback(null);
    expect(launched.ok && fx(launched.effects, "mint")).toEqual([{ fx: "mint", purpose: "download", item: 0 }]);
    expect(launched.ok && launched.next.session?.openMode).toBe("download");
    // The served mode, not the asked one: a deck's view is its PDF rendition.
    const view = transition(opening, { e: "fallback", now: T0 + sec(7), mode: "view", item: null, maxMints: 5 }, CFG);
    expect(view.ok && view.next.session?.openMode).toBe("pdf");
  });

  it("PC-02 sid-powers: every item's first link is free, then maxMints more; one item spent leaves the others theirs", () => {
    const step = approve(claimedOwner(), [asItem(DECK), PDF]);
    if (!step.ok) throw new Error(step.error);
    // The approval's protocol link is item 0's first.
    expect(step.next.session?.minted).toEqual([1, 0]);
    let m = must(step.next, { e: "launched", now: T0 + sec(6), mode: "protocol" }).next;
    const mint = (item: number) =>
      transition(m, { e: "fallback", now: T0 + sec(7), mode: "download", item, maxMints: 2 }, CFG);
    const take = (item: number) => {
      const ok = mint(item);
      if (!ok.ok) throw new Error(ok.error);
      m = ok.next;
    };
    take(0);
    take(0);
    expect(mint(0)).toEqual({ ok: false, error: "mint_limit" });
    expect(m.session?.minted).toEqual([3, 0]);
    // A non-launch item: its first link plus maxMints more, so 3 here, then the limit.
    take(1);
    take(1);
    take(1);
    expect(m.session?.minted).toEqual([3, 3]);
    expect(mint(1)).toEqual({ ok: false, error: "mint_limit" });
  });

  it("PC-02 sid-powers: a non-launch item's first link is free even at the smallest budget", () => {
    const step = approve(claimedOwner(), [asItem(DECK), PDF]);
    if (!step.ok) throw new Error(step.error);
    const opening = must(step.next, { e: "launched", now: T0 + sec(6), mode: "protocol" }).next;
    const first = transition(opening, { e: "fallback", now: T0 + sec(7), mode: "pdf", item: 1, maxMints: 1 }, CFG);
    expect(first.ok && first.next.session?.minted).toEqual([1, 1]);
  });

  it("a guest offer is a one-item list", () => {
    expect(offered().session?.items).toEqual([asStored(GUEST_FILE)]);
  });
});
