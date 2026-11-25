import { describe, expect, it } from "vitest";
import { SILENCE_MS } from "../../public/js/core/timing.js";
import { admit, countAuthed, isLive, MAX_PENDING_PER_NET, MAX_PENDING_SOCKETS } from "../../src/worker/do/sockets.ts";
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
    // One network holding its two does not block another network, or the other role.
    const one = [held("screen", "a", NOW - 2), held("screen", "a", NOW - 1)];
    expect(admit(one, "screen", "a", NOW)).toEqual({ ok: false });
    expect(admit(one, "screen", "b", NOW)).toEqual({ ok: true, evict: null });
    expect(admit(one, "phone", "a", NOW)).toEqual({ ok: true, evict: null });
    const expired = [held("screen", "a", NOW - 9000), held("screen", "a", NOW - 9000)];
    expect(admit(expired, "screen", "a", NOW)).toEqual({ ok: true, evict: null });
    const authed = [held("screen", "a", NOW, true), held("screen", "a", NOW, true), { att: null }];
    expect(admit(authed, "screen", "a", NOW)).toEqual({ ok: true, evict: null });
  });

  it("PAIR-10 pending cap: a full role evicts its oldest waiting socket, so held slots cannot keep a real screen out", () => {
    const full = [
      held("screen", "a", NOW - 40),
      held("screen", "a", NOW - 30),
      held("screen", "b", NOW - 20),
      held("screen", "b", NOW - 10),
    ];
    const admitted = admit(full, "screen", "c", NOW);
    expect(admitted.ok && admitted.evict?.id).toBe(`screen-a-${NOW - 40}`);
    // The other role is not full, and a network at its own cap is still refused rather than evicting for itself.
    expect(admit(full, "phone", "c", NOW)).toEqual({ ok: true, evict: null });
    expect(admit(full, "screen", "a", NOW)).toEqual({ ok: false });
  });

  it("PAIR-10 liveness: a socket is live until it has been quiet for SILENCE_MS", () => {
    expect(isLive(NOW, NOW + SILENCE_MS - 1)).toBe(true);
    expect(isLive(NOW, NOW + SILENCE_MS)).toBe(false);
  });
});
