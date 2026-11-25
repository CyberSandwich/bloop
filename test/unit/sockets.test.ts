import { describe, expect, it } from "vitest";
import { countAuthed, MAX_PENDING_PER_IP, MAX_PENDING_SOCKETS, mayWait } from "../../src/worker/do/sockets.ts";
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

  it("PAIR-10 pending cap: per role and per address hash, authed sockets never count", () => {
    const held = (role: string, ip: string, authed = false) => ({ role, ip, authed });
    expect(MAX_PENDING_SOCKETS).toBe(4);
    expect(MAX_PENDING_PER_IP).toBe(2);
    // One address holding its two does not block another address, or the other role.
    const one = [held("screen", "a"), held("screen", "a")];
    expect(mayWait(one, "screen", "a")).toBe(false);
    expect(mayWait(one, "screen", "b")).toBe(true);
    expect(mayWait(one, "phone", "a")).toBe(true);
    // Four pending in a role fill it for everyone, and the other role is untouched.
    const four = [held("screen", "a"), held("screen", "a"), held("screen", "b"), held("screen", "b")];
    expect(mayWait(four, "screen", "c")).toBe(false);
    expect(mayWait(four, "phone", "c")).toBe(true);
    // An authed socket and a closed slot (null) are not pending.
    expect(mayWait([held("screen", "a", true), held("screen", "a", true), null], "screen", "a")).toBe(true);
  });
});
