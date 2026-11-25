import { describe, expect, it } from "vitest";
import { SILENCE_MS } from "../../public/js/core/timing.js";
import {
  admit,
  bindingIp,
  countAuthed,
  holdBinding,
  isLive,
  MAX_PENDING_PER_NET,
  MAX_PENDING_SOCKETS,
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
    expect(bindingIp(screens, now, "leak")).toBe("lectern");
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
});
