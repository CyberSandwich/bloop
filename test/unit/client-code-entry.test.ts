// The code step (public/js/auth/code-entry.js) and the row and slow rule before it (auth/row.js), on DOM fakes and a
// hand-driven clock.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCodeEntry,
  deadlineOf,
  digitsOf,
  grouped,
  land,
  MAX_TRIES,
  RESEND_MS,
  refusal,
} from "../../public/js/auth/code-entry.js";
import { AUTH } from "../../public/js/auth/copy.js";
import {
  CLOCK,
  type Clock,
  createRow,
  NEXT_PATHS,
  nextFrom,
  quietSkip,
  SLOW_MS,
  STOP_MS,
  showFailure,
  watch,
} from "../../public/js/auth/row.js";
import { SIGNIN_NEXT } from "../../src/worker/page-registry.ts";

type Listener = (e: FakeEvent) => void;
interface FakeEvent {
  clipboardData?: { getData: (type: string) => string };
  prevented: boolean;
  preventDefault: () => void;
}
const event = (text?: string): FakeEvent => {
  const e: FakeEvent = {
    prevented: false,
    preventDefault: () => {
      e.prevented = true;
    },
  };
  if (text !== undefined) e.clipboardData = { getData: () => text };
  return e;
};

class FakeEl {
  value = "";
  textContent = "";
  hidden = false;
  disabled = false;
  focused = 0;
  selected = 0;
  attrs: Record<string, string> = {};
  classes = new Set<string>();
  listeners: Record<string, Listener[]> = {};
  classList = {
    toggle: (c: string, on: boolean) => (on ? this.classes.add(c) : this.classes.delete(c)),
  };
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  removeAttribute(k: string) {
    delete this.attrs[k];
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners[type] = [...(this.listeners[type] ?? []), fn];
  }
  fire(type: string, e: FakeEvent = event()) {
    for (const fn of this.listeners[type] ?? []) fn(e);
    return e;
  }
  focus() {
    this.focused++;
  }
  select() {
    this.selected++;
  }
}

/** A clock the test moves by hand; timers fire in order of their due time. */
function fakeClock(start = 1_000_000): Clock & { advance: (ms: number) => void; pending: () => number } {
  let t = start;
  let id = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    later: (fn, ms) => {
      queue.set(++id, { at: t + ms, fn });
      return id;
    },
    cancel: (timer) => {
      queue.delete(timer as number);
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...queue.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        queue.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
    pending: () => queue.size,
  };
}

const flush = () => new Promise((done) => setImmediate(done));
type Reply = { ok: true; value: unknown } | { ok: false; error: string; retryAfter?: number };

function setup(
  options: {
    verify?: (code: string) => Promise<Reply>;
    resend?: (hold?: { pause?: () => void }) => Promise<Reply>;
    done?: () => Promise<boolean>;
  } = {},
) {
  const clock = fakeClock();
  const input = new FakeEl();
  const resend = new FakeEl();
  const doc = Object.assign(new FakeEl(), { hidden: false });
  const parts = { hint: new FakeEl(), hintText: new FakeEl(), error: new FakeEl(), errorText: new FakeEl() };
  const row = createRow(parts as never);
  const verify = vi.fn(options.verify ?? (async (): Promise<Reply> => ({ ok: false, error: "code_invalid" })));
  const resendHook = vi.fn(
    options.resend ?? (async (): Promise<Reply> => ({ ok: true, value: { expiresIn: 600_000 } })),
  );
  const done = vi.fn(options.done ?? (async () => true));
  const refused = vi.fn((reply: { error: string }) => reply.error === "invite_dead");
  const entry = createCodeEntry(
    { input: input as never, row, resend: resend as never, doc: doc as never },
    { verify, resend: resendHook, done, refused },
    clock,
  );
  /** What the row shows: the alert when one is on, else the status line. */
  const line = () => (parts.error.classes.has("is-on") ? parts.errorText.textContent : parts.hintText.textContent);
  const type = async (text: string) => {
    for (const ch of text) {
      input.value += ch;
      input.fire("input");
    }
    await flush();
  };
  return { clock, input, resend, doc, parts, row, verify, resendHook, done, refused, entry, line, type };
}

describe("code digits", () => {
  it("keeps every digit and nothing else, and shows six 3 and 3", () => {
    expect(digitsOf("4a8-1 2\t0 7")).toBe("481207");
    expect(digitsOf("4a8-1 2\t0 7 9")).toBe("4812079");
    expect(digitsOf("")).toBe("");
    expect(grouped("481207")).toBe("481 207");
    expect(grouped("4812")).toBe("481 2");
    expect(grouped("481")).toBe("481");
  });

  it("a code that starts with zeros keeps them", () => {
    expect(digitsOf("007 001")).toBe("007001");
  });
});

describe("the code field", () => {
  it("typed one digit at a time, it groups as it goes and sends on the 6th digit, once", async () => {
    const s = setup();
    s.entry.start({ expiresIn: 600_000 });
    await s.type("4812");
    expect(s.input.value).toBe("481 2");
    expect(s.verify).not.toHaveBeenCalled();
    await s.type("07");
    expect(s.verify.mock.calls).toEqual([["481207"]]);
  });

  it("a pasted '481 207' or '481-207' sends the whole code; a partial paste is left to the browser", async () => {
    for (const text of ["481 207", "481-207", " 481207 "]) {
      const s = setup();
      s.entry.start(null);
      expect(s.input.fire("paste", event(text)).prevented).toBe(true);
      await flush();
      expect(s.verify.mock.calls, text).toEqual([["481207"]]);
      expect(s.input.value).toBe("481 207");
    }
    const s = setup();
    s.entry.start(null);
    expect(s.input.fire("paste", event("48")).prevented).toBe(false);
    expect(s.verify).not.toHaveBeenCalled();
  });

  it("more than 6 digits, pasted or filled in, is not a code: the field clears and nothing is sent", async () => {
    const s = setup();
    s.entry.start(null);
    s.input.value = "48";
    expect(s.input.fire("paste", event("4812079")).prevented).toBe(true);
    s.input.value = "481 2079";
    s.input.fire("input");
    await flush();
    expect(s.verify).not.toHaveBeenCalled();
    expect([s.input.value, s.line()]).toEqual(["", AUTH.code.hint]);
  });

  it("while verifying, the field is disabled and the row reads Checking... with the spinner", async () => {
    let answer: (r: Reply) => void = () => {};
    const s = setup({ verify: () => new Promise((done) => (answer = done)) });
    s.entry.start(null);
    await s.type("481207");
    expect(s.input.disabled).toBe(true);
    expect(s.line()).toBe(AUTH.code.checking);
    expect(s.parts.hint.classes.has("is-busy")).toBe(true);
    answer({ ok: true, value: { next: "/library" } });
    await flush();
    expect(s.done).toHaveBeenCalledWith({ next: "/library" });
  });

  it("a wrong code says didn't match, keeps the digits selected, and re-enables the field", async () => {
    const s = setup();
    s.entry.start({ expiresIn: 600_000 });
    await s.type("111111");
    expect(s.line()).toBe(AUTH.code.wrong);
    expect(s.input.disabled).toBe(false);
    expect(s.input.selected).toBe(1);
    expect(s.input.attrs["aria-invalid"]).toBe("true");
  });

  it(`after ${MAX_TRIES} wrong codes it says Too many tries, and a 6th code sends nothing`, async () => {
    const s = setup();
    s.entry.start({ expiresIn: 600_000 });
    const lines: string[] = [];
    for (let i = 0; i < MAX_TRIES; i++) {
      s.input.value = "";
      await s.type("111111");
      lines.push(s.line());
    }
    expect(lines).toEqual([...Array(MAX_TRIES - 1).fill(AUTH.code.wrong), AUTH.code.tooMany]);
    s.input.value = "";
    await s.type("222222");
    expect(s.verify).toHaveBeenCalledTimes(MAX_TRIES);
    expect(s.line()).toBe(AUTH.code.tooMany);
  });

  it("the deadline (expiresIn after the answer) says expired; a code typed after it is still sent, and its refusal reads expired", async () => {
    const s = setup();
    s.entry.start({ expiresIn: 600_000 });
    s.clock.advance(599_999);
    expect(s.line()).toBe(AUTH.code.hint);
    s.clock.advance(1);
    expect(s.line()).toBe(AUTH.code.expired);
    s.input.value = "";
    await s.type("481207");
    expect(s.verify.mock.calls).toEqual([["481207"]]);
    expect(s.line()).toBe(AUTH.code.expired);
  });

  it("a code refused after the deadline reads expired, not didn't match", () => {
    expect(refusal(1, 1000, 999)).toBe(AUTH.code.wrong);
    expect(refusal(1, 1000, 1000)).toBe(AUTH.code.expired);
    expect(refusal(MAX_TRIES, 1000, 1000)).toBe(AUTH.code.expired);
    expect(refusal(MAX_TRIES, null, 10 ** 15)).toBe(AUTH.code.tooMany);
  });

  it("with no expiresIn (an answer without one) there is no deadline: only the count", async () => {
    const s = setup();
    s.entry.start(null);
    s.clock.advance(24 * 3600_000);
    expect(s.line()).toBe(AUTH.code.hint);
  });

  it("the resend countdown reads 0:30, then 0:24 six seconds later, then Send a New Code, enabled", () => {
    const s = setup();
    s.entry.start(null);
    expect([s.resend.textContent, s.resend.disabled]).toEqual(["Send a New Code in 0:30", true]);
    s.clock.advance(6000);
    expect(s.resend.textContent).toBe("Send a New Code in 0:24");
    s.clock.advance(RESEND_MS - 6000 - 1);
    expect(s.resend.textContent).toBe("Send a New Code in 0:01");
    s.clock.advance(1);
    expect([s.resend.textContent, s.resend.disabled]).toEqual([AUTH.code.resend, false]);
  });

  it("Send a New Code sends one, resets the count and the clock, and focuses the field", async () => {
    const s = setup();
    s.entry.start({ expiresIn: 600_000 });
    for (let i = 0; i < MAX_TRIES; i++) {
      s.input.value = "";
      await s.type("111111");
    }
    s.clock.advance(RESEND_MS);
    const focused = s.input.focused;
    s.resend.fire("click");
    await flush();
    expect(s.resendHook).toHaveBeenCalledTimes(1);
    expect(s.input.focused).toBe(focused + 1);
    expect([s.input.value, s.line()]).toEqual(["", AUTH.code.hint]);
    expect(s.resend.textContent).toBe("Send a New Code in 0:30");
    await s.type("111111");
    expect(s.verify).toHaveBeenCalledTimes(MAX_TRIES + 1);
    expect(s.line()).toBe(AUTH.code.wrong);
  });

  it("over the bucket, the wait comes from Retry-After and the button waits it out", async () => {
    const s = setup({ resend: async () => ({ ok: false, error: "rate_limited", retryAfter: 900 }) });
    s.entry.start(null);
    s.clock.advance(RESEND_MS);
    s.resend.fire("click");
    await flush();
    expect(s.line()).toBe("Too many codes for now. Try again in 15 minutes.");
    expect([s.resend.textContent, s.resend.disabled]).toEqual(["Send a New Code in 15:00", true]);
    s.clock.advance(900_000);
    expect(s.resend.disabled).toBe(false);
  });

  it("slow: Still working at 4 s; at 15 s it stops with Try again and frees the field; a late success still lands", async () => {
    let answer: (r: Reply) => void = () => {};
    const s = setup({ verify: () => new Promise((done) => (answer = done)) });
    s.entry.start(null);
    await s.type("481207");
    s.clock.advance(SLOW_MS);
    expect(s.line()).toBe(AUTH.slow.still);
    s.clock.advance(STOP_MS - SLOW_MS);
    expect(s.line()).toBe(AUTH.slow.tooLong);
    expect(s.input.disabled).toBe(false);
    answer({ ok: true, value: {} });
    await flush();
    expect(s.done).toHaveBeenCalledTimes(1);
  });

  it("a late failure after the stop changes nothing", async () => {
    let answer: (r: Reply) => void = () => {};
    const s = setup({ verify: () => new Promise((done) => (answer = done)) });
    s.entry.start(null);
    await s.type("481207");
    s.clock.advance(STOP_MS);
    answer({ ok: false, error: "code_invalid" });
    await flush();
    expect(s.line()).toBe(AUTH.slow.tooLong);
  });

  it("offline and a page refusal: the offline line, or the page's own handler", async () => {
    const offline = setup({ verify: async () => ({ ok: false, error: "offline" }) });
    offline.entry.start(null);
    await offline.type("481207");
    expect(offline.line()).toBe(AUTH.offline);
    const dead = setup({ verify: async () => ({ ok: false, error: "invite_dead" }) });
    dead.entry.start(null);
    await dead.type("481207");
    expect(dead.refused).toHaveBeenCalledWith({ ok: false, error: "invite_dead" });
  });

  it("back from the Mail app, an empty field is focused; a filled one, a hidden tab or a stopped step is left", () => {
    const s = setup();
    s.entry.start(null);
    const before = s.input.focused;
    s.doc.hidden = false;
    s.doc.fire("visibilitychange");
    expect(s.input.focused).toBe(before + 1);
    s.doc.hidden = true;
    s.doc.fire("visibilitychange");
    s.doc.hidden = false;
    s.input.value = "4";
    s.doc.fire("visibilitychange");
    s.input.value = "";
    s.entry.stop();
    s.doc.fire("visibilitychange");
    expect(s.input.focused).toBe(before + 1);
  });

  it("a session cookie that did not stick gives the field back, so a new code can be typed", async () => {
    const s = setup({ verify: async () => ({ ok: true, value: {} }), done: async () => false });
    s.entry.start(null);
    await s.type("481207");
    expect(s.done).toHaveBeenCalledTimes(1);
    expect(s.input.disabled).toBe(false);
    s.input.value = "";
    await s.type("222222");
    expect(s.verify).toHaveBeenCalledTimes(2);
  });

  it("Send a New Code runs under the slow rule: Still working, then Try again with the button back", async () => {
    const s = setup({ resend: () => new Promise(() => {}) });
    s.entry.start(null);
    s.clock.advance(RESEND_MS);
    s.resend.fire("click");
    s.clock.advance(SLOW_MS);
    expect(s.line()).toBe(AUTH.slow.still);
    s.clock.advance(STOP_MS - SLOW_MS);
    expect(s.line()).toBe(AUTH.slow.tooLong);
    expect([s.resend.textContent, s.resend.disabled]).toEqual([AUTH.code.resend, false]);
  });

  it("Send a New Code hands the page its hold: a challenge shown to a person pauses the slow rule", async () => {
    let held: { pause?: () => void } = {};
    const s = setup({
      resend: (hold?: { pause?: () => void }) => {
        held = hold ?? {};
        return new Promise(() => {});
      },
    });
    s.entry.start(null);
    s.clock.advance(RESEND_MS);
    s.resend.fire("click");
    s.clock.advance(SLOW_MS - 1);
    held.pause?.();
    s.clock.advance(STOP_MS);
    expect(s.line()).toBe(AUTH.code.hint);
  });

  it("stop() leaves no timer behind", () => {
    const s = setup();
    s.entry.start({ expiresIn: 600_000 });
    expect(s.clock.pending()).toBeGreaterThan(0);
    s.entry.stop();
    expect(s.clock.pending()).toBe(0);
  });
});

describe("the deadline reads no device clock (H2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("H2: a device clock 10 minutes fast neither expires a fresh code nor blocks its verify", async () => {
    const serverNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(serverNow + 600_000);
    const answer = { challengeId: "c", expiresAt: serverNow + 600_000, expiresIn: 600_000 };
    const left = (deadlineOf(answer) as number) - performance.now();
    expect(left).toBeGreaterThan(599_000);
    expect(left).toBeLessThanOrEqual(600_000);
    const input = new FakeEl();
    const parts = { hint: new FakeEl(), hintText: new FakeEl(), error: new FakeEl(), errorText: new FakeEl() };
    const verify = vi.fn(async (): Promise<Reply> => ({ ok: false, error: "code_invalid" }));
    const entry = createCodeEntry(
      {
        input: input as never,
        row: createRow(parts as never),
        resend: new FakeEl() as never,
        doc: Object.assign(new FakeEl(), { hidden: false }) as never,
      },
      { verify, resend: async () => ({ ok: true, value: {} }), done: async () => true },
    );
    entry.start(answer);
    for (const ch of "481207") {
      input.value += ch;
      input.fire("input");
    }
    await flush();
    entry.stop();
    expect(verify.mock.calls).toEqual([["481207"]]);
    expect(parts.errorText.textContent).toBe(AUTH.code.wrong);
  });

  it("the page's clock is monotonic, and an answer without expiresIn has no deadline", () => {
    expect(CLOCK.now).not.toBe(Date.now);
    expect(deadlineOf({ expiresAt: 10 ** 13 })).toBeNull();
    expect(deadlineOf(null)).toBeNull();
    expect(deadlineOf({ expiresIn: "600000" })).toBeNull();
  });
});

describe("after the code", () => {
  it("the page's next list is the Worker's (page-registry.ts SIGNIN_NEXT)", () => {
    expect(NEXT_PATHS).toEqual([...SIGNIN_NEXT]);
  });

  it("next is one of the exact paths, else the library", () => {
    for (const path of NEXT_PATHS) expect(nextFrom(`?next=${encodeURIComponent(path)}`)).toBe(path);
    for (const bad of ["//evil.example", "https://evil.example/library", "/library?x=1", "/Library", "/admin/", ""])
      expect(nextFrom(`?next=${encodeURIComponent(bad)}`), bad).toBe("/library");
    expect(nextFrom("")).toBe("/library");
  });

  it("a session that did not stick shows the cookies line and stays; a signed-in one goes to next", async () => {
    const row = { alert: vi.fn(), status: vi.fn(), clear: vi.fn() };
    const go = vi.fn();
    expect(await land(async () => ({ ok: true, value: { signedIn: false } }), "/account", row, go)).toBe(false);
    expect(row.alert).toHaveBeenCalledWith(AUTH.code.cookies);
    expect(go).not.toHaveBeenCalled();
    await land(async () => ({ ok: true, value: { signedIn: true, admin: false } }), "/account", row, go);
    expect(go).toHaveBeenLastCalledWith("/account");
  });

  it("a non-admin asking for /admin lands on the library; an admin gets /admin", async () => {
    const row = { alert: vi.fn(), status: vi.fn(), clear: vi.fn() };
    const go = vi.fn();
    await land(async () => ({ ok: true, value: { signedIn: true, admin: false } }), "/admin", row, go);
    await land(async () => ({ ok: true, value: { signedIn: true, admin: true } }), "/admin", row, go);
    expect(go.mock.calls).toEqual([["/library"], ["/admin"]]);
  });

  it("a failed /api/me read goes on: the next page shows its own state", async () => {
    const row = { alert: vi.fn(), status: vi.fn(), clear: vi.fn() };
    const go = vi.fn();
    await land(async () => ({ ok: false, error: "offline" }), "/library", row, go);
    expect(go).toHaveBeenCalledWith("/library");
  });
});

describe("failures and the slow rule", () => {
  it("offline and a block page read offline; a full bucket names its wait; anything else is bloop not responding", () => {
    const parts = { hint: new FakeEl(), hintText: new FakeEl(), error: new FakeEl(), errorText: new FakeEl() };
    const row = createRow(parts as never);
    const shown = (reply: { error: string; retryAfter?: number }) => {
      showFailure(reply, row);
      return parts.errorText.textContent;
    };
    expect(shown({ error: "offline" })).toBe(AUTH.offline);
    expect(shown({ error: "network_blocked" })).toBe(AUTH.offline);
    expect(shown({ error: "rate_limited", retryAfter: 60 })).toBe("Too many codes for now. Try again in 1 minute.");
    for (const error of ["service_down", "internal", "service_busy", "bad_request"])
      expect(shown({ error }), error).toBe(AUTH.down);
  });

  it("the row shows one line at a time in its one place", () => {
    const parts = { hint: new FakeEl(), hintText: new FakeEl(), error: new FakeEl(), errorText: new FakeEl() };
    const row = createRow(parts as never);
    row.alert("A");
    expect([parts.hint.hidden, parts.error.classes.has("is-on")]).toEqual([true, true]);
    row.status("B", true);
    expect([parts.hint.hidden, parts.error.classes.has("is-on"), parts.hintText.textContent]).toEqual([
      false,
      false,
      "B",
    ]);
    row.clear();
    expect([parts.hintText.textContent, parts.errorText.textContent]).toEqual(["", ""]);
  });

  it("a held watch keeps its clock still while a person solves a challenge, then runs the rule again", async () => {
    const clock = fakeClock();
    const on = { slow: vi.fn(), stop: vi.fn() };
    const hold: { pause?: () => void; resume?: () => void } = {};
    let answer: (v: number) => void = () => {};
    const request = watch(new Promise<number>((done) => (answer = done)), on, clock, hold);
    clock.advance(SLOW_MS - 1);
    hold.pause?.();
    clock.advance(60_000);
    expect([on.slow.mock.calls.length, on.stop.mock.calls.length]).toEqual([0, 0]);
    hold.resume?.();
    clock.advance(SLOW_MS);
    expect(on.slow).toHaveBeenCalledTimes(1);
    answer(1);
    await request;
    hold.resume?.();
    expect(clock.pending()).toBe(0);
  });

  it("the skip link focuses the title and writes no #title into the address", () => {
    const link = new FakeEl();
    const focus = vi.fn();
    quietSkip({ querySelector: (selector: string) => (selector === ".skip" ? link : null) } as never, focus);
    expect(link.fire("click").prevented).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("watch cancels both timers when the request settles", async () => {
    const clock = fakeClock();
    const on = { slow: vi.fn(), stop: vi.fn() };
    await watch(Promise.resolve(1), on, clock);
    expect(clock.pending()).toBe(0);
    clock.advance(STOP_MS);
    expect(on.slow).not.toHaveBeenCalled();
  });
});
