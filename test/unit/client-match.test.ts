// The live match pick (core/pick.js and core/match.js, PAIR-14): one tap, one POST, and the answer picks the next state.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createPick, LEGEND, OFFLINE, SENDING, SLOW, SLOW_MS } from "../../public/js/core/pick.js";
import type { ErrorCode, MatchResponse, PhoneView } from "../../src/shared/protocol.ts";

type Answer = { ok: true; value: MatchResponse } | { ok: false; error: ErrorCode; code?: unknown };

const view = { state: "claimed", confirmed: true, match: "42", choices: null } as unknown as PhoneView;
/** The answer's view is all the page reads. */
const right: Answer = { ok: true, value: { view } as MatchResponse };

function rig(answer: Answer | Promise<Answer>) {
  const timers: (() => void)[] = [];
  const c = { canceling: false, pid: "ref.secret" };
  const seen: { canceling: boolean }[] = [];
  const io = {
    post: vi.fn(async (_path: string, _body: unknown, _auth: string | null, _key: string) => {
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
    const r = rig(right);
    await r.pick("42");
    expect(r.io.post).toHaveBeenCalledWith("/api/match", { choice: "42" }, "ref.secret", expect.any(String));
    expect(r.io.paint.mock.calls[0]).toEqual(["42", false]);
  });

  it("the right number: the tick lands on the answer, then the chooser follows with the confirmed view", async () => {
    const r = rig(right);
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

  it("a number tapped is one intent: its Idempotency-Key goes again on the retap, another number gets its own", async () => {
    const r = rig({ ok: false, error: "offline" });
    await r.pick("42");
    await r.pick("42");
    await r.pick("17");
    const keys = r.io.post.mock.calls.map((call) => call[3]);
    expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
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
    settle(right);
    await first;
    expect(r.io.picked).toHaveBeenCalledTimes(1);
  });

  it("slow (4 s): the line over the choices, the spinner stays, and no stop: the pick may have landed", async () => {
    let settle: (a: Answer) => void = () => {};
    const r = rig(new Promise<Answer>((done) => (settle = done)));
    const pending = r.pick("42");
    expect(r.io.later).toHaveBeenCalledWith(expect.any(Function), SLOW_MS);
    expect(SLOW_MS).toBe(4000);
    r.timers[0]?.();
    expect(r.io.paint.mock.calls.at(-1)).toEqual(["42", true]);
    expect(r.io.later).toHaveBeenCalledTimes(1);
    settle(right);
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

  it("the only haptic is Android's vibrate(12); the tap is the click alone, never a pointer event", () => {
    const src = readFileSync(new URL("../../public/js/core/match.js", import.meta.url), "utf8");
    expect(src.match(/vibrate/g)).toHaveLength(1);
    expect(src).toContain("navigator.vibrate?.(12)");
    expect(src.match(/addEventListener\("(\w+)"/g)).toEqual(['addEventListener("click"']);
    expect(src).not.toMatch(/pointer(up|down)/);
    // The tap delay is gone without listening for the pointer.
    const lazy = readFileSync(new URL("../../public/css/match.css", import.meta.url), "utf8");
    expect(lazy).toMatch(/\.pick \.choice \{[^}]*touch-action: manipulation;/);
  });

  it("OFFLINE is its own toast, not lazy.js's refused(): the retry it names is a tap on the number", async () => {
    vi.resetModules();
    const shown = vi.fn();
    vi.doMock("../../public/js/core/toast.js", () => ({ toast: shown }));
    const LAZY = "../../public/js/core/lazy.js";
    const { refused }: { refused: (t: string) => (code: string) => void } = await import(LAZY);
    refused("You're Offline")("offline");
    const general = shown.mock.calls[0]?.[0];
    expect(general.body).toBe("Check the connection, then try again.");
    expect(OFFLINE.body).not.toBe(general.body);
    expect(OFFLINE.body).toContain("tap the number again");
    vi.doUnmock("../../public/js/core/toast.js");
  });
});

describe("PAIR-14 the pick's markup holds its boxes before the module lands", () => {
  const html = readFileSync(new URL("../../public/a.html", import.meta.url), "utf8");
  const pick = html.match(/<fieldset class="pick" id="pick" hidden>([\s\S]*?)<\/fieldset>/)?.[1] ?? "";
  it("a.html has the fieldset, its visible legend and three skeleton pills, hidden until a claim needs it", () => {
    expect(pick.match(/<span class="choice skel"><\/span>/g)).toHaveLength(3);
  });
  it("the legend's words are written twice, in a.html for the first paint and in pick.js for the module: the same", () => {
    expect(pick).toContain(`<legend>${LEGEND}</legend>`);
  });
  it("the live regions the pick speaks through are in the page and empty before their words (#polite, .pick-slow)", () => {
    expect(html).toMatch(/<p class="sr" id="polite" role="status"><\/p>/);
    expect(pick).toMatch(/<p class="pick-slow small" role="status" hidden><\/p>/);
    // The module shows the line once, empty, at its mount, and from then on sets only its words.
    const src = readFileSync(new URL("../../public/js/core/match.js", import.meta.url), "utf8");
    expect(src.match(/line\.hidden/g)).toEqual(["line.hidden"]);
    expect(src).toContain("line.hidden = false;");
    expect(src.indexOf("line.hidden = false;")).toBeLessThan(src.indexOf("line.textContent"));
    expect(src).toContain("polite.textContent = tapped && SENDING;");
  });
  it("the pills' size is first-load CSS (app.css), not the lazy sheet's", () => {
    const app = readFileSync(new URL("../../public/css/app.css", import.meta.url), "utf8");
    const lazy = readFileSync(new URL("../../public/css/match.css", import.meta.url), "utf8");
    expect(app).toMatch(/\n\.choice \{\n {2}min-height: var\(--choice-h\);/);
    // `.actions .btn` outranks `.choice`: a height there would shrink the choices to it.
    expect(app.match(/\n\.actions \.btn \{[^}]*\}/)?.[0]).not.toContain("height");
    expect(lazy).not.toMatch(/height|grid-template|margin/);
  });
});

describe("the spinner, in a busy button or the pick's legend", () => {
  const app = readFileSync(new URL("../../public/css/app.css", import.meta.url), "utf8");
  const base = readFileSync(new URL("../../public/css/base.css", import.meta.url), "utf8");
  it("is scoped to where it is drawn", () => {
    expect(app).toMatch(/\n:is\(\.btn, \.pick\) \.spinner \{/);
    expect(app).not.toMatch(/\n\.spinner \{/);
  });
  it("stops under reduced motion: base.css's net cuts every animation, and the spinner's is not !important", () => {
    const net =
      base.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{([^}]*)\}/)?.[1] ?? "";
    expect(net).toContain("animation-duration: 0.01ms !important;");
    expect(net).toContain("animation-iteration-count: 1 !important;");
    const spinner = app.match(/\n:is\(\.btn, \.pick\) \.spinner \{([^}]*)\}/)?.[1] ?? "";
    expect(spinner).toContain("animation: spin");
    expect(spinner).not.toContain("!important");
  });
});
