// Schema step 8 (plan P1.5): the live pick, item kinds and conversion flags, upload progress, the start clock, the
// link origin and unknown link purposes. Every malformed shape is repaired, at any stored version, and a repaired
// store wakes again with no write.
import { describe, expect, it } from "vitest";
import { migrate, SCHEMA_KEY, SCHEMA_VERSION } from "../../src/worker/do/schema.ts";
import type { Machine } from "../../src/worker/machine.ts";
import { asStored, DECK, T0 } from "./machine-helpers.ts";
import { memKv } from "./sqlite.ts";

const REF = "Fq7Zr2Kd9Lm4Np6Tx8Vb1W:3";
const LINK = {
  tokenHash: "h",
  purpose: "protocol",
  item: 0,
  mintedAt: 0,
  firstFetchAt: null,
  fetches: 0,
  revoked: false,
  ips: [],
  refused: false,
};
const library = { kind: "file", id: "i1", source: "library", ref: REF, name: "Talk.pptx", type: "pptx" } as const;

/** A live open session in the version 8 shape: nothing for step 8 to do. */
function current(): Record<string, unknown> {
  return {
    meta: { mode: "live", linkOrigin: "file" },
    schemaVersion: SCHEMA_VERSION,
    links: [LINK],
    machine: {
      state: "open",
      mode: "live",
      v: 4,
      sockets: 1,
      upload: null,
      pairing: {
        kind: "owner",
        match: "42",
        userId: "u1",
        phoneSession: "ps1",
        listed: [],
        passHash: null,
        confirmed: true,
        choices: null,
      },
      session: {
        items: [{ ...library, show: "deck", derived: { slides: true, pdf: false, pages: 9, motion: false } }],
        approvedAt: T0,
        endsAt: T0 + 60_000,
        openMode: "protocol",
        firstOpenAt: T0,
        minted: [1],
        shown: null,
        seq: { phone: 0, screen: 0 },
        extra: { i1: { notes: true, fontsMissing: [] } },
        firstShownAt: T0 + 5,
        startedAt: T0 + 5,
        startBy: null,
      },
    },
  };
}

/** `current()` with one path replaced, migrated; answers the store and the keys written. */
function wake(edit: (s: ReturnType<typeof current>) => void, now = T0 + 1000) {
  const entries = current();
  edit(entries);
  const store = memKv(structuredClone(entries));
  const writes: string[] = [];
  migrate(
    {
      get: store.get,
      put: (k, v) => {
        writes.push(k);
        store.put(k, v);
      },
    },
    now,
  );
  return {
    machine: store.data.get("machine") as Machine,
    meta: store.data.get("meta") as { linkOrigin: unknown },
    links: store.data.get("links") as (typeof LINK)[],
    /** The stored entries after the wake, in the shape `current()` builds. */
    after: Object.fromEntries(store.data) as Record<string, unknown>,
    writes,
    again: () => {
      const more: string[] = [];
      migrate({ get: store.get, put: (k) => void more.push(k) }, now + 1);
      return more;
    },
  };
}

/** A case's marker for a key deleted rather than set. */
const GONE = Symbol("gone");

const m = (s: Record<string, unknown>) => s.machine as Record<string, unknown>;
const session = (s: Record<string, unknown>) => m(s).session as Record<string, unknown>;
const pairing = (s: Record<string, unknown>) => m(s).pairing as Record<string, unknown>;
const item = (s: Record<string, unknown>) =>
  (session(s).items as Record<string, unknown>[])[0] as Record<string, unknown>;

describe("schema-8", () => {
  it("schema-8: a store already in the version 8 shape writes nothing", () => {
    const { writes } = wake(() => {});
    expect(writes).toEqual([]);
  });

  it("schema-8: every malformed pairing, upload and session clock is repaired, and a second run writes nothing", () => {
    type At = (s: Record<string, unknown>) => Record<string, unknown>;
    const meta: At = (s) => s.meta as Record<string, unknown>;
    // [where, key, the malformed value (GONE: the key deleted), what step 8 leaves there]
    const cases: [At, string, unknown, unknown][] = [
      [pairing, "confirmed", GONE, true],
      [pairing, "confirmed", "yes", true],
      [pairing, "choices", ["17", "42"], null],
      [pairing, "choices", ["42", "42", "17"], null],
      [pairing, "choices", ["17", "18", "19"], null],
      [pairing, "choices", ["1", "42", "ab"], null],
      [pairing, "choices", "42", null],
      [pairing, "phoneSession", 3, null],
      [m, "upload", GONE, null],
      [m, "upload", { bytes: 5, total: 4 }, null],
      [m, "upload", { bytes: -1, total: 4 }, null],
      [m, "upload", { bytes: 1.5, total: 4 }, null],
      [m, "upload", { bytes: 1, total: 4, x: 1 }, null],
      [item, "show", GONE, "deck"],
      [item, "show", "hologram", "deck"],
      [item, "derived", GONE, null],
      [item, "derived", { slides: true, pdf: false, pages: 9, motion: false, fileId: "x" }, null],
      [item, "derived", { slides: true, pdf: false, pages: 0, motion: false }, null],
      [session, "extra", [], {}],
      [session, "extra", { i1: { notes: "y", fontsMissing: [] } }, {}],
      [session, "extra", GONE, {}],
      [session, "firstShownAt", "now", null],
      [session, "startedAt", 1.5, null],
      [session, "startBy", GONE, null],
      [meta, "linkOrigin", GONE, "file"],
      [meta, "linkOrigin", "evil.example", "file"],
    ];
    for (const [at, key, bad, want] of cases) {
      const name = `${key} = ${bad === GONE ? "missing" : JSON.stringify(bad)}`;
      const r = wake((s) => {
        if (bad === GONE) delete at(s)[key];
        else at(s)[key] = bad;
      });
      expect(at(r.after)[key], name).toEqual(want);
      expect(r.writes.length, name).toBeGreaterThan(0);
      expect(r.again(), `${name}: second run`).toEqual([]);
    }
  });

  it("schema-8: a valid value is kept as it is (choices, upload, derived, the start clock, the main origin)", () => {
    const r = wake((s) => {
      m(s).upload = { bytes: 0, total: 0 };
      (s.meta as Record<string, unknown>).linkOrigin = "main";
    });
    expect(r.machine.upload).toEqual({ bytes: 0, total: 0 });
    expect(r.meta.linkOrigin).toBe("main");
    expect(r.writes).toEqual([]);
    // A live claim waiting on its pick keeps it.
    const waitingPick = wake((s) => {
      Object.assign(m(s), { state: "claimed", session: null });
      Object.assign(pairing(s), { confirmed: false, choices: ["17", "42", "85"] });
    });
    expect(waitingPick.machine.pairing).toMatchObject({ confirmed: false, choices: ["17", "42", "85"] });
    expect(waitingPick.writes).toEqual([]);
  });

  it("schema-8 rollback: an unconfirmed pairing outside the pre-approval states, or on a demo, reads as confirmed", () => {
    // A rolled-back build spread an old pairing over a newer one: an approved talk must not be stranded behind a pick.
    for (const state of ["approved", "opening", "open"]) {
      const r = wake((s) => {
        m(s).state = state;
        Object.assign(pairing(s), { confirmed: false, choices: ["17", "42", "85"] });
      });
      expect(r.machine.pairing, state).toMatchObject({ confirmed: true });
      expect(r.machine.state, state).toBe(state);
      expect(r.again(), state).toEqual([]);
    }
    const demo = wake((s) => {
      Object.assign(m(s), { state: "claimed", mode: "demo", session: null });
      Object.assign(pairing(s), { confirmed: false, choices: null });
    });
    expect(demo.machine).toMatchObject({ state: "claimed", pairing: { confirmed: true, choices: null } });
  });

  it("schema-8: a live claim waiting on its pick with no valid choices ends, so the phone is never stranded", () => {
    for (const choices of [null, ["17", "18", "19"], "42", undefined]) {
      const r = wake((s) => {
        Object.assign(m(s), { state: "claimed", session: null, codes: { current: null, previous: null } });
        Object.assign(pairing(s), { confirmed: false, choices });
      }, T0 + 3000);
      const name = JSON.stringify(choices) ?? "missing";
      expect(r.machine, name).toMatchObject({ state: "ended", endReason: "error", endedAt: T0 + 3000 });
      expect(r.after.corruptEnd, name).toEqual({ codes: { current: null, previous: null } });
      expect(r.again(), name).toEqual([]);
    }
  });

  it("schema-8: session items the build cannot serve end the session instead of throwing (null, constructor, junk)", () => {
    const bad: [string, (s: Record<string, unknown>) => void][] = [
      ["null items", (s) => Object.assign(session(s), { items: null })],
      ["items not a list", (s) => Object.assign(session(s), { items: { 0: library } })],
      ["a null item", (s) => Object.assign(session(s), { items: [null] })],
      ["type constructor", (s) => Object.assign(item(s), { source: "mock", ref: "deck-1", type: "constructor" })],
      ["type __proto__", (s) => Object.assign(item(s), { source: "mock", ref: "deck-1", type: "__proto__" })],
      ["unknown kind", (s) => Object.assign(item(s), { kind: "widget" })],
    ];
    for (const [name, edit] of bad) {
      let r: ReturnType<typeof wake> | undefined;
      expect(() => {
        r = wake(edit, T0 + 2000);
      }, name).not.toThrow();
      expect(r?.machine, name).toMatchObject({ state: "ended", endReason: "error", session: null });
      expect(r?.after.corruptEnd, name).toBeDefined();
      expect(
        r?.links.every((l) => l.revoked),
        name,
      ).toBe(true);
      expect(r?.again(), name).toEqual([]);
    }
  });

  it("schema-8: a library item with a malformed ref ends the session with reason error and revokes every link", () => {
    for (const ref of ["short:1", `${REF}x`, "Fq7Zr2Kd9Lm4Np6Tx8Vb1W", "Fq7Zr2Kd9Lm4Np6Tx8Vb1W:1234567", "../../x:1"]) {
      const r = wake((s) => Object.assign(item(s), { ref }), T0 + 2000);
      expect(r.machine, ref).toMatchObject({ state: "ended", endReason: "error", endedAt: T0 + 2000, session: null });
      expect(r.machine.pairing, ref).toMatchObject({ userId: null, phoneSession: null, listed: [] });
      // The object finishes the end on wake: its audit row, the codes, the push, the demo slot, the alarm.
      expect(r.after.corruptEnd, ref).toEqual({ codes: { current: null, previous: null } });
      expect(
        r.links.every((l) => l.revoked),
        ref,
      ).toBe(true);
      expect(r.again(), ref).toEqual([]);
    }
    // A non-library item keeps any ref: only a library ref names a stored version.
    const graph = wake((s) => Object.assign(item(s), { source: "mock", ref: "deck-1" }));
    expect(graph.machine.state).toBe("open");
  });

  it("schema-8: a link record with a purpose this build does not know is revoked; known ones are kept", () => {
    const r = wake((s) => {
      s.links = [
        LINK,
        { ...LINK, tokenHash: "b", purpose: "bundle" },
        { ...LINK, tokenHash: "z", purpose: "teleport" },
      ];
    });
    expect(r.links.map((l) => [l.purpose, l.revoked])).toEqual([
      ["protocol", false],
      ["bundle", false],
      ["teleport", true],
    ]);
    expect(r.again()).toEqual([]);
  });

  it("schema-8: a version 7 store is upgraded, and a store at 8 holding old-shape data is repaired (the rollback case)", () => {
    // What a version 7 build wrote: no pick, no kinds or flags, no upload, no start clock, no origin.
    const v7 = (version: number) => ({
      meta: { mode: "live" },
      schemaVersion: version,
      links: [LINK],
      machine: {
        state: "approved",
        mode: "live",
        v: 2,
        sockets: 0,
        pairing: { kind: "owner", match: "42", userId: "u1", listed: [], passHash: null },
        session: {
          items: [asStored(DECK)],
          approvedAt: T0,
          endsAt: T0 + 60_000,
          openMode: null,
          firstOpenAt: null,
          minted: [1],
          shown: null,
          seq: { phone: 0, screen: 0 },
        },
      },
    });
    for (const version of [7, SCHEMA_VERSION]) {
      const store = memKv(structuredClone(v7(version)));
      migrate(store, T0);
      const machine = store.data.get("machine") as Machine;
      expect(store.data.get(SCHEMA_KEY), String(version)).toBe(SCHEMA_VERSION);
      expect(machine.pairing, String(version)).toMatchObject({ confirmed: true, choices: null, phoneSession: null });
      expect(machine.upload, String(version)).toBeNull();
      expect(machine.session?.items[0], String(version)).toMatchObject({ show: "deck", derived: null });
      expect(machine.session, String(version)).toMatchObject({
        extra: {},
        firstShownAt: null,
        startedAt: null,
        startBy: null,
      });
      expect((store.data.get("meta") as { linkOrigin: string }).linkOrigin).toBe("file");
      const writes: string[] = [];
      migrate({ get: store.get, put: (k) => void writes.push(k) }, T0 + 1);
      expect(writes, `${version}: second run`).toEqual([]);
    }
  });

  it("schema-8: the idempotency rows are shape-checked on the same wake; a clean store writes nothing", () => {
    const hash = "a".repeat(64);
    const good = { owner: "o", keyHash: hash, bodyHash: hash, at: T0, stored: { pid: "p" } };
    const r = wake((s) => {
      s.idem = [good, { owner: 1 }, null, { ...good, keyHash: "short" }];
    });
    expect(r.writes).toEqual(["idem"]);
    expect(r.again()).toEqual([]);
    const notList = wake((s) => {
      s.idem = "junk";
    });
    expect(notList.writes).toEqual(["idem"]);
  });
});
