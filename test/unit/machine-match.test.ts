// The live pick (PAIR-14, ADR 0015): the machine's match event and gate, and drawChoices.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ERRORS } from "../../public/js/shared/errors.js";
import { APP_ERRORS } from "../../public/js/shared/errors-app.js";
import { type Event, type Machine, transition } from "../../src/worker/machine.ts";
import { drawChoices } from "../../src/worker/seams/pairing.ts";
import { asItem, CFG, DECK, fx, MAX_MINUTES, must, sec, T0, waiting } from "./machine-helpers.ts";

const CHOICES = ["17", "42", "85"];

function liveClaim(kind: "owner" | "guest" = "owner", choices: string[] | null = CHOICES): Machine {
  return must(waiting("live"), {
    e: "claim",
    now: T0 + sec(1),
    code: "AAAAAA",
    sessionId: "s1",
    secretHash: "hash",
    match: "42",
    kind,
    userId: kind === "owner" ? "u1" : null,
    passHash: null,
    choices,
  }).next;
}
const pick = (m: Machine, choice: string, now = T0 + sec(2)) => transition(m, { e: "match", now, choice }, CFG);
const refused = (m: Machine, ev: Event) => {
  const step = transition(m, ev, CFG);
  return step.ok ? null : step.error;
};
const lib = asItem({ source: "library", ref: "AAAAAAAAAAAAAAAAAAAAAA:1", name: "Talk.pptx", type: "pptx" });

describe("PAIR-14 match: the phone picks the number on the screen", () => {
  it("PAIR-14 match: a live claim stores the choices unconfirmed; a demo claim needs no pick", () => {
    expect(liveClaim().pairing).toMatchObject({ confirmed: false, choices: CHOICES, match: "42" });
    const demo = must(waiting("demo"), {
      e: "claim",
      now: T0 + sec(1),
      code: "AAAAAA",
      sessionId: "s1",
      secretHash: "hash",
      match: "42",
      kind: "owner",
      userId: null,
      passHash: null,
      choices: CHOICES,
    }).next;
    expect(demo.pairing).toMatchObject({ confirmed: true, choices: null });
    const again = pick(demo, "17");
    expect(again.ok && again.next).toBe(demo);
  });

  it("PAIR-14 match: choices that are not three distinct two-digit strings holding the match are refused", () => {
    for (const choices of [
      ["17", "85"],
      ["17", "17", "42"],
      ["17", "85", "99"],
      ["1", "42", "85"],
      ["17", "42", "85", "60"],
    ]) {
      const step = transition(
        waiting("live"),
        {
          e: "claim",
          now: T0 + sec(1),
          code: "AAAAAA",
          sessionId: "s1",
          secretHash: "hash",
          match: "42",
          kind: "owner",
          userId: "u1",
          passHash: null,
          choices,
        },
        CFG,
      );
      expect(step, choices.join(",")).toEqual({ ok: false, error: "bad_request" });
    }
  });

  it("PAIR-14 match: the right pick confirms and pushes both", () => {
    const step = pick(liveClaim(), "42");
    if (!step.ok) throw new Error(step.error);
    expect(step.next.pairing?.confirmed).toBe(true);
    expect(step.effects).toEqual([{ fx: "push", to: "both" }]);
  });

  it("PAIR-14 match: a wrong pick drops to waiting, codes wiped, audited canceled with cause match_wrong", () => {
    const step = pick(liveClaim(), "17");
    if (!step.ok) throw new Error(step.error);
    expect(step.next.state).toBe("waiting");
    expect(step.next.pairing).toBeNull();
    expect(step.next.codes).toEqual({ current: null, previous: null });
    expect(step.next.endReason).toBe("canceled");
    expect(fx(step.effects, "audit")).toEqual([
      { fx: "audit", type: "canceled", actor: "phone", cause: "match_wrong" },
    ]);
    expect(fx(step.effects, "directory.remove")).toEqual([{ fx: "directory.remove", code: "AAAAAA" }]);
  });

  it("PAIR-14 match: one pick per claim; a second, right or wrong, changes nothing", () => {
    const confirmed = must(liveClaim(), { e: "match", now: T0 + sec(2), choice: "42" }).next;
    for (const choice of ["42", "17", "99"]) {
      const again = pick(confirmed, choice, T0 + sec(3));
      expect(again.ok && again.next, choice).toBe(confirmed);
    }
  });

  it("PAIR-14 match: outside claimed and choosing it is wrong_state", () => {
    expect(refused(waiting("live"), { e: "match", now: T0, choice: "42" })).toBe("wrong_state");
  });
});

describe("PAIR-14 gate: a live pairing acts only after the pick", () => {
  const now = T0 + sec(5);
  it("PAIR-14 gate: listed, approve and upload.start before the pick are match_required, and work after it", () => {
    const owner = liveClaim();
    expect(refused(owner, { e: "listed", now, ids: [DECK.ref] })).toBe("match_required");
    expect(refused(owner, { e: "approve", now, items: [lib], minutes: MAX_MINUTES })).toBe("match_required");
    expect(refused(liveClaim("guest"), { e: "upload.start", now, timeoutSeconds: 900 })).toBe("match_required");
    expect(refused(owner, { e: "upload.start", now, timeoutSeconds: 900 })).toBe("match_required");
    const confirmed = must(owner, { e: "match", now, choice: "42" }).next;
    expect(must(confirmed, { e: "listed", now, ids: [DECK.ref] }).next.state).toBe("choosing");
    expect(must(confirmed, { e: "approve", now, items: [lib], minutes: MAX_MINUTES }).next.state).toBe("approved");
    const guest = must(liveClaim("guest"), { e: "match", now, choice: "42" }).next;
    expect(must(guest, { e: "upload.start", now, timeoutSeconds: 900 }).next.state).toBe("uploading");
  });

  it("PAIR-14 gate: a pairing stored before the pick existed counts as confirmed", () => {
    const owner = liveClaim();
    const old = { ...owner, pairing: owner.pairing && { ...owner.pairing, confirmed: undefined } } as Machine;
    expect(must(old, { e: "listed", now, ids: [DECK.ref] }).next.state).toBe("choosing");
  });

  it("PAIR-14 match: every live claim carries the choices; one without them is refused and spends no code", () => {
    for (const kind of ["owner", "guest"] as const) {
      const m = waiting("live");
      const claim: Event = {
        e: "claim",
        now: T0 + sec(1),
        code: "AAAAAA",
        sessionId: "s1",
        secretHash: "hash",
        match: "42",
        kind,
        userId: null,
        passHash: null,
      };
      expect(refused(m, claim), kind).toBe("bad_request");
      expect(refused(m, { ...claim, choices: null }), kind).toBe("bad_request");
      expect(m.codes.current?.consumed).toBe(false);
      expect(liveClaim(kind).pairing?.confirmed).toBe(false);
    }
  });
});

describe("PAIR-14 codes", () => {
  it("PAIR-14 codes: the pick's codes are phone-only AppErrors, never in the ERRORS table the screen bundle carries", () => {
    for (const code of ["match_required", "match_wrong"] as const) {
      expect(Object.hasOwn(ERRORS, code), code).toBe(false);
      expect(APP_ERRORS[code].status, code).toBe(409);
    }
  });
});

describe("PAIR-14 drawChoices", () => {
  const seeded = (seed: number) => {
    let s = seed >>> 0 || 1;
    return (n: number) => {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      return Math.floor((s / 2 ** 32) * n);
    };
  };

  it("PAIR-14 drawChoices: for every match, three distinct choices, the match among them, decoys far from it", () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const rand = seeded(seed);
        for (let n = 0; n < 100; n++) {
          const match = String(n).padStart(2, "0");
          const choices = drawChoices(match, rand);
          expect(choices).toHaveLength(3);
          expect(new Set(choices).size).toBe(3);
          expect(choices).toContain(match);
          for (const d of choices.filter((c) => c !== match)) {
            expect(d).toMatch(/^\d{2}$/);
            expect(d[0]).not.toBe(match[0]);
            expect(d[1]).not.toBe(match[1]);
            expect(d).not.toBe(`${match[1]}${match[0]}`);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("PAIR-14 drawChoices: a match that is not two digits is refused", () => {
    for (const match of ["", "4", "420", "4a", " 4"])
      expect(() => drawChoices(match, () => 0), match).toThrow(RangeError);
  });

  it("PAIR-14 drawChoices: the match sits in each position about a third of the time (chi-square)", () => {
    const rand = seeded(7);
    const draws = 10_000;
    for (const match of ["00", "42", "99"]) {
      const counts = [0, 0, 0];
      for (let i = 0; i < draws; i++) {
        const at = drawChoices(match, rand).indexOf(match);
        counts[at] = (counts[at] ?? 0) + 1;
      }
      const expected = draws / 3;
      const chi = counts.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
      // 2 degrees of freedom: 13.8 is the 0.999 quantile.
      expect(chi, `${match}: ${counts.join(",")}`).toBeLessThan(13.8);
    }
  });
});
