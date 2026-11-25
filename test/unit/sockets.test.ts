import { describe, expect, it } from "vitest";
import { countAuthed } from "../../src/worker/do/sockets.ts";
import { must, sec, T0, waiting } from "./machine-helpers.ts";

describe("PAIR-10 socket count", () => {
  it("PAIR-10 unauthed socket holds no closeAt: only authenticated sockets are counted", () => {
    expect(countAuthed([{ authed: false }, null, { authed: false }])).toBe(0);
    expect(countAuthed([{ authed: false }, { authed: true }])).toBe(1);
    // A waiting screen with only bare upgrades keeps its close deadline.
    const open = countAuthed([{ authed: false }]);
    expect(must(waiting(), { e: "socket", now: T0 + sec(5), open }).next.closeAt).not.toBeNull();
  });
});
