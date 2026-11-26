// PAIR-16: the screen's view carries the display flags and nothing else, at every depth; the phone-only data (the
// live pick's choices, each item's extras) reaches only the phone's view.
import { describe, expect, it } from "vitest";
import type { Machine } from "../../src/worker/machine.ts";
import { type Meta, phoneView, screenView } from "../../src/worker/views.ts";
import { asItem, CFG, must, sec, T0, waiting } from "./machine-helpers.ts";

const META: Meta = {
  screenRef: "screen-ref-Q",
  mode: "live",
  roomId: null,
  roomName: null,
  screenSecretHash: "x",
  createdAt: T0,
  linkOrigin: "file",
};
const CONFIG = { origin: "https://bloop.example", machine: CFG, library: { largeFileChoiceBytes: 30_000_000 } };
const LIMITS = { dropMaxBytes: 50, maxMinutes: 120 };

/** Values no screen view may hold: a library file id, its version, the user, their sign-in and the session id. */
const FILE_ID = "Fq7Zr2Kd9Lm4Np6Tx8Vb1W";
const VERSION = 31;
const USER = "user-secret-77";
const PHONE_SESSION = "phone-session-public-55";
const SESSION_ID = "session-public-id-99";
const FONT = "Secret Corporate Sans";
const REF = `${FILE_ID}:${VERSION}`;

const claimLive = (kind: "owner" | "guest") =>
  must(waiting("live"), {
    e: "claim",
    now: T0 + sec(1),
    code: "AAAAAA",
    sessionId: SESSION_ID,
    secretHash: "hash",
    match: "42",
    kind,
    userId: kind === "owner" ? USER : null,
    phoneSession: kind === "owner" ? PHONE_SESSION : null,
    passHash: null,
    choices: ["17", "42", "85"],
  }).next;

const pick = (m: Machine) => must(m, { e: "match", now: T0 + sec(2), choice: "42" }).next;

/** Every state a live screen passes through, with conversion flags and phone extras present where they can be. */
function liveStates() {
  const unconfirmed = claimLive("owner");
  const confirmed = pick(unconfirmed);
  const deck = asItem({ source: "library", ref: REF, name: "Talk.pptx", type: "pptx" });
  const approved = must(confirmed, { e: "approve", now: T0 + sec(3), items: [deck], minutes: 60 }).next;
  const converted = must(approved, {
    e: "derivedReady",
    now: T0 + sec(4),
    ref: REF,
    derived: { slides: true, pdf: true, pages: 4, motion: false },
    extra: { notes: true, fontsMissing: [FONT] },
  }).next;
  const shown = must(converted, {
    e: "control",
    now: T0 + sec(5),
    from: "phone",
    seq: 1,
    shown: { item: "i1", page: 2, present: true, via: "viewer" },
  }).next;
  const uploading = must(pick(claimLive("guest")), { e: "upload.start", now: T0 + sec(3), timeoutSeconds: 900 }).next;
  const progress = must(uploading, { e: "upload.progress", now: T0 + sec(4), bytes: 10, total: 100 }).next;
  const ended = must(shown, { e: "end", now: T0 + sec(9), by: "phone" }).next;
  return { waiting: waiting("live"), unconfirmed, confirmed, approved, converted, shown, progress, ended };
}

const SCREEN_KEYS = [
  "choiceBytes",
  "code",
  "confirmed",
  "endReason",
  "endsAt",
  "items",
  "kind",
  "match",
  "mode",
  "now",
  "openMode",
  "room",
  "seq",
  "shown",
  "state",
  "upload",
  "v",
];
const FILE_KEYS = ["derived", "id", "kind", "name", "show", "size", "type"];
const DERIVED_KEYS = ["motion", "pages", "pdf", "slides"];
const UPLOAD_KEYS = ["bytes", "total"];
const ROOM_KEYS = ["name", "registered"];
const CODE_KEYS = ["code", "expiresAt", "qrUrl"];
const SHOWN_KEYS = ["item", "page", "play", "present", "sound", "via"];

const keys = (v: object) => Object.keys(v).sort();

/** Every key and every string or number leaf, at any depth. */
function leaves(v: unknown, out: { keys: string[]; values: (string | number)[] } = { keys: [], values: [] }) {
  if (typeof v === "string" || typeof v === "number") out.values.push(v);
  else if (Array.isArray(v)) for (const x of v) leaves(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.keys.push(k);
      leaves(x, out);
    }
  }
  return out;
}

describe("PAIR-16 view: the screen sees display flags only", () => {
  const states = Object.entries(liveStates());

  it("PAIR-16 view: the ScreenView key set equals an exact literal, recursively, for items, derived and upload", () => {
    for (const [name, m] of states) {
      const view = screenView(META, m, CONFIG, T0 + sec(10));
      expect(keys(view), name).toEqual(SCREEN_KEYS);
      expect(keys(view.room), name).toEqual(ROOM_KEYS);
      if (view.code) expect(keys(view.code), name).toEqual(CODE_KEYS);
      if (view.upload) expect(keys(view.upload), name).toEqual(UPLOAD_KEYS);
      if (view.shown) expect(SHOWN_KEYS, name).toEqual(expect.arrayContaining(keys(view.shown)));
      for (const item of view.items) {
        expect(keys(item), name).toEqual(FILE_KEYS);
        if (item.kind === "file" && item.derived) expect(keys(item.derived), name).toEqual(DERIVED_KEYS);
      }
    }
    // The fixtures reach every optional part, so none of the checks above is vacuous.
    const all = states.map(([, m]) => screenView(META, m, CONFIG, T0 + sec(10)));
    expect(all.some((v) => v.code && v.upload === null)).toBe(true);
    expect(all.some((v) => v.upload !== null)).toBe(true);
    expect(all.some((v) => v.shown !== null)).toBe(true);
    expect(all.some((v) => v.items.some((i) => i.kind === "file" && i.derived !== null))).toBe(true);
  });

  it("PAIR-16 view: no value anywhere in a screen view is a file id, version, user, sign-in or session id", () => {
    for (const [name, m] of states) {
      const view = screenView(META, m, CONFIG, T0 + sec(10));
      const { values } = leaves(view);
      const text = JSON.stringify(view);
      for (const secret of [FILE_ID, REF, USER, PHONE_SESSION, SESSION_ID, FONT]) {
        expect(text.includes(secret), `${name}: ${secret}`).toBe(false);
      }
      expect(values.includes(VERSION), name).toBe(false);
    }
  });

  it("PAIR-16 view: a ScreenView never holds the phone-only extras or the pick's choices, at any depth", () => {
    const phoneOnly = ["extra", "choices", "notes", "fontsMissing", "firstShownAt", "userId", "ref", "source"];
    for (const [name, m] of states) {
      const found = leaves(screenView(META, m, CONFIG, T0 + sec(10))).keys.filter((k) => phoneOnly.includes(k));
      expect(found, name).toEqual([]);
    }
    // They exist, and the phone's view carries them, so the screen's lacking them is a real exclusion.
    const converted = phoneView(META, liveStates().converted, T0 + sec(10), LIMITS);
    expect(converted?.items[0]).toMatchObject({ extra: { notes: true, fontsMissing: [FONT] } });
    expect(phoneView(META, liveStates().unconfirmed, T0 + sec(10), LIMITS)?.choices).toHaveLength(3);
  });

  it("PAIR-16 view: the PhoneView of a live unconfirmed pairing has no match, only the three choices", () => {
    const { unconfirmed, confirmed } = liveStates();
    const before = phoneView(META, unconfirmed, T0 + sec(2), LIMITS);
    expect(before).toMatchObject({ match: null, confirmed: false, choices: ["17", "42", "85"] });
    // The screen shows the number to pick; the ring is open.
    expect(screenView(META, unconfirmed, CONFIG, T0 + sec(2))).toMatchObject({ match: "42", confirmed: false });
    const after = phoneView(META, confirmed, T0 + sec(3), LIMITS);
    expect(after).toMatchObject({ match: "42", confirmed: true, choices: null });
    expect(screenView(META, confirmed, CONFIG, T0 + sec(3)).confirmed).toBe(true);
  });

  it("PAIR-16 view: a demo pairing and one stored before the pick read confirmed, with the match", () => {
    const demo = must(waiting("demo"), {
      e: "claim",
      now: T0 + sec(1),
      code: "AAAAAA",
      sessionId: "s",
      secretHash: "h",
      match: "42",
      kind: "owner",
      userId: null,
      passHash: null,
    }).next;
    const old = { ...demo, mode: "live", pairing: demo.pairing && { ...demo.pairing, confirmed: undefined } };
    for (const m of [demo, old as unknown as Machine]) {
      expect(phoneView(META, m, T0 + sec(2), LIMITS)).toMatchObject({ match: "42", choices: null, confirmed: true });
    }
    expect(screenView(META, waiting("live"), CONFIG, T0).confirmed).toBe(false);
  });

  it("the upload shows on the screen while uploading only, and the choice threshold is the config's", () => {
    const { progress } = liveStates();
    expect(screenView(META, progress, CONFIG, T0 + sec(5)).upload).toEqual({ bytes: 10, total: 100 });
    const stale = { ...progress, state: "claimed" as const };
    expect(screenView(META, stale, CONFIG, T0 + sec(5)).upload).toBeNull();
    expect(screenView(META, progress, CONFIG, T0).choiceBytes).toBe(30_000_000);
  });

  it("firstShownAt reaches the phone, set by the first shown", () => {
    const { shown, converted } = liveStates();
    expect(phoneView(META, converted, T0 + sec(6), LIMITS)?.firstShownAt).toBeNull();
    expect(phoneView(META, shown, T0 + sec(6), LIMITS)?.firstShownAt).toBe(T0 + sec(5));
  });
});
