import { describe, expect, it } from "vitest";
import { createMachine, type Event, type Machine, nextDeadline, transition } from "../../src/worker/machine.ts";
import {
  approved,
  CFG,
  claim,
  claimedGuest,
  claimedOwner,
  closed,
  DECK,
  ended,
  fx,
  GUEST_FILE,
  MAX_MINUTES,
  must,
  offered,
  sec,
  T0,
  violations,
  waiting,
} from "./machine-helpers.ts";

const refused = (m: Machine, ev: Event) => {
  const step = transition(m, ev, CFG);
  if (step.ok) throw new Error(`${ev.e} unexpectedly ok`);
  return step.error;
};

describe("machine: code.next", () => {
  it("issues a code valid for ttl plus grace and registers it with the Directory", () => {
    const m = createMachine("demo", T0, CFG);
    const { next, effects } = must(m, { e: "code.next", now: T0, value: "K7MQ9X" });
    expect(next.state).toBe("waiting");
    expect(next.codes.current).toEqual({ value: "K7MQ9X", issuedAt: T0, expiresAt: T0 + sec(70), consumed: false });
    expect(effects).toContainEqual({ fx: "directory.put", code: "K7MQ9X", expiresAt: T0 + sec(70) });
    expect(effects).toContainEqual({ fx: "push", to: "screen" });
  });

  it("keeps the old code as previous and forgets the one before it", () => {
    let m = waiting("demo", "AAAAAA");
    m = must(m, { e: "code.next", now: T0 + sec(60), value: "BBBBBB" }).next;
    expect(m.codes.previous?.value).toBe("AAAAAA");
    const step = must(m, { e: "code.next", now: T0 + sec(120), value: "CCCCCC" });
    expect(step.next.codes.previous?.value).toBe("BBBBBB");
    expect(step.effects).toContainEqual({ fx: "directory.remove", code: "AAAAAA" });
  });

  it("allows at most 6 codes per minute and recovers when the minute passes", () => {
    let m = createMachine("demo", T0, CFG);
    for (let i = 0; i < 6; i++) m = must(m, { e: "code.next", now: T0 + sec(i), value: `CODE${i}` }).next;
    expect(refused(m, { e: "code.next", now: T0 + sec(7), value: "OVER" })).toBe("rate_limited");
    expect(must(m, { e: "code.next", now: T0 + sec(61), value: "AGAIN" }).next.codes.current?.value).toBe("AGAIN");
  });

  it("is refused 3 s after an end, then starts a fresh waiting state", () => {
    const m = ended(T0 + sec(20));
    expect(refused(m, { e: "code.next", now: T0 + sec(22), value: "NEWNEW" })).toBe("rate_limited");
    const next = must(m, { e: "code.next", now: T0 + sec(23), value: "NEWNEW" }).next;
    expect(next.state).toBe("waiting");
    expect(next.pairing).toBeNull();
    expect(next.endReason).toBeNull();
  });

  it("keeps the reason of a drop to waiting through rotation, and clears it after an ended session", () => {
    const dropped = must(claimedOwner(), { e: "restart", now: T0 + sec(50) }).next;
    expect(dropped.endReason).toBe("canceled");
    const rotated = must(dropped, { e: "code.next", now: T0 + sec(51), value: "NEWNEW" }).next;
    expect(rotated.endReason).toBe("canceled");
    expect(must(ended(T0 + sec(20)), { e: "code.next", now: T0 + sec(30), value: "X" }).next.endReason).toBeNull();
  });

  it("is refused while a phone is paired", () => {
    expect(refused(claimedOwner(), { e: "code.next", now: T0 + sec(2), value: "X" })).toBe("wrong_state");
  });
});

describe("machine: claim", () => {
  it("locks the code to the first phone, fixes the match code and audits", () => {
    const m = waiting();
    const { next, effects } = must(m, {
      e: "claim",
      now: T0 + sec(5),
      code: "AAAAAA",
      sessionId: "s1",
      secretHash: "h",
      match: "07",
      kind: "owner",
      userId: null,
      passHash: null,
    });
    expect(next.state).toBe("claimed");
    expect(next.codes.current?.consumed).toBe(true);
    expect(next.pairing).toMatchObject({ match: "07", secretHash: "h", kind: "owner", claimedAt: T0 + sec(5) });
    expect(effects).toContainEqual({ fx: "audit", type: "claimed", actor: "phone" });
    expect(effects).toContainEqual({ fx: "push", to: "both" });
  });

  it("refuses a replay of the used code with code_taken", () => {
    expect(
      refused(claimedOwner(), {
        e: "claim",
        now: T0 + sec(2),
        code: "AAAAAA",
        sessionId: "s2",
        secretHash: "h2",
        match: "11",
        kind: "owner",
        userId: null,
        passHash: null,
      }),
    ).toBe("code_taken");
  });

  it("refuses a code that was never issued, and any claim on a closed screen", () => {
    const attempt = (code: string): Event => ({
      e: "claim",
      now: T0 + sec(2),
      code,
      sessionId: "s",
      secretHash: "h",
      match: "11",
      kind: "owner",
      userId: null,
      passHash: null,
    });
    expect(refused(waiting(), attempt("ZZZZZZ"))).toBe("code_expired");
    expect(refused(closed(), attempt("AAAAAA"))).toBe("screen_gone");
  });

  it("accepts a code until ttl plus grace and refuses it from then on", () => {
    const attempt = (now: number): Event => ({
      e: "claim",
      now,
      code: "AAAAAA",
      sessionId: "s",
      secretHash: "h",
      match: "11",
      kind: "owner",
      userId: null,
      passHash: null,
    });
    expect(must(waiting(), attempt(T0 + sec(70) - 1)).next.state).toBe("claimed");
    expect(refused(waiting(), attempt(T0 + sec(70)))).toBe("code_expired");
  });

  it("keeps the previous code claimable for the grace after its successor, and no longer", () => {
    const m = must(waiting("demo", "AAAAAA"), { e: "code.next", now: T0 + sec(60), value: "BBBBBB" }).next;
    const attempt = (now: number): Event => ({
      e: "claim",
      now,
      code: "AAAAAA",
      sessionId: "s",
      secretHash: "h",
      match: "11",
      kind: "owner",
      userId: null,
      passHash: null,
    });
    expect(must(m, attempt(T0 + sec(69))).next.state).toBe("claimed");
    expect(refused(m, attempt(T0 + sec(70)))).toBe("code_expired");
  });

  it("answers code_taken for the other live code once a phone holds the session", () => {
    let m = must(waiting("demo", "AAAAAA"), { e: "code.next", now: T0 + sec(60), value: "BBBBBB" }).next;
    m = claim(m, "owner", T0 + sec(61), "BBBBBB");
    expect(
      refused(m, {
        e: "claim",
        now: T0 + sec(62),
        code: "AAAAAA",
        sessionId: "s",
        secretHash: "h",
        match: "11",
        kind: "owner",
        userId: null,
        passHash: null,
      }),
    ).toBe("code_taken");
  });

  it("stores a guest kind and a pass hash", () => {
    const m = must(waiting(), {
      e: "claim",
      now: T0 + sec(1),
      code: "AAAAAA",
      sessionId: "s",
      secretHash: "h",
      match: "11",
      kind: "guest",
      userId: null,
      passHash: "ph",
    }).next;
    expect(m.pairing).toMatchObject({ kind: "guest", passHash: "ph" });
  });
});

describe("machine: listed and approve", () => {
  it("moves an owner from claimed to choosing and stores the ids", () => {
    const next = must(claimedOwner(), { e: "listed", now: T0 + sec(2), ids: ["a", "b"] }).next;
    expect(next.state).toBe("choosing");
    expect(next.pairing?.listed).toEqual(["a", "b"]);
  });

  it("refuses listing for a guest", () => {
    expect(refused(claimedGuest(), { e: "listed", now: T0 + sec(2), ids: [] })).toBe("wrong_state");
  });

  it("approves a listed file in live mode and a fixture in demo mode", () => {
    const live = must(claimedOwner("live"), { e: "listed", now: T0 + sec(2), ids: ["deck-1"] }).next;
    const a = must(live, { e: "approve", now: T0 + sec(3), file: DECK, maxMinutes: MAX_MINUTES });
    expect(a.next.state).toBe("approved");
    expect(a.next.session).toMatchObject({
      file: DECK,
      approvedAt: T0 + sec(3),
      endsAt: T0 + sec(3) + MAX_MINUTES * 60_000,
    });
    expect(a.effects).toEqual([
      { fx: "mint", purpose: "protocol" },
      { fx: "audit", type: "approved", actor: "phone" },
      { fx: "push", to: "both" },
    ]);
    expect(approved().state).toBe("approved");
  });

  it("refuses a live approve of an id that was not listed (SRC-02)", () => {
    expect(refused(claimedOwner("live"), { e: "approve", now: T0 + sec(3), file: DECK, maxMinutes: 90 })).toBe(
      "file_not_found",
    );
    const listed = must(claimedOwner("live"), { e: "listed", now: T0 + sec(2), ids: ["other"] }).next;
    expect(refused(listed, { e: "approve", now: T0 + sec(3), file: DECK, maxMinutes: 90 })).toBe("file_not_found");
  });

  it("is idempotent for the same file and refuses another", () => {
    const m = approved();
    const again = must(m, { e: "approve", now: T0 + sec(20), file: DECK, maxMinutes: 90 });
    expect(again.next).toBe(m);
    expect(again.effects).toEqual([]);
    expect(refused(m, { e: "approve", now: T0 + sec(20), file: { ...DECK, ref: "other" }, maxMinutes: 90 })).toBe(
      "wrong_state",
    );
  });

  it("answers session_ended after the end, wrong_state for a guest, wrong_state while waiting", () => {
    const ev: Event = { e: "approve", now: T0 + sec(30), file: DECK, maxMinutes: 90 };
    expect(refused(ended(), ev)).toBe("session_ended");
    expect(refused(claimedGuest(), ev)).toBe("wrong_state");
    expect(refused(waiting(), ev)).toBe("wrong_state");
  });
});

describe("machine: guest upload and the Open click", () => {
  it("claimed guest starts an upload with a deadline", () => {
    const m = must(claimedGuest(), { e: "upload.start", now: T0 + sec(5), timeoutSeconds: 900 }).next;
    expect(m.state).toBe("uploading");
    expect(m.uploadAt).toBe(T0 + sec(905));
  });

  it("refuses an upload for an owner or a second upload", () => {
    expect(refused(claimedOwner(), { e: "upload.start", now: T0 + sec(5), timeoutSeconds: 900 })).toBe("wrong_state");
    const m = must(claimedGuest(), { e: "upload.start", now: T0 + sec(5), timeoutSeconds: 900 }).next;
    expect(refused(m, { e: "upload.start", now: T0 + sec(6), timeoutSeconds: 900 })).toBe("wrong_state");
  });

  it("offers a validated upload and audits it; nothing is minted yet", () => {
    const up = must(claimedGuest(), { e: "upload.start", now: T0 + sec(5), timeoutSeconds: 900 }).next;
    const done = must(up, { e: "upload.done", now: T0 + sec(8), file: GUEST_FILE });
    expect(done.next.state).toBe("offered");
    expect(done.next.session).toMatchObject({ file: GUEST_FILE, approvedAt: null, endsAt: null });
    expect(done.next.offerAt).toBe(T0 + sec(8) + sec(300));
    expect(done.effects).toContainEqual({ fx: "audit", type: "guest.uploaded", actor: "phone" });
    expect(fx(done.effects, "mint")).toEqual([]);
  });

  it("returns to claimed on a failed upload and audits the cause", () => {
    const up = must(claimedGuest(), { e: "upload.start", now: T0 + sec(5), timeoutSeconds: 900 }).next;
    const failed = must(up, { e: "upload.failed", now: T0 + sec(6), error: "bad_structure" });
    expect(failed.next.state).toBe("claimed");
    expect(failed.next.uploadAt).toBeNull();
    expect(failed.effects).toContainEqual({
      fx: "audit",
      type: "guest.refused",
      actor: "phone",
      cause: "bad_structure",
    });
  });

  it("opens an offer only on open.click, as the screen, and sets the session end (DROP-06)", () => {
    const m = offered();
    const { next, effects } = must(m, { e: "open.click", now: T0 + sec(40), maxMinutes: MAX_MINUTES });
    expect(next.state).toBe("approved");
    expect(next.session).toMatchObject({
      file: GUEST_FILE,
      approvedAt: T0 + sec(40),
      endsAt: T0 + sec(40) + 90 * 60_000,
    });
    expect(effects).toContainEqual({ fx: "mint", purpose: "protocol" });
    expect(effects).toContainEqual({ fx: "audit", type: "approved", actor: "screen" });
  });

  it("refuses open.click before an offer exists and repeats it as a no-op", () => {
    const ev: Event = { e: "open.click", now: T0 + sec(40), maxMinutes: 90 };
    expect(refused(claimedGuest(), ev)).toBe("wrong_state");
    const open = must(offered(), ev).next;
    expect(must(open, ev).next).toBe(open);
  });
});

describe("machine: open, fetch, fallback", () => {
  it("records the launch mode, then the first fetch with both timings", () => {
    const launched = must(approved(T0 + sec(10)), { e: "launched", now: T0 + sec(11), mode: "protocol" }).next;
    expect(launched.state).toBe("opening");
    expect(launched.session?.openMode).toBe("protocol");
    const fetched = must(launched, { e: "fetched", now: T0 + sec(13) });
    expect(fetched.next.state).toBe("open");
    expect(fetched.next.session?.firstOpenAt).toBe(T0 + sec(13));
    expect(fx(fetched.effects, "metric")).toEqual([
      { fx: "metric", name: "scan_to_open_ms", ms: sec(13) - sec(1) },
      { fx: "metric", name: "approve_to_open_ms", ms: sec(3) },
    ]);
  });

  it("opens on a fetch straight from approved, and a repeat fetch is a no-op", () => {
    const open = must(approved(), { e: "fetched", now: T0 + sec(12) }).next;
    expect(open.state).toBe("open");
    expect(must(open, { e: "fetched", now: T0 + sec(14) }).next).toBe(open);
  });

  it("refuses launch outside approved", () => {
    expect(refused(claimedOwner(), { e: "launched", now: T0 + sec(5), mode: "protocol" })).toBe("wrong_state");
  });

  it("mints a fallback link up to the cap, then mint_limit", () => {
    let m = must(approved(), { e: "launched", now: T0 + sec(11), mode: "protocol" }).next;
    for (let i = 0; i < 5; i++) {
      const step = must(m, { e: "fallback", now: T0 + sec(12 + i), mode: "download", maxMints: 5 });
      expect(step.effects).toContainEqual({ fx: "mint", purpose: "download" });
      m = step.next;
    }
    expect(refused(m, { e: "fallback", now: T0 + sec(30), mode: "pdf", maxMints: 5 })).toBe("mint_limit");
  });

  it("refuses a fallback before the launch", () => {
    expect(refused(approved(), { e: "fallback", now: T0 + sec(12), mode: "download", maxMints: 5 })).toBe(
      "wrong_state",
    );
  });
});

describe("machine: cancel and restart (Start Over)", () => {
  const pre: [string, () => Machine][] = [
    ["claimed", claimedOwner],
    ["choosing", () => must(claimedOwner(), { e: "listed", now: T0 + sec(2), ids: ["a"] }).next],
    ["uploading", () => must(claimedGuest(), { e: "upload.start", now: T0 + sec(5), timeoutSeconds: 900 }).next],
    ["offered", offered],
  ];

  for (const [name, build] of pre) {
    it(`restart from ${name} drops the phone, wipes the codes and returns to waiting as the screen`, () => {
      const m = build();
      const { next, effects } = must(m, { e: "restart", now: T0 + sec(50) });
      expect(next.state).toBe("waiting");
      expect(next.pairing).toBeNull();
      expect(next.session).toBeNull();
      expect(next.codes).toEqual({ current: null, previous: null });
      expect(next.endReason).toBe("canceled");
      expect(effects).toContainEqual({ fx: "audit", type: "canceled", actor: "screen" });
      expect(effects).toContainEqual({ fx: "directory.remove", code: "AAAAAA" });
      expect(effects).toContainEqual({ fx: "push", to: "both" });
      expect(violations(next)).toEqual([]);
    });

    it(`cancel from ${name} returns to waiting as the phone`, () => {
      const { next, effects } = must(build(), { e: "cancel", now: T0 + sec(50) });
      expect(next.state).toBe("waiting");
      expect(next.endReason).toBe("canceled");
      expect(effects).toContainEqual({ fx: "audit", type: "canceled", actor: "phone" });
    });
  }

  it("purges the guest object on restart of an offer and of an upload", () => {
    expect(fx(must(offered(), { e: "restart", now: T0 + sec(50) }).effects, "purge")).toEqual([
      { fx: "purge", file: GUEST_FILE },
    ]);
    const up = must(claimedGuest(), { e: "upload.start", now: T0 + sec(5), timeoutSeconds: 900 }).next;
    expect(fx(must(up, { e: "cancel", now: T0 + sec(50) }).effects, "purge")).toEqual([{ fx: "purge", file: null }]);
  });

  it("refuses both once approved, and while waiting", () => {
    for (const ev of [
      { e: "cancel", now: T0 + sec(50) },
      { e: "restart", now: T0 + sec(50) },
    ] as const) {
      expect(refused(approved(), ev)).toBe("wrong_state");
      expect(refused(waiting(), ev)).toBe("wrong_state");
    }
  });

  it("lets a fresh phone claim after a restart only with a fresh code", () => {
    const dropped = must(claimedOwner(), { e: "restart", now: T0 + sec(50) }).next;
    const fresh = must(dropped, { e: "code.next", now: T0 + sec(51), value: "NEWNEW" }).next;
    expect(claim(fresh, "owner", T0 + sec(52), "NEWNEW", "s2").pairing?.sessionId).toBe("s2");
    expect(
      refused(fresh, {
        e: "claim",
        now: T0 + sec(52),
        code: "AAAAAA",
        sessionId: "s",
        secretHash: "h",
        match: "11",
        kind: "owner",
        userId: null,
        passHash: null,
      }),
    ).toBe("code_expired");
  });
});

describe("machine: end", () => {
  it("ends an approved session from the phone: revokes, audits, records minutes, keeps only the pairing secret", () => {
    const { next, effects } = must(approved(T0 + sec(10)), { e: "end", now: T0 + sec(70), by: "phone" });
    expect(next.state).toBe("ended");
    expect(next.endReason).toBe("phone");
    expect(next.endedAt).toBe(T0 + sec(70));
    expect(next.session).toBeNull();
    expect(next.pairing).toMatchObject({ secretHash: "hash", listed: [], userId: null, passHash: null });
    expect(effects).toContainEqual({ fx: "revokeLinks" });
    expect(effects).toContainEqual({ fx: "purge", file: DECK });
    expect(effects).toContainEqual({ fx: "audit", type: "ended", actor: "phone" });
    expect(effects).toContainEqual({ fx: "metric", name: "session_minutes", ms: sec(60) });
    expect(effects).toContainEqual({ fx: "push", to: "both" });
    expect(violations(next)).toEqual([]);
  });

  it("ends from the screen with reason screen", () => {
    const next = must(approved(), { e: "end", now: T0 + sec(70), by: "screen" }).next;
    expect(next.endReason).toBe("screen");
  });

  it("ends a claimed session before approval without a session row or links", () => {
    const { next, effects } = must(claimedOwner(), { e: "end", now: T0 + sec(20), by: "screen" });
    expect(next.state).toBe("ended");
    expect(fx(effects, "revokeLinks")).toEqual([]);
    expect(fx(effects, "metric")).toEqual([]);
  });

  it("is idempotent when already ended, and wrong_state while waiting", () => {
    const m = ended();
    expect(must(m, { e: "end", now: T0 + sec(30), by: "screen" }).next).toBe(m);
    expect(refused(waiting(), { e: "end", now: T0 + sec(30), by: "screen" })).toBe("wrong_state");
  });

  it("maps a system end to reason auto", () => {
    expect(must(approved(), { e: "end", now: T0 + sec(30), by: "system" }).next.endReason).toBe("auto");
  });
});

describe("machine: timers", () => {
  it("does nothing before the deadline", () => {
    const m = claimedOwner();
    expect(must(m, { e: "timer", now: T0 + sec(1) + sec(299) }).next).toBe(m);
  });

  it("drops an unapproved claim back to waiting after the claim timeout", () => {
    const m = claimedOwner(); // claimed at T0 + 1 s
    const { next, effects } = must(m, { e: "timer", now: T0 + sec(1) + sec(300) });
    expect(next.state).toBe("waiting");
    expect(next.endReason).toBe("claim_timeout");
    expect(next.pairing).toBeNull();
    expect(effects).toContainEqual({ fx: "audit", type: "canceled", actor: "system" });
  });

  it("drops a stalled upload and deletes its object", () => {
    const up = must(claimedGuest(), { e: "upload.start", now: T0 + sec(5), timeoutSeconds: 900 }).next;
    expect(must(up, { e: "timer", now: T0 + sec(904) }).next).toBe(up);
    const { next, effects } = must(up, { e: "timer", now: T0 + sec(905) });
    expect(next.state).toBe("waiting");
    expect(next.endReason).toBe("claim_timeout");
    expect(effects).toContainEqual({ fx: "purge", file: null });
  });

  it("drops an unclicked offer and deletes the object (DROP-06)", () => {
    const m = offered(T0 + sec(10)); // offered at T0 + 11 s
    const { next, effects } = must(m, { e: "timer", now: T0 + sec(11) + sec(300) });
    expect(next.state).toBe("waiting");
    expect(next.endReason).toBe("claim_timeout");
    expect(effects).toContainEqual({ fx: "purge", file: GUEST_FILE });
  });

  it("ends an approved session by itself at the maximum, with reason auto (PC-04)", () => {
    const m = approved(T0 + sec(10));
    const due = T0 + sec(10) + MAX_MINUTES * 60_000;
    expect(must(m, { e: "timer", now: due - 1 }).next).toBe(m);
    const { next, effects } = must(m, { e: "timer", now: due });
    expect(next.state).toBe("ended");
    expect(next.endReason).toBe("auto");
    expect(effects).toContainEqual({ fx: "audit", type: "ended", actor: "system" });
    expect(effects).toContainEqual({ fx: "revokeLinks" });
  });

  it("closes a waiting or ended screen 10 minutes after the last socket and deletes everything", () => {
    const m = waiting();
    expect(m.closeAt).toBe(T0 + sec(600));
    const { next, effects } = must(m, { e: "timer", now: T0 + sec(600) });
    expect(next.state).toBe("closed");
    expect(effects).toContainEqual({ fx: "deleteAll" });
    const e = ended(T0 + sec(20));
    expect(must(e, { e: "timer", now: T0 + sec(20) + sec(600) }).next.state).toBe("closed");
  });
});

describe("machine: sockets and closeAt", () => {
  it("clears the close deadline while a socket is open and re-arms when the last one closes", () => {
    const open = must(waiting(), { e: "socket", now: T0 + sec(5), open: 1 }).next;
    expect(open.closeAt).toBeNull();
    expect(nextDeadline(open, CFG)).toBeNull();
    const shut = must(open, { e: "socket", now: T0 + sec(100), open: 0 }).next;
    expect(shut.closeAt).toBe(T0 + sec(700));
  });

  it("a transition into waiting or ended respects the open socket count", () => {
    const open = must(claimedOwner(), { e: "socket", now: T0 + sec(5), open: 1 }).next;
    expect(must(open, { e: "restart", now: T0 + sec(6) }).next.closeAt).toBeNull();
    expect(must(open, { e: "end", now: T0 + sec(6), by: "screen" }).next.closeAt).toBeNull();
    expect(must(claimedOwner(), { e: "restart", now: T0 + sec(6) }).next.closeAt).toBe(T0 + sec(606));
  });

  it("leaves closeAt null in states that have their own deadline", () => {
    expect(must(claimedOwner(), { e: "socket", now: T0 + sec(5), open: 0 }).next.closeAt).toBeNull();
  });
});

describe("machine: closed", () => {
  it("answers screen_gone to every event", () => {
    const m = closed();
    const events: Event[] = [
      { e: "code.next", now: T0, value: "X" },
      { e: "restart", now: T0 },
      { e: "cancel", now: T0 },
      { e: "end", now: T0, by: "screen" },
      { e: "timer", now: T0 },
      { e: "socket", now: T0, open: 1 },
      { e: "fetched", now: T0 },
    ];
    for (const ev of events) expect(refused(m, ev)).toBe("screen_gone");
  });
});

describe("machine: nextDeadline", () => {
  it("is the right deadline per state, and never null for a state with a timer", () => {
    expect(nextDeadline(waiting(), CFG)).toBe(T0 + sec(600));
    expect(nextDeadline(claimedOwner(), CFG)).toBe(T0 + sec(1) + sec(300));
    expect(
      nextDeadline(must(claimedGuest(), { e: "upload.start", now: T0 + sec(5), timeoutSeconds: 900 }).next, CFG),
    ).toBe(T0 + sec(905));
    expect(nextDeadline(offered(T0 + sec(10)), CFG)).toBe(T0 + sec(311));
    expect(nextDeadline(approved(T0 + sec(10)), CFG)).toBe(T0 + sec(10) + 90 * 60_000);
    expect(nextDeadline(closed(), CFG)).toBeNull();
  });
});

describe("machine: every reachable example state is valid", () => {
  it("holds the field invariants", () => {
    const states: Machine[] = [
      waiting(),
      claimedOwner(),
      claimedGuest(),
      offered(),
      approved(),
      must(approved(), { e: "launched", now: T0 + sec(12), mode: "protocol" }).next,
      must(approved(), { e: "fetched", now: T0 + sec(12) }).next,
      ended(),
      closed(),
    ];
    for (const m of states) expect(violations(m), m.state).toEqual([]);
  });
});
