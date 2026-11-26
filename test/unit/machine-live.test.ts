// A live library session in the machine: approve, derived flags, upload progress, the remote, the start (P1.4).
import { describe, expect, it } from "vitest";
import type { DerivedFlags, Shown } from "../../src/shared/protocol.ts";
import type { ItemDraft } from "../../src/worker/items.ts";
import { type Event, type FileRef, type Machine, nextDeadline, transition } from "../../src/worker/machine.ts";
import { asItem, CFG, fx, MAX_MINUTES, must, sec, T0, VEVOX, waiting } from "./machine-helpers.ts";

const NOW = T0 + sec(5);
const ref = (n: number) => `${String(n).padStart(22, "A")}:1`;
const libFile = (n: number, over: Partial<FileRef> = {}): FileRef => ({
  source: "library",
  ref: ref(n),
  name: `Talk ${n}.pptx`,
  type: "pptx",
  ...over,
});
const lib = (n: number, over: Partial<FileRef> = {}) => asItem(libFile(n, over));
const SLIDES: DerivedFlags = { slides: true, pdf: true, pages: 40, motion: false };

function confirmedLive(kind: "owner" | "guest" = "owner"): Machine {
  const claimed = must(waiting("live"), {
    e: "claim",
    now: T0 + sec(1),
    code: "AAAAAA",
    sessionId: "s1",
    secretHash: "hash",
    match: "42",
    kind,
    userId: kind === "owner" ? "u1" : null,
    passHash: null,
    choices: ["17", "42", "85"],
  }).next;
  return must(claimed, { e: "match", now: T0 + sec(2), choice: "42" }).next;
}
const approve = (m: Machine, items: ItemDraft[], now = NOW) =>
  transition(m, { e: "approve", now, items, minutes: MAX_MINUTES }, CFG);
function approvedLive(items: ItemDraft[] = [lib(1), lib(2)]): Machine {
  const step = approve(confirmedLive(), items);
  if (!step.ok) throw new Error(step.error);
  return step.next;
}
const refused = (m: Machine, ev: Event) => {
  const step = transition(m, ev, CFG);
  return step.ok ? null : step.error;
};
const control = (from: "phone" | "screen", seq: number, shown: Shown, now = NOW + sec(1)): Event => ({
  e: "control",
  now,
  from,
  seq,
  shown,
});

describe("machine-live approve", () => {
  it("12 library items approve in the given order; a 13th is bad_request", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => lib(12 - i));
    const m = approvedLive(twelve);
    expect(m.session?.items.map((i) => i.ref)).toEqual(twelve.map((i) => i.ref));
    const thirteen = [...twelve, lib(13)];
    expect(approve(confirmedLive(), thirteen)).toEqual({ ok: false, error: "bad_request" });
  });

  it("library files with links among them keep their order; the pinned user never changes", () => {
    const m = approvedLive([lib(2), VEVOX, lib(1)]);
    expect(m.session?.items.map((i) => i.ref)).toEqual([ref(2), "demo-vevox", ref(1)]);
    expect(m.pairing?.userId).toBe("u1");
  });

  it("transitional: a live list that is not Up Next takes one listed file, as before", () => {
    const mock = asItem({ source: "mock", ref: "deck-1", name: "Deck.pptx", type: "pptx" });
    expect(approve(confirmedLive(), [mock])).toEqual({ ok: false, error: "file_not_found" });
    expect(approve(confirmedLive(), [mock, lib(1)])).toEqual({ ok: false, error: "bad_request" });
  });

  it("purge never names a library item, at any end of the session", () => {
    const m = approvedLive();
    const ends: Event[] = [
      { e: "end", now: NOW + sec(1), by: "phone" },
      { e: "end", now: NOW + sec(1), by: "system" },
      { e: "timer", now: NOW + MAX_MINUTES * 60_000 },
    ];
    for (const ev of ends) {
      const effects = transition(m, ev, CFG);
      if (!effects.ok) throw new Error(effects.error);
      expect(fx(effects.effects, "purge"), ev.e).toEqual([]);
    }
  });
});

describe("machine-live derivedReady", () => {
  const extra = { notes: true, fontsMissing: ["Gill Sans"] };
  const ready = (m: Machine, r: string, derived: unknown = SLIDES, x: unknown = extra) =>
    transition(m, { e: "derivedReady", now: NOW + sec(2), ref: r, derived, extra: x } as Event, CFG);

  it("updates only the item with that ref, keeps the extras apart, and pushes both", () => {
    const m = approvedLive();
    const step = ready(m, ref(2));
    if (!step.ok) throw new Error(step.error);
    const [first, second] = step.next.session?.items ?? [];
    expect(first?.kind === "file" && first.derived).toBeFalsy();
    expect(second?.kind === "file" && second.derived).toEqual(SLIDES);
    expect(step.next.session?.extra).toEqual({ i2: extra });
    expect(step.effects).toEqual([{ fx: "push", to: "both" }]);
  });

  it("a ref no item holds is a stale call and changes nothing; a shape fault is bad_request", () => {
    const m = approvedLive();
    const stale = ready(m, ref(9));
    expect(stale.ok && stale.next).toBe(m);
    expect(ready(m, ref(1), { ...SLIDES, email: "x" })).toEqual({ ok: false, error: "bad_request" });
    expect(ready(m, ref(1), { ...SLIDES, pages: 0 })).toEqual({ ok: false, error: "bad_request" });
    expect(ready(m, ref(1), SLIDES, { notes: "yes", fontsMissing: [] })).toEqual({ ok: false, error: "bad_request" });
    const fonts = Array.from({ length: 51 }, (_, i) => `F${i}`);
    expect(ready(m, ref(1), SLIDES, { notes: false, fontsMissing: fonts })).toEqual({
      ok: false,
      error: "bad_request",
    });
  });
});

describe("machine-live upload.progress", () => {
  const uploading = () => must(confirmedLive("guest"), { e: "upload.start", now: NOW, timeoutSeconds: 900 }).next;
  const progress = (m: Machine, bytes: number, total = 100) =>
    transition(m, { e: "upload.progress", now: NOW + sec(1), bytes, total }, CFG);

  it("is monotonic: a lower or equal count changes nothing, a higher one pushes the screen only", () => {
    const up = must(uploading(), { e: "upload.progress", now: NOW, bytes: 40, total: 100 });
    expect(up.next.upload).toEqual({ bytes: 40, total: 100 });
    expect(up.effects).toEqual([{ fx: "push", to: "screen" }]);
    for (const bytes of [10, 40]) {
      const step = progress(up.next, bytes);
      expect(step.ok && step.next, String(bytes)).toBe(up.next);
    }
    expect(must(up.next, { e: "upload.progress", now: NOW, bytes: 70, total: 100 }).next.upload?.bytes).toBe(70);
  });

  it("refuses counts that are not safe integers or past the total, and any state but uploading", () => {
    const up = uploading();
    for (const [bytes, total] of [
      [-1, 100],
      [101, 100],
      [1.5, 100],
      [0, Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      expect(progress(up, bytes, total), `${bytes}/${total}`).toEqual({ ok: false, error: "bad_request" });
    }
    expect(refused(confirmedLive(), { e: "upload.progress", now: NOW, bytes: 1, total: 2 })).toBe("wrong_state");
  });

  it("UP-09 resume: a failed send goes back to the claim with the pick, code and pairing kept, and can start again", () => {
    const up = must(uploading(), { e: "upload.progress", now: NOW, bytes: 40, total: 100 }).next;
    const failed = must(up, { e: "upload.failed", now: NOW + sec(2), error: "upload_aborted" }).next;
    expect(failed.state).toBe("claimed");
    expect(failed.upload).toBeNull();
    expect(failed.pairing).toMatchObject({ confirmed: true, sessionId: "s1", secretHash: "hash" });
    expect(failed.codes).toEqual(up.codes);
    expect(must(failed, { e: "upload.start", now: NOW + sec(3), timeoutSeconds: 900 }).next.state).toBe("uploading");
  });
});

describe("machine-live control", () => {
  const deck = (page = 1, via?: "viewer" | "app"): Shown => ({
    item: "i1",
    page,
    present: true,
    ...(via ? { via } : {}),
  });

  it("takes the confirmed owner's phone and the screen's own report, for a deck, PDF or doc", () => {
    const m = approvedLive();
    expect(must(m, control("phone", 1, deck(1))).next.session?.shown).toEqual(deck(1));
    expect(must(m, control("screen", 1, deck(1))).next.session?.shown).toEqual(deck(1));
  });

  it("refuses a guest's phone and an item the viewer does not page through", () => {
    const photo = approvedLive([lib(1, { name: "Photo.jpg", type: "jpg" })]);
    expect(refused(photo, control("screen", 1, deck(1)))).toBe("wrong_state");
    const guest = {
      ...approvedLive(),
      pairing: { ...(approvedLive().pairing as NonNullable<Machine["pairing"]>), kind: "guest" as const },
    };
    expect(refused(guest, control("phone", 1, deck(1)))).toBe("wrong_state");
  });

  it("reads the pages from the derived flags, and takes via only for a deck with slides", () => {
    const m = approvedLive();
    expect(refused(m, control("phone", 1, deck(2)))).toBe("bad_request");
    expect(refused(m, control("phone", 1, deck(1, "app")))).toBe("bad_request");
    const ready = must(m, {
      e: "derivedReady",
      now: NOW,
      ref: ref(1),
      derived: SLIDES,
      extra: { notes: false, fontsMissing: [] },
    }).next;
    expect(must(ready, control("phone", 1, deck(40, "viewer"))).next.session?.shown).toEqual(deck(40, "viewer"));
    expect(refused(ready, control("phone", 2, deck(41)))).toBe("bad_request");
    const noSlides = must(m, {
      e: "derivedReady",
      now: NOW,
      ref: ref(1),
      derived: { ...SLIDES, slides: false },
      extra: { notes: false, fontsMissing: [] },
    }).next;
    expect(refused(noSlides, control("phone", 1, deck(1, "app")))).toBe("bad_request");
  });

  it("sets firstShownAt with the first applied shown and never moves it", () => {
    const first = must(approvedLive(), control("phone", 1, deck(1), NOW + sec(1))).next;
    expect(first.session?.firstShownAt).toBe(NOW + sec(1));
    const ready = must(first, {
      e: "derivedReady",
      now: NOW,
      ref: ref(1),
      derived: SLIDES,
      extra: { notes: false, fontsMissing: [] },
    }).next;
    const later = must(ready, control("screen", 5, deck(3), NOW + sec(9))).next;
    expect(later.session?.firstShownAt).toBe(NOW + sec(1));
  });

  it("REL-13 an older seq never rewinds shown, for screen reports in a live library session", () => {
    const m = must(approvedLive(), {
      e: "derivedReady",
      now: NOW,
      ref: ref(1),
      derived: SLIDES,
      extra: { notes: false, fontsMissing: [] },
    }).next;
    const at17 = must(m, control("screen", 200, deck(17))).next;
    const late = transition(at17, control("screen", 150, deck(3)), CFG);
    expect(late.ok && late.next).toBe(at17);
    expect(at17.session?.shown?.page).toBe(17);
  });
});

describe("REL-16 the start", () => {
  const start = (effects: { fx: string }[]) => effects.filter((e) => e.fx === "start");

  it("REL-16 a failed start writes one data point with a cause and no personal data, for every cause", () => {
    const by = (m: Machine) => m.session?.startBy as number;
    const plain = approvedLive();
    expect(nextDeadline(plain, CFG)).toBe(NOW + sec(15));
    const launched = must(plain, { e: "launched", now: NOW + sec(1), mode: "protocol" }).next;
    const refusedLink = must(plain, { e: "started", now: NOW + sec(1), cause: "fetch_refused" }).next;
    const mainOrigin = must(plain, { e: "started", now: NOW + sec(1), cause: "fo_fallback" }).next;
    for (const [m, cause] of [
      [plain, "timeout"],
      [launched, "launch_no_fetch"],
      [refusedLink, "fetch_refused"],
      [mainOrigin, "fo_fallback"],
    ] as const) {
      const { next, effects } = must(m, { e: "timer", now: by(m) });
      expect(effects, cause).toEqual([{ fx: "start", ok: false, cause }]);
      expect(next.state, cause).toBe(m.state);
      expect(next.session?.startBy).toBeNull();
      // One point per session: a later fetch starts it and writes nothing more.
      const after =
        m.state === "opening" || m.state === "approved" ? must(next, { e: "fetched", now: by(m) + 1 }) : null;
      if (after) expect(start(after.effects), cause).toEqual([]);
    }
  });

  it("REL-16 start ok on the first fetch or the screen's first report, once, and no deadline after", () => {
    const fetched = must(approvedLive(), { e: "fetched", now: NOW + sec(2) });
    expect(start(fetched.effects)).toEqual([{ fx: "start", ok: true, cause: null }]);
    expect(fetched.next.session?.startedAt).toBe(NOW + sec(2));
    expect(nextDeadline(fetched.next, CFG)).toBe(fetched.next.session?.endsAt);
    const reported = must(approvedLive(), control("screen", 1, { item: "i1", page: 1, present: true }));
    expect(start(reported.effects)).toEqual([{ fx: "start", ok: true, cause: null }]);
    const again = must(reported.next, control("screen", 2, { item: "i1", page: 1, present: false }));
    expect(start(again.effects)).toEqual([]);
    const phone = must(approvedLive(), control("phone", 1, { item: "i1", page: 1, present: true }));
    expect(start(phone.effects)).toEqual([]);
  });
});
