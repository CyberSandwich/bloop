// The live match pick (core/pick.js and core/match.js, PAIR-14): one tap, one POST, and the answer picks the next state.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createPick, LEGEND, OFFLINE, SENDING, SLOW, SLOW_MS } from "../../public/js/core/pick.js";
import type { ErrorCode, MatchResponse, PhoneView } from "../../src/shared/protocol.ts";

type Answer = { ok: true; value: MatchResponse } | { ok: false; error: ErrorCode; code?: unknown };

const view = { state: "claimed", confirmed: true, match: "42", choices: null } as unknown as PhoneView;

function rig(answer: Answer | Promise<Answer>) {
  const timers: (() => void)[] = [];
  const c = { canceling: false, pid: "ref.secret" };
  const seen: { canceling: boolean }[] = [];
  const io = {
    post: vi.fn(async (_path: string, _body: unknown, _auth: string | null) => {
      seen.push({ canceling: c.canceling });
      return answer;
    }),
    paint: vi.fn(),
    toast: vi.fn(),
    buzz: vi.fn(),
    later: vi.fn((fn: () => void, _ms: number) => timers.push(fn)),
    stop: vi.fn(),
    picked: vi.fn(),
    wrong: vi.fn(),
    fail: vi.fn(),
  };
  return { c, io, seen, timers, pick: createPick(c, io) };
}

describe("PAIR-14 the match pick", () => {
  it("a tap sends the choice once, with the pid, and fills the tapped choice at once", async () => {
    const r = rig({ ok: true, value: { view, approved: false, approveError: null } });
    await r.pick("42");
    expect(r.io.post).toHaveBeenCalledWith("/api/match", { choice: "42" }, "ref.secret");
    expect(r.io.paint.mock.calls[0]).toEqual(["42", false]);
  });

  it("the right number: the tick lands on the answer, then the chooser follows with the confirmed view", async () => {
    const r = rig({ ok: true, value: { view, approved: false, approveError: null } });
    await r.pick("42");
    expect(r.io.buzz).toHaveBeenCalledTimes(1);
    expect(r.io.picked).toHaveBeenCalledWith(view);
    expect(r.io.buzz.mock.invocationCallOrder[0]).toBeLessThan(r.io.picked.mock.invocationCallOrder[0] ?? 0);
    expect(r.io.wrong).not.toHaveBeenCalled();
    expect(r.io.stop).toHaveBeenCalled();
  });

  it("the wrong number (match_wrong, 409): the dead end, no tick, and no retry", async () => {
    const r = rig({ ok: false, error: "bad_request", code: "match_wrong" });
    await r.pick("17");
    expect(r.io.wrong).toHaveBeenCalledTimes(1);
    expect(r.io.fail).not.toHaveBeenCalled();
    expect(r.io.buzz).not.toHaveBeenCalled();
  });

  it("a wrong pick's own pairing_invalid push is held back while the answer is on its way", async () => {
    const r = rig({ ok: false, error: "bad_request", code: "match_wrong" });
    await r.pick("17");
    expect(r.seen).toEqual([{ canceling: true }]);
    expect(r.c.canceling).toBe(false);
  });

  it("offline: the choices return to rest with the toast, and the same number can be tapped again", async () => {
    const r = rig({ ok: false, error: "offline" });
    await r.pick("42");
    expect(r.io.paint.mock.calls.at(-1)).toEqual([null, false]);
    expect(r.io.toast).toHaveBeenCalledWith(OFFLINE);
    expect(OFFLINE).toEqual({
      title: "You're Offline",
      body: "Check your connection, then tap the number again.",
      error: true,
    });
    await r.pick("42");
    expect(r.io.post).toHaveBeenCalledTimes(2);
  });

  it("any other refusal is the page's state for it (an expired claim reads as expired)", async () => {
    const r = rig({ ok: false, error: "pairing_invalid" });
    await r.pick("42");
    expect(r.io.fail).toHaveBeenCalledWith("pairing_invalid");
    expect(r.io.wrong).not.toHaveBeenCalled();
  });

  it("a second tap while one is on its way sends nothing", async () => {
    let settle: (a: Answer) => void = () => {};
    const r = rig(new Promise<Answer>((done) => (settle = done)));
    const first = r.pick("42");
    await r.pick("17");
    expect(r.io.post).toHaveBeenCalledTimes(1);
    settle({ ok: true, value: { view, approved: false, approveError: null } });
    await first;
    expect(r.io.picked).toHaveBeenCalledTimes(1);
  });

  it("slow (4 s): the line under the choices, the spinner stays, and no stop: the pick may have landed", async () => {
    let settle: (a: Answer) => void = () => {};
    const r = rig(new Promise<Answer>((done) => (settle = done)));
    const pending = r.pick("42");
    expect(r.io.later).toHaveBeenCalledWith(expect.any(Function), SLOW_MS);
    expect(SLOW_MS).toBe(4000);
    r.timers[0]?.();
    expect(r.io.paint.mock.calls.at(-1)).toEqual(["42", true]);
    expect(r.io.later).toHaveBeenCalledTimes(1);
    settle({ ok: true, value: { view, approved: false, approveError: null } });
    await pending;
    expect(r.io.picked).toHaveBeenCalled();
  });

  it("its words are the spec's: Title Case legend, no dashes", () => {
    expect([LEGEND, SENDING, SLOW]).toEqual([
      "Tap the Screen's Number",
      "Approving...",
      "Still approving. Keep this page open.",
    ]);
    for (const s of [LEGEND, SENDING, SLOW, OFFLINE.title, OFFLINE.body]) expect(s).not.toMatch(/[–—]/);
  });

  it("the only haptic is Android's vibrate(12); the tap is the pointerup; a key's click (detail 0) picks too", () => {
    const src = readFileSync(new URL("../../public/js/core/match.js", import.meta.url), "utf8");
    expect(src.match(/vibrate/g)).toHaveLength(1);
    expect(src).toContain("navigator.vibrate?.(12)");
    expect(src).toContain('addEventListener("pointerup"');
    expect(src).toContain("e.detail === 0");
  });
});

describe("PAIR-14 the pick's markup holds its boxes before the module lands", () => {
  const html = readFileSync(new URL("../../public/a.html", import.meta.url), "utf8");
  it("a.html has the fieldset, its visible legend and three skeleton pills, hidden until a claim needs it", () => {
    const pick = html.match(/<fieldset class="pick" id="pick" hidden>([\s\S]*?)<\/fieldset>/)?.[1] ?? "";
    expect(pick).toContain("<legend>Tap the Screen's Number</legend>");
    expect(pick.match(/<span class="choice skel"><\/span>/g)).toHaveLength(3);
  });
  it("the pills' size is first-load CSS (app.css), not the lazy sheet's", () => {
    const app = readFileSync(new URL("../../public/css/app.css", import.meta.url), "utf8");
    const lazy = readFileSync(new URL("../../public/css/match.css", import.meta.url), "utf8");
    // After `.actions .btn` (52), which shares its specificity: the order is what makes the choices 64.
    expect(app).toMatch(/\.pick \.choice \{\n {2}min-height: 64px;/);
    expect(app.indexOf(".pick .choice {")).toBeGreaterThan(app.indexOf(".actions .btn {"));
    expect(lazy).not.toMatch(/height|grid-template|margin/);
  });
});
