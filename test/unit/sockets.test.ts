import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MISSED_PINGS, PING_MS } from "../../public/js/core/health.js";
import { SILENCE_MS } from "../../public/js/core/timing.js";
import {
  admit,
  bindingIp,
  COALESCE_MS,
  closeLateHellos,
  countAuthed,
  helloBinding,
  holdBinding,
  isLive,
  MAX_PENDING_PER_NET,
  MAX_PENDING_SOCKETS,
  OPEN,
  StateCoalescer,
  screensOf,
} from "../../src/worker/do/sockets.ts";
import { must, sec, T0, waiting } from "./machine-helpers.ts";

describe("PAIR-10 socket count", () => {
  it("PAIR-10 unauthed socket holds no closeAt: only authenticated sockets are counted", () => {
    expect(countAuthed([{ authed: false }, null, { authed: false }])).toBe(0);
    expect(countAuthed([{ authed: false }, { authed: true }])).toBe(1);
    // A waiting screen with only bare upgrades keeps the close deadline it had; an authed socket clears it.
    const m = waiting();
    const bare = must(m, { e: "socket", now: T0 + sec(5), open: countAuthed([{ authed: false }]) }).next;
    expect(bare.closeAt).toBe(m.closeAt);
    expect(m.closeAt).toBe(T0 + sec(600));
    expect(must(m, { e: "socket", now: T0 + sec(5), open: countAuthed([{ authed: true }]) }).next.closeAt).toBeNull();
  });

  const NOW = 1_000_000;
  /** A socket waiting for its hello, opened at `opened` (its helloBy is five seconds on). */
  const held = (role: string, net: string, opened = NOW, authed = false) => ({
    id: `${role}-${net}-${opened}`,
    att: { role, net, authed, helloBy: opened + 5000 },
  });

  it("PAIR-10 pending cap: per role and per network, authed and expired sockets never count", () => {
    expect(MAX_PENDING_SOCKETS).toBe(4);
    expect(MAX_PENDING_PER_NET).toBe(2);
    // One network holding its two does not touch another network, or the other role.
    const one = [held("screen", "a", NOW - 2), held("screen", "a", NOW - 1)];
    expect(admit(one, "screen", "b", NOW)).toBeNull();
    expect(admit(one, "phone", "a", NOW)).toBeNull();
    const expired = [held("screen", "a", NOW - 9000), held("screen", "a", NOW - 9000)];
    expect(admit(expired, "screen", "a", NOW)).toBeNull();
    const authed = [held("screen", "a", NOW, true), held("screen", "a", NOW, true), { att: null }];
    expect(admit(authed, "screen", "a", NOW)).toBeNull();
  });

  it("PAIR-10 pending cap: two idle sockets behind one address cannot keep the real screen out", () => {
    // An attacker behind the venue NAT holds two upgrades that never say hello; the screen's own upgrade, from the
    // same address, still gets in, at the cost of the network's oldest waiting socket.
    const attacker = [held("screen", "nat", NOW - 2), held("screen", "nat", NOW - 1)];
    expect(admit(attacker, "screen", "nat", NOW)?.id).toBe(`screen-nat-${NOW - 2}`);
  });

  it("PAIR-10 pending cap: a full role evicts its oldest waiting socket, so held slots cannot keep a real screen out", () => {
    const full = [
      held("screen", "a", NOW - 40),
      held("screen", "a", NOW - 30),
      held("screen", "b", NOW - 20),
      held("screen", "b", NOW - 10),
    ];
    expect(admit(full, "screen", "c", NOW)?.id).toBe(`screen-a-${NOW - 40}`);
    expect(admit(full, "phone", "c", NOW)).toBeNull();
    // A network at its own cap gives up its own oldest, never another network's.
    expect(admit(full, "screen", "b", NOW)?.id).toBe(`screen-b-${NOW - 20}`);
  });

  it("PAIR-10 pending cap: a full role evicts from the network holding the most, so a lone real screen stays", () => {
    // R waits alone and oldest; Y holds two; Z one. The next upgrade (W) costs Y its oldest, never R.
    const full = [
      held("screen", "r", NOW - 40),
      held("screen", "y", NOW - 30),
      held("screen", "y", NOW - 20),
      held("screen", "z", NOW - 10),
    ];
    expect(admit(full, "screen", "w", NOW)?.id).toBe(`screen-y-${NOW - 30}`);
  });

  it("PAIR-10 liveness: a socket is live until it has been quiet for SILENCE_MS", () => {
    expect(isLive(NOW, NOW + SILENCE_MS - 1)).toBe(true);
    expect(isLive(NOW, NOW + SILENCE_MS)).toBe(false);
  });
});

describe("OPEN-02 link binding", () => {
  const T = 5_000_000;
  it("OPEN-02 binding after a network change: the old socket going quiet hands the binding to the new one", () => {
    // The screen moved networks: its old socket (address A) lingers unanswered, the new one (B) said hello later.
    const screens = (now: number) => [
      { ip: "A", helloAt: T, heardAt: T },
      { ip: "B", helloAt: T + 1000, heardAt: now },
    ];
    expect(bindingIp(screens(T + 2000), T + 2000, "A")).toBe("A");
    const later = T + SILENCE_MS + 1;
    expect(bindingIp(screens(later), later, "A")).toBe("B");
  });

  it("OPEN-02 binding: a later socket with a leaked sid cannot take it from a screen that is still talking", () => {
    const now = T + 60_000;
    const screens = [
      { ip: "lectern", helloAt: T, heardAt: now - 1000 },
      { ip: "leak", helloAt: T + 50_000, heardAt: now },
    ];
    expect(bindingIp(screens, now, "lectern")).toBe("lectern");
    // Stored from neither (an old poll): the socket that verified first.
    expect(bindingIp(screens, now, "old-poll")).toBe("lectern");
  });

  it("OPEN-02 reconnect: a lectern back from the bound address keeps it against an older live socket elsewhere", () => {
    // B (a leaked sid, pinging) verified before the lectern's reconnect C; C comes from the bound address.
    const now = T + 60_000;
    const b = { ip: "attacker", helloAt: T, heardAt: now - 1000 };
    const c = { ip: "lectern", helloAt: T + 30_000, heardAt: now };
    expect(helloBinding("lectern", [b], T + 30_000)).toBeNull();
    expect(bindingIp([b, c], now, "lectern")).toBe("lectern");
    let stored: string | undefined = "lectern";
    const store = {
      get: () => stored,
      set: (ip: string) => {
        stored = ip;
      },
    };
    expect(holdBinding([b, c], now, store)).toBe("lectern");
    expect(stored).toBe("lectern");
    // The lectern closed and came back from a new address with nobody else live: it roams there.
    expect(helloBinding("new-net", [], now)).toBe("new-net");
    expect(bindingIp([{ ip: "new-net", helloAt: now, heardAt: now }], now, "new-net")).toBe("new-net");
  });

  it("OPEN-02 binding: a holder that took over is written through, so when it closes it stays the fallback", () => {
    let stored: string | undefined = "A";
    const store = {
      get: () => stored,
      set: (ip: string) => {
        stored = ip;
      },
    };
    const later = T + SILENCE_MS + 1;
    const both = [
      { ip: "A", helloAt: T, heardAt: T },
      { ip: "B", helloAt: T + 1000, heardAt: later },
    ];
    expect(holdBinding(both, later, store)).toBe("B");
    expect(stored).toBe("B");
    // B closes after taking over: no live socket, and the fallback is B, not the address it replaced.
    expect(holdBinding([{ ip: "A", helloAt: T, heardAt: T }], later + 1, store)).toBe("B");
    expect(holdBinding([], later + 1, store)).toBe("B");
  });

  it("OPEN-02 binding fails closed: an authed socket with no address never clears the binding", () => {
    // Hibernated from before addresses were kept: authed, live, no ip. The stored "lectern" holds, so under enforce
    // a fetch from "other" mismatches and is refused (403 link_binding_failed), never let through as unbound.
    const now = T + 10_000;
    const entries = [{ att: { authed: true, role: "screen" }, pong: now }];
    expect(screensOf(entries, now)).toEqual([]);
    let stored: string | undefined = "lectern";
    const store = {
      get: () => stored,
      set: (ip: string) => {
        stored = ip;
      },
    };
    const binding = holdBinding(screensOf(entries, now), now, store);
    expect(binding).toBe("lectern");
    expect(binding === "other").toBe(false);
  });

  it("OPEN-02 binding: a verified socket with no helloAt counts from now, and phones and bare sockets never count", () => {
    const now = T + 10_000;
    const entries = [
      { att: { authed: true, role: "screen", ip: "old" }, pong: 0 },
      { att: { authed: true, role: "phone", ip: "phone" }, pong: now },
      { att: { authed: false, role: "screen", ip: "bare" }, pong: now },
      { att: null, pong: now },
    ];
    expect(screensOf(entries, now)).toEqual([{ ip: "old", helloAt: now, heardAt: now }]);
  });

  it("OPEN-02 binding: with no live socket, the last verified proof (a hello or a poll) holds", () => {
    expect(bindingIp([], T, "poller")).toBe("poller");
    expect(bindingIp([{ ip: "gone", helloAt: T, heardAt: T }], T + SILENCE_MS, "poller")).toBe("poller");
    expect(bindingIp([], T, undefined)).toBeUndefined();
  });

  it("OPEN-02 hello: a verified hello with no string address leaves the binding alone", () => {
    // A socket hibernated from before addresses were kept says hello again: binding `undefined` would disable OPEN-02.
    for (const ip of [undefined, null, 7, {}]) expect(helloBinding(ip, [], T), String(ip)).toBeNull();
    expect(helloBinding("B", [], T)).toBe("B");
  });

  it("OPEN-02 roaming: a throttled lectern pinging once a minute keeps the binding; another address takes over only on close or SILENCE_MS", () => {
    // A background tab throttled to one ping a minute misses the client's own MISSED_PINGS estimate every time.
    const MINUTE = 60_000;
    expect(MINUTE).toBeGreaterThan(MISSED_PINGS * PING_MS);
    expect(MINUTE).toBeLessThan(SILENCE_MS);
    const attacker = (now: number) => ({ ip: "attacker", helloAt: now, heardAt: now });
    for (let k = 1; k <= 10; k++) {
      const lastPing = T + (k - 1) * MINUTE;
      const now = T + k * MINUTE - 1;
      const lectern = { ip: "lectern", helloAt: T, heardAt: lastPing };
      expect(helloBinding("attacker", [lectern], now), `minute ${k}`).toBeNull();
      expect(bindingIp([lectern, attacker(now)], now, "lectern"), `minute ${k}`).toBe("lectern");
    }
    // Silent for the full window: the next live socket takes it.
    const lectern = { ip: "lectern", helloAt: T, heardAt: T };
    expect(helloBinding("B", [lectern], T + SILENCE_MS - 1)).toBeNull();
    expect(helloBinding("B", [lectern], T + SILENCE_MS)).toBe("B");
    // Closed: the runtime no longer lists it, so the new address binds at once.
    expect(helloBinding("B", [], T + 1)).toBe("B");
  });
});

describe("Screen alarm: hello timeouts", () => {
  const sock = (readyState: number, fail = false) => {
    const sent: string[] = [];
    const closed: number[] = [];
    return {
      sent,
      closed,
      readyState,
      send(text: string) {
        if (fail) throw new Error("closed under us");
        sent.push(text);
      },
      close(code: number) {
        if (fail) throw new Error("closed under us");
        closed.push(code);
      },
    };
  };
  const late = { authed: false, helloBy: 10 };

  it("a socket that throws on send or close cannot stop the others, or the caller's machine timer", () => {
    const [bad, good] = [sock(OPEN, true), sock(OPEN)];
    const entries = [
      { ws: bad, att: late },
      { ws: good, att: late },
    ];
    expect(() => closeLateHellos(entries, 20)).not.toThrow();
    expect(good.closed).toEqual([1008]);
    expect(JSON.parse(good.sent[0] as string)).toMatchObject({ t: "error", code: "unauthorized" });
  });

  it("skips a socket that is not OPEN, one still inside its hello window, and one already authed", () => {
    const [closing, early, authed] = [sock(2), sock(OPEN), sock(OPEN)];
    closeLateHellos(
      [
        { ws: closing, att: late },
        { ws: early, att: { authed: false, helloBy: 30 } },
        { ws: authed, att: { authed: true, helloBy: 10 } },
      ],
      20,
    );
    expect([closing.sent, closing.closed, early.closed, authed.closed]).toEqual([[], [], [], []]);
  });
});

describe("Screen object: every socket write is guarded", () => {
  it("screen.ts sends only through the coalescer or safeSend, and closes only through drop, so a throw skips nothing", () => {
    const source = readFileSync(new URL("../../src/worker/do/screen.ts", import.meta.url), "utf8");
    expect(source.match(/\.send\(/g) ?? []).toEqual([]);
    expect(source.match(/\.close\(/g) ?? []).toHaveLength(1);
    expect(source).toMatch(/private drop\(ws: WebSocket[\s\S]*?try \{\s*ws\.close\(code, reason\);/);
  });
});

describe("O10 state frames coalesce per socket", () => {
  /** A hand-run clock: `tick(ms)` fires every timer due by then, in order. */
  const clock = () => {
    let now = 0;
    let next = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    return {
      timers,
      t: {
        now: () => now,
        set: (fn: () => void, ms: number) => {
          timers.set(++next, { at: now + ms, fn });
          return next;
        },
        clear: (h: unknown) => void timers.delete(h as number),
      },
      tick(ms: number) {
        const until = now + ms;
        for (;;) {
          const due = [...timers.entries()].filter(([, v]) => v.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
          if (!due) break;
          now = due[1].at;
          timers.delete(due[0]);
          due[1].fn();
        }
        now = until;
      },
    };
  };
  const socket = () => {
    const sent: string[] = [];
    return { sent, send: (text: string) => void sent.push(text) };
  };

  it("O10 leading edge: the first state after a quiet window goes at once; the latest of a burst goes when it closes", () => {
    const c = clock();
    const s = new StateCoalescer({ timers: c.t });
    const ws = socket();
    s.state(ws, "v1");
    expect(ws.sent).toEqual(["v1"]);
    c.tick(50);
    s.state(ws, "v2");
    c.tick(50);
    s.state(ws, "v3");
    expect(ws.sent).toEqual(["v1"]);
    c.tick(COALESCE_MS - 100);
    expect(ws.sent).toEqual(["v1", "v3"]);
    // Quiet for a full window after that send: the next goes at once again, and nothing is left pending.
    c.tick(COALESCE_MS);
    s.state(ws, "v4");
    expect(ws.sent).toEqual(["v1", "v3", "v4"]);
    expect(c.timers.size).toBe(0);
  });

  it("O10 order: an error or open frame flushes the held state first, so nothing reaches the socket out of order", () => {
    const c = clock();
    const s = new StateCoalescer({ timers: c.t });
    const ws = socket();
    s.state(ws, "v1");
    s.state(ws, "v2");
    s.other(ws, "open");
    expect(ws.sent).toEqual(["v1", "v2", "open"]);
    expect(c.timers.size).toBe(0);
    s.other(ws, "error");
    expect(ws.sent).toEqual(["v1", "v2", "open", "error"]);
  });

  it("O10 close: closing flushes then clears the timer; a socket already gone gets nothing and leaves no timer", () => {
    const c = clock();
    const s = new StateCoalescer({ timers: c.t });
    const [a, b] = [socket(), socket()];
    s.state(a, "a1");
    s.state(a, "a2");
    s.closing(a);
    expect(a.sent).toEqual(["a1", "a2"]);
    s.state(b, "b1");
    s.state(b, "b2");
    s.gone(b);
    expect(c.timers.size).toBe(0);
    c.tick(COALESCE_MS * 2);
    expect(b.sent).toEqual(["b1"]);
  });

  it("O10 sockets are independent, and a socket that throws on send never throws to the caller", () => {
    const c = clock();
    const s = new StateCoalescer({ timers: c.t });
    const [a, b] = [socket(), socket()];
    s.state(a, "a1");
    s.state(b, "b1");
    expect([a.sent, b.sent]).toEqual([["a1"], ["b1"]]);
    const broken = {
      send: () => {
        throw new Error("closed");
      },
    };
    expect(() => s.state(broken, "x")).not.toThrow();
    s.state(broken, "y");
    expect(() => c.tick(COALESCE_MS)).not.toThrow();
  });

  it("O10 key: two wrappers of one socket share a slot, so a burst through either still coalesces and close clears it", () => {
    const c = clock();
    // The runtime may hand back a new wrapper for the same socket; the attachment id is the stable key.
    const wrap = (id: string, sent: string[]) => ({ id, send: (text: string) => void sent.push(text) });
    const sent: string[] = [];
    const [first, second] = [wrap("sock-1", sent), wrap("sock-1", sent)];
    const s = new StateCoalescer<{ id: string; send(t: string): void }>({ timers: c.t, keyOf: (w) => w.id });
    s.state(first, "v1");
    s.state(second, "v2");
    s.state(first, "v3");
    expect(sent).toEqual(["v1"]);
    c.tick(COALESCE_MS);
    expect(sent).toEqual(["v1", "v3"]);
    c.tick(COALESCE_MS);
    s.state(second, "v4");
    s.state(first, "v5");
    s.gone(second);
    expect(c.timers.size).toBe(0);
    c.tick(COALESCE_MS * 2);
    expect(sent).toEqual(["v1", "v3", "v4"]);
  });
});
