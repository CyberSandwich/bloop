import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createMachine, type Event, type Machine, nextDeadline, transition } from "../../src/worker/machine.ts";
import { CFG, DECK, GUEST_FILE, MAX_MINUTES, T0, violations } from "./machine-helpers.ts";

type Action =
  | { k: "next" }
  | { k: "claim"; pick: number; guest: boolean }
  | { k: "claimBogus" }
  | { k: "listed" }
  | { k: "approve"; listed: boolean }
  | { k: "uploadStart" }
  | { k: "uploadDone" }
  | { k: "uploadFailed" }
  | { k: "openClick" }
  | { k: "launched" }
  | { k: "fetched" }
  | { k: "fallback" }
  | { k: "cancel" }
  | { k: "restart" }
  | { k: "end"; by: "phone" | "screen" | "system" }
  | { k: "socket"; open: number }
  | { k: "timer" };

const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 4, arbitrary: fc.constant({ k: "next" } as const) },
  { weight: 5, arbitrary: fc.record({ k: fc.constant("claim" as const), pick: fc.nat(), guest: fc.boolean() }) },
  { weight: 1, arbitrary: fc.constant({ k: "claimBogus" } as const) },
  { weight: 2, arbitrary: fc.constant({ k: "listed" } as const) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant("approve" as const), listed: fc.boolean() }) },
  { weight: 2, arbitrary: fc.constant({ k: "uploadStart" } as const) },
  { weight: 2, arbitrary: fc.constant({ k: "uploadDone" } as const) },
  { weight: 1, arbitrary: fc.constant({ k: "uploadFailed" } as const) },
  { weight: 2, arbitrary: fc.constant({ k: "openClick" } as const) },
  { weight: 2, arbitrary: fc.constant({ k: "launched" } as const) },
  { weight: 2, arbitrary: fc.constant({ k: "fetched" } as const) },
  { weight: 1, arbitrary: fc.constant({ k: "fallback" } as const) },
  { weight: 1, arbitrary: fc.constant({ k: "cancel" } as const) },
  { weight: 1, arbitrary: fc.constant({ k: "restart" } as const) },
  {
    weight: 1,
    arbitrary: fc.record({ k: fc.constant("end" as const), by: fc.constantFrom("phone", "screen", "system") }),
  },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("socket" as const), open: fc.integer({ min: 0, max: 2 }) }) },
  { weight: 3, arbitrary: fc.constant({ k: "timer" } as const) },
);

const dt = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 0, max: 5_000 }) },
  { weight: 4, arbitrary: fc.integer({ min: 0, max: 80_000 }) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 120 * 60_000 }) },
  // The edges: a code's ttl and grace, the claim timeout, one millisecond either side.
  {
    weight: 3,
    arbitrary: fc.constantFrom(0, 1, 9_999, 10_000, 59_999, 60_000, 69_999, 70_000, 70_001, 299_999, 300_000),
  },
);

const script = fc.array(fc.record({ dt, a: action }), { maxLength: 80 });

interface Trace {
  before: Machine;
  after: Machine;
  event: Event;
  ok: boolean;
  /** Codes issued so far: value to issue time. */
  issued: Map<string, number>;
}

/** Runs a script from a fresh machine, calling `observe` after every step. */
function run(steps: { dt: number; a: Action }[], observe: (t: Trace) => void): Machine {
  let m = createMachine("live", T0, CFG);
  let now = T0;
  let counter = 0;
  const issued = new Map<string, number>();
  const codes: string[] = [];
  for (const { dt: d, a } of steps) {
    now += d;
    const ev = toEvent(a);
    if (!ev) continue;
    const before = structuredClone(m);
    const step = transition(m, ev, CFG);
    if (step.ok) {
      m = step.next;
      if (ev.e === "code.next") {
        issued.set(ev.value, now);
        codes.push(ev.value);
      }
    } else {
      // Purity: a refusal leaves the input untouched.
      expect(m).toEqual(before);
    }
    observe({ before, after: m, event: ev, ok: step.ok, issued });
  }
  return m;

  function toEvent(a: Action): Event | null {
    switch (a.k) {
      case "next":
        return { e: "code.next", now, value: `C${counter++}` };
      case "claim": {
        const code = codes.length ? codes[a.pick % codes.length] : undefined;
        return code === undefined ? null : claimEvent(code, a.guest);
      }
      case "claimBogus":
        return claimEvent("NOPE", false);
      case "listed":
        return { e: "listed", now, ids: [DECK.ref] };
      case "approve":
        return { e: "approve", now, file: a.listed ? DECK : { ...DECK, ref: "unlisted" }, maxMinutes: MAX_MINUTES };
      case "uploadStart":
        return { e: "upload.start", now, timeoutSeconds: 900 };
      case "uploadDone":
        return { e: "upload.done", now, file: GUEST_FILE };
      case "uploadFailed":
        return { e: "upload.failed", now, error: "bad_structure" };
      case "openClick":
        return { e: "open.click", now, maxMinutes: MAX_MINUTES };
      case "launched":
        return { e: "launched", now, mode: "protocol" };
      case "fetched":
        return { e: "fetched", now };
      case "fallback":
        return { e: "fallback", now, mode: "download", maxMints: 5 };
      case "cancel":
        return { e: "cancel", now };
      case "restart":
        return { e: "restart", now };
      case "end":
        return { e: "end", now, by: a.by };
      case "socket":
        return { e: "socket", now, open: a.open };
      case "timer":
        return { e: "timer", now };
    }
  }

  function claimEvent(code: string, guest: boolean): Event {
    return {
      e: "claim",
      now,
      code,
      sessionId: `s${counter++}`,
      secretHash: `h${counter}`,
      match: "42",
      kind: guest ? "guest" : "owner",
      userId: null,
      passHash: null,
    };
  }
}

const RUNS = { numRuns: 400 };
const PAIRED_OR_LIVE = ["claimed", "choosing", "uploading", "offered", "approved", "opening", "open"];

describe("machine properties", () => {
  it("PAIR-01 a code is never accepted twice", () => {
    fc.assert(
      fc.property(script, (steps) => {
        const accepted = new Map<string, number>();
        run(steps, ({ event, ok }) => {
          if (event.e === "claim" && ok) accepted.set(event.code, (accepted.get(event.code) ?? 0) + 1);
        });
        for (const n of accepted.values()) expect(n).toBe(1);
      }),
      RUNS,
    );
  });

  it("PAIR-01 a code is never accepted after its window plus grace", () => {
    fc.assert(
      fc.property(script, (steps) => {
        run(steps, ({ event, ok, issued }) => {
          if (event.e !== "claim" || !ok) return;
          const at = issued.get(event.code);
          expect(at).toBeDefined();
          expect(event.now).toBeLessThan((at as number) + (CFG.codeTtlSeconds + CFG.codeGraceSeconds) * 1000);
        });
      }),
      RUNS,
    );
  });

  it("PAIR-05 a second phone never takes over a locked session", () => {
    fc.assert(
      fc.property(script, (steps) => {
        run(steps, ({ before, after, event, ok }) => {
          // A claim only ever succeeds from waiting.
          if (event.e === "claim" && ok) expect(before.state).toBe("waiting");
          // While a pairing is held, its secret and session never change.
          if (PAIRED_OR_LIVE.includes(before.state) && PAIRED_OR_LIVE.includes(after.state)) {
            expect(after.pairing?.secretHash).toBe(before.pairing?.secretHash);
            expect(after.pairing?.sessionId).toBe(before.pairing?.sessionId);
            expect(after.pairing?.match).toBe(before.pairing?.match);
          }
        });
      }),
      RUNS,
    );
  });

  it("PAIR-05 no code, current or previous, claims a session a phone already holds", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 70_000 }), // second code issued this long after the first
        fc.integer({ min: 0, max: 20_000 }), // first claim this long after the second code
        fc.integer({ min: 0, max: 60_000 }), // second claim this long after the first
        fc.boolean(), // the first phone used the older code
        (gap, firstDelay, secondDelay, firstUsesOld) => {
          let m = createMachine("live", T0, CFG);
          const issue = (now: number, value: string) => {
            const step = transition(m, { e: "code.next", now, value }, CFG);
            if (step.ok) m = step.next;
          };
          issue(T0, "OLD");
          issue(T0 + gap, "NEW");
          const claimAt = T0 + gap + firstDelay;
          const claimWith = (now: number, code: string) =>
            transition(
              m,
              {
                e: "claim",
                now,
                code,
                sessionId: "s",
                secretHash: "h",
                match: "42",
                kind: "owner",
                userId: null,
                passHash: null,
              },
              CFG,
            );
          const first = claimWith(claimAt, firstUsesOld ? "OLD" : "NEW");
          if (!first.ok) return; // not claimable at that moment: nothing to protect
          m = first.next;
          for (const code of ["OLD", "NEW"]) {
            expect(claimWith(claimAt + secondDelay, code).ok).toBe(false);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("PC-04 every approved session reaches ended by its maximum duration", () => {
    fc.assert(
      fc.property(script, (steps) => {
        const last = run(steps, ({ after }) => {
          const { session } = after;
          if (["approved", "opening", "open"].includes(after.state)) {
            expect(session?.endsAt).toBeDefined();
            expect((session?.endsAt as number) - (session?.approvedAt as number)).toBeLessThanOrEqual(
              MAX_MINUTES * 60_000,
            );
            expect(nextDeadline(after, CFG)).toBe(session?.endsAt);
          }
        });
        if (["approved", "opening", "open"].includes(last.state)) {
          const step = transition(last, { e: "timer", now: last.session?.endsAt as number }, CFG);
          expect(step.ok && step.next.state).toBe("ended");
        }
      }),
      RUNS,
    );
  });

  it("every state that is not waiting, ended or closed has a deadline", () => {
    fc.assert(
      fc.property(script, (steps) => {
        run(steps, ({ after }) => {
          if (!["waiting", "ended", "closed"].includes(after.state)) expect(nextDeadline(after, CFG)).not.toBeNull();
        });
      }),
      RUNS,
    );
  });

  it("no transition leaves an invalid state", () => {
    fc.assert(
      fc.property(script, (steps) => {
        run(steps, ({ after }) => expect(violations(after)).toEqual([]));
      }),
      { numRuns: 600 },
    );
  });

  it("ended is left only by code.next or the close timer, and closed is terminal", () => {
    fc.assert(
      fc.property(script, (steps) => {
        run(steps, ({ before, after, event, ok }) => {
          if (before.state === "ended" && ok && after.state !== "ended") {
            expect(["code.next", "timer"]).toContain(event.e);
            expect(["waiting", "closed"]).toContain(after.state);
          }
          if (before.state === "closed") expect(ok).toBe(false);
        });
      }),
      RUNS,
    );
  });

  it("an unapproved claim is gone after the claim timeout whatever else happens", () => {
    fc.assert(
      fc.property(script, (steps) => {
        const last = run(steps, () => {});
        if (["claimed", "choosing"].includes(last.state)) {
          const due = (last.pairing?.claimedAt as number) + CFG.claimTimeoutSeconds * 1000;
          const step = transition(last, { e: "timer", now: due }, CFG);
          expect(step.ok && step.next.state).toBe("waiting");
        }
      }),
      RUNS,
    );
  });
});
