import { describe, expect, it } from "vitest";
import { countAuthed, countPending, MAX_PENDING_SOCKETS } from "../../src/worker/do/sockets.ts";
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

  it("PAIR-10 pending cap: sockets waiting for their hello are counted apart from authed ones", () => {
    const atts = [{ authed: true }, { authed: false }, null, { authed: false }];
    expect(countPending(atts)).toBe(3);
    expect(MAX_PENDING_SOCKETS).toBe(4);
  });
});
