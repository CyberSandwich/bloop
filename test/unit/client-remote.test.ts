// The phone's remote state (core/remote.js) and the seq every sender sends (core/demo.js nextSeq), PAIR-13.
import { describe, expect, it } from "vitest";
import { nextSeq, SLIDES } from "../../public/js/core/demo.js";
import { canPresent, command, createRemote, current } from "../../public/js/core/remote.js";
import { DEMO_ITEMS } from "../../src/shared/demo-catalog.ts";
import type { ErrorCode, Item, PhoneView, Shown, ShownCommand } from "../../src/shared/protocol.ts";

const dog: Item = { kind: "file", id: "i1", name: "Dog.jpg", type: "jpg", size: 70_000 };
const pdf: Item = { kind: "file", id: "i2", name: "Handout.pdf", type: "pdf", size: 81_000 };
const deck: Item = { kind: "file", id: "i3", name: DEMO_ITEMS.deck.name, type: "pptx", size: 82_000 };
const vevox: Item = { kind: "link", id: "i4", url: "https://vevox.app/", title: "Vevox" };

const viewOf = (over: Partial<PhoneView> = {}): PhoneView =>
  ({
    state: "open",
    mode: "demo",
    kind: "owner",
    items: [dog, pdf, deck, vevox],
    shown: null,
    seq: 0,
    v: 0,
    now: 100,
    ...over,
  }) as PhoneView;

describe("PAIR-13 seq: each sender sends max(Date.now(), last + 1)", () => {
  it("is the clock when the clock is ahead, so it grows across reloads", () => {
    expect(nextSeq(0, 1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(nextSeq(5, 1_700_000_000_000)).toBe(1_700_000_000_000);
  });
  it("is one above the last when two taps share a millisecond or the clock stepped back", () => {
    expect(nextSeq(1_700_000_000_000, 1_700_000_000_000)).toBe(1_700_000_000_001);
    expect(nextSeq(1_700_000_000_500, 1_700_000_000_000)).toBe(1_700_000_000_501);
  });
  it("reads Date.now by default and never goes below the last", () => {
    const before = Date.now();
    expect(nextSeq(0)).toBeGreaterThanOrEqual(before);
    const ahead = Date.now() + 60_000;
    expect(nextSeq(ahead)).toBe(ahead + 1);
  });
});

describe("the remote's commands", () => {
  it("before any command, the screen shows its first file's first page, as the viewer starts", () => {
    expect(current(viewOf())).toEqual({ item: "i1", page: 1, present: false });
    expect(current(viewOf({ shown: { item: "i3", page: 2, present: true } }))).toEqual({
      item: "i3",
      page: 2,
      present: true,
    });
    expect(current(viewOf({ items: [vevox] }))).toBeNull();
  });

  it("a row puts a file on its first page; a link, or the file already on its first page, sends nothing", () => {
    const v = viewOf();
    const at: Shown = { item: "i3", page: 2, present: false };
    expect(command(v, at, { item: "i2" })).toEqual({ item: "i2", page: 1, present: false, play: true, sound: "on" });
    expect(command(v, at, { item: "i4" })).toBeNull();
    expect(command(v, at, { item: "i3" })).toEqual({ item: "i3", page: 1, present: false, play: true, sound: "on" });
    expect(command(v, { ...at, page: 1 }, { item: "i3" })).toBeNull();
    expect(command(v, at, { item: "nope" })).toBeNull();
  });

  it("the row of the item on screen at a later page goes back to page 1, keeping presenting", () => {
    expect(command(viewOf(), { item: "i3", page: 2, present: true }, { item: "i3" })).toEqual({
      item: "i3",
      page: 1,
      present: true,
      play: true,
      sound: "on",
    });
  });

  it("a new item keeps presenting when it can be presented, and stops on one that cannot", () => {
    const at: Shown = { item: "i3", page: 2, present: true };
    expect(command(viewOf(), at, { item: "i1" })).toEqual({
      item: "i1",
      page: 1,
      present: true,
      play: true,
      sound: "on",
    });
    // A guest's deck is a card on the screen: nothing to present.
    const guestDeck: Item = { ...deck, id: "i1" };
    const guest = viewOf({ kind: "guest", items: [guestDeck, { ...dog, id: "i2" }] });
    expect(command(guest, { item: "i2", page: 1, present: true }, { item: "i1" })).toEqual({
      item: "i1",
      page: 1,
      present: false,
      play: true,
      sound: "on",
    });
    expect(canPresent(guestDeck, guest)).toBe(false);
    expect(canPresent(deck, viewOf())).toBe(true);
    expect(canPresent(dog, guest)).toBe(true);
    expect(canPresent(vevox, viewOf())).toBe(false);
  });

  it("a step pages within the item and is held at either end; a photo has no pages to step", () => {
    const v = viewOf();
    expect(command(v, { item: "i3", page: 1, present: false }, { step: 1 })).toEqual({
      item: "i3",
      page: 2,
      present: false,
    });
    expect(command(v, { item: "i3", page: SLIDES.length, present: false }, { step: 1 })).toBeNull();
    expect(command(v, { item: "i3", page: 1, present: false }, { step: -1 })).toBeNull();
    expect(command(v, { item: "i1", page: 1, present: false }, { step: 1 })).toBeNull();
  });

  it("Present and Stop toggle on what can be presented only", () => {
    const v = viewOf();
    expect(command(v, { item: "i3", page: 2, present: false }, { present: true })).toEqual({
      item: "i3",
      page: 2,
      present: true,
    });
    expect(command(v, { item: "i3", page: 2, present: true }, { present: true })).toEqual({
      item: "i3",
      page: 2,
      present: false,
    });
    const guestDeck = viewOf({ kind: "guest", items: [{ ...deck, id: "i1" }] });
    expect(command(guestDeck, { item: "i1", page: 1, present: false }, { present: true })).toBeNull();
  });
});

describe("VID-05 sound: the remote's play and sound", () => {
  const clip: Item = { kind: "file", id: "i5", name: "Talk.mp4", type: "mp4", size: 5_000_000 };
  const v = viewOf({ kind: "guest", items: [clip, { ...deck, id: "i6" }] });
  const at: Shown = { item: "i5", page: 1, present: false };

  it("VID-05 sound: play pauses a playing video (absent is playing) and plays a paused one", () => {
    expect(command(v, at, { play: true })).toEqual({ ...at, play: false });
    expect(command(v, { ...at, play: false }, { play: true })).toEqual({ ...at, play: true });
  });

  it("VID-05 sound: sound mutes, unmutes, and from the screen's blocked asks for sound", () => {
    expect(command(v, at, { sound: true })).toEqual({ ...at, sound: "off" });
    expect(command(v, { ...at, sound: "off" }, { sound: true })).toEqual({ ...at, sound: "on" });
    expect(command(v, { ...at, sound: "blocked" }, { sound: true })).toEqual({ ...at, sound: "on" });
  });

  it("VID-05 sound: another item starts playing with sound, so a screen holding sound reports blocked anew", () => {
    const paused = { ...at, play: false, sound: "blocked" as const };
    expect(command(v, paused, { item: "i6" })).toEqual({
      item: "i6",
      page: 1,
      present: false,
      play: true,
      sound: "on",
    });
  });
});

type Answer = { ok: true; value: PhoneView } | { ok: false; error: ErrorCode };

/** A remote over a fake page and server: each post waits until the test answers it. */
function harness(start = viewOf()) {
  const page = { view: start as PhoneView | null };
  const sent: ShownCommand[] = [];
  const answers: ((a: Answer) => void)[] = [];
  const refusals: ErrorCode[] = [];
  let paints = 0;
  let clock = 1_000;
  const remote = createRemote({
    view: () => page.view,
    post: (cmd) => {
      sent.push(cmd);
      return new Promise<Answer>((done) => answers.push(done));
    },
    adopt: (view) => {
      page.view = view;
    },
    refused: (code) => refusals.push(code),
    paint: () => {
      paints += 1;
    },
    now: () => clock,
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    page,
    sent,
    answers,
    refusals,
    remote,
    tick,
    paints: () => paints,
    setClock: (t: number) => {
      clock = t;
    },
  };
}

describe("the remote's state: a tap shows at once, and the server's shown is the truth once all are back", () => {
  it("a tap shows at once and sends an absolute command with the next seq", async () => {
    const h = harness();
    void h.remote.tap({ item: "i3" });
    expect(h.remote.at()).toEqual({ item: "i3", page: 1, present: false, play: true, sound: "on" });
    expect(h.paints()).toBe(1);
    expect(h.sent).toEqual([{ item: "i3", page: 1, present: false, play: true, sound: "on", seq: 1_000 }]);
  });

  it("quick taps build on the last tap, never the stale view, and each seq is above the last within one millisecond", async () => {
    const h = harness();
    void h.remote.tap({ item: "i3" });
    void h.remote.tap({ step: 1 });
    void h.remote.tap({ present: true });
    expect(h.sent.map((c) => c.seq)).toEqual([1_000, 1_001, 1_002]);
    expect(h.sent.at(-1)).toEqual({ item: "i3", page: 2, present: true, play: true, sound: "on", seq: 1_002 });
    expect(h.remote.at()).toEqual({ item: "i3", page: 2, present: true, play: true, sound: "on" });
  });

  it("an earlier answer arriving while a later tap is on its way never moves the mark back", async () => {
    const h = harness();
    void h.remote.tap({ item: "i3" });
    void h.remote.tap({ item: "i2" });
    h.answers[0]?.({ ok: true, value: viewOf({ shown: { item: "i3", page: 1, present: false }, v: 1 }) });
    await h.tick();
    expect(h.remote.at()).toEqual({ item: "i2", page: 1, present: false, play: true, sound: "on" });
    h.answers[1]?.({ ok: true, value: viewOf({ shown: { item: "i2", page: 1, present: false }, v: 2 }) });
    await h.tick();
    expect(h.page.view?.v).toBe(2);
    expect(h.remote.at()).toEqual({ item: "i2", page: 1, present: false });
  });

  it("PAIR-13 stale seq: the answer is the current view, adopted like any other, never an error", async () => {
    const h = harness();
    void h.remote.tap({ item: "i3" });
    // The server kept a newer command (the screen's own tap): its answer carries that shown.
    const truth: Shown = { item: "i1", page: 1, present: true };
    h.answers[0]?.({ ok: true, value: viewOf({ shown: truth, v: 1 }) });
    await h.tick();
    expect(h.refusals).toEqual([]);
    expect(h.remote.at()).toEqual(truth);
  });

  it("PAIR-13 seq: a clock behind the server's last (a reload) sends above the seq the view holds", async () => {
    // The view says the server applied 5_000 from this phone; the clock reads 1_000.
    const h = harness(viewOf({ seq: 5_000 }));
    void h.remote.tap({ item: "i3" });
    expect(h.sent).toEqual([{ item: "i3", page: 1, present: false, play: true, sound: "on", seq: 5_001 }]);
    // An answer carries the last seq again, and the next tap goes on from it.
    h.answers[0]?.({
      ok: true,
      value: viewOf({ shown: { item: "i3", page: 1, present: false }, seq: 5_001, v: 1 }),
    });
    await h.tick();
    void h.remote.tap({ step: 1 });
    expect(h.sent.at(-1)?.seq).toBe(5_002);
  });

  it("PAIR-13 seq: a view with a lower seq than a command still on its way never moves the next one back", async () => {
    const h = harness();
    void h.remote.tap({ item: "i3" });
    h.page.view = viewOf({ seq: 0, now: 150 });
    void h.remote.tap({ item: "i2" });
    expect(h.sent.map((c) => c.seq)).toEqual([1_000, 1_001]);
  });

  it("an answer older than the view a push already brought is dropped: the push is the truth", async () => {
    const h = harness();
    void h.remote.tap({ item: "i3" });
    h.page.view = viewOf({ shown: { item: "i2", page: 2, present: false }, v: 9 });
    h.answers[0]?.({ ok: true, value: viewOf({ shown: { item: "i3", page: 1, present: false }, v: 8 }) });
    await h.tick();
    expect(h.page.view.v).toBe(9);
    expect(h.remote.at()).toEqual({ item: "i2", page: 2, present: false });
  });

  it("PAIR-13 v: an answer with the same v as the push already held is the same state, so the push is kept", async () => {
    const h = harness();
    void h.remote.tap({ item: "i3" });
    // Same v, a later `now`: only a larger v is newer.
    const held = viewOf({ shown: { item: "i2", page: 2, present: false }, v: 4, now: 900 });
    h.page.view = held;
    h.answers[0]?.({ ok: true, value: viewOf({ shown: { item: "i3", page: 1, present: false }, v: 4, now: 950 }) });
    await h.tick();
    expect(h.page.view).toBe(held);
    expect(h.remote.at()).toEqual({ item: "i2", page: 2, present: false });
  });

  it("offline or rate limited: a refusal, and the mark goes back to what the screen shows", async () => {
    for (const error of ["offline", "rate_limited"] as const) {
      const h = harness(viewOf({ shown: { item: "i2", page: 1, present: false } }));
      void h.remote.tap({ item: "i3" });
      const paints = h.paints();
      h.answers[0]?.({ ok: false, error });
      await h.tick();
      expect(h.refusals).toEqual([error]);
      expect(h.paints()).toBe(paints + 1);
      expect(h.remote.at()).toEqual({ item: "i2", page: 1, present: false });
    }
  });

  it("a session that ends mid-command: the refusal is handed on (the page shows no toast for an end), and nothing stays marked", async () => {
    const h = harness();
    void h.remote.tap({ item: "i3" });
    h.page.view = viewOf({ state: "ended", now: 400 });
    h.answers[0]?.({ ok: false, error: "session_ended" });
    await h.tick();
    expect(h.refusals).toEqual(["session_ended"]);
    expect(h.remote.at()).toEqual({ item: "i1", page: 1, present: false });
  });

  it("a tap that changes nothing sends nothing", async () => {
    const h = harness(viewOf({ shown: { item: "i3", page: SLIDES.length, present: false } }));
    void h.remote.tap({ step: 1 });
    void h.remote.tap({ item: "i4" });
    expect(h.sent).toEqual([]);
    expect(h.paints()).toBe(0);
    const first = harness(viewOf({ shown: { item: "i3", page: 1, present: false } }));
    void first.remote.tap({ item: "i3" });
    expect(first.sent).toEqual([]);
  });
});
