import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canSet,
  clampLength,
  cutShort,
  fitPresets,
  MIN_LENGTH_SECONDS,
  secondsUntil,
} from "../../public/js/shared/length.js";
import { type Event, type Machine, nextDeadline, transition } from "../../src/worker/machine.ts";
import {
  approved,
  asItem,
  CFG,
  claimedOwner,
  DECK,
  ended,
  fx,
  MAX_MINUTES,
  must,
  offered,
  sec,
  T0,
  waiting,
} from "./machine-helpers.ts";

const MIN = 60_000;
const APPROVED_AT = T0 + sec(10);
const length = (now: number, minutes: number, maxMinutes = MAX_MINUTES): Event => ({
  e: "length",
  now,
  seconds: minutes * 60,
  maxMinutes,
});
const refused = (m: Machine, ev: Event) => {
  const step = transition(m, ev, CFG);
  return step.ok ? null : step.error;
};

describe("SESS-01 length: the phone sets when the session ends", () => {
  it("starts at the length approval gave it", () => {
    const { next } = must(claimedOwner(), { e: "approve", now: APPROVED_AT, items: [asItem(DECK)], minutes: 60 });
    expect(next.session?.endsAt).toBe(APPROVED_AT + 60 * MIN);
  });

  it("sets endsAt to now plus the minutes, pushes both and moves the alarm, in approved, opening and open", () => {
    const at = APPROVED_AT + 5 * MIN;
    const a = approved();
    const opening = must(a, { e: "launched", now: APPROVED_AT, mode: "protocol" }).next;
    const open = must(opening, { e: "fetched", now: APPROVED_AT }).next;
    for (const m of [a, opening, open]) {
      const { next, effects } = must(m, length(at, 30));
      expect(next.state, m.state).toBe(m.state);
      expect(next.session?.endsAt).toBe(at + 30 * MIN);
      expect(nextDeadline(next, CFG)).toBe(at + 30 * MIN);
      expect(fx(effects, "push")).toEqual([{ fx: "push", to: "both" }]);
      expect(effects).toHaveLength(2);
    }
  });

  it("SESS-01 length: seconds set endsAt to the millisecond, down to the 1 minute floor, and a 1 minute end is audited", () => {
    const at = APPROVED_AT + 5 * MIN;
    const a = approved();
    expect(must(a, { e: "length", now: at, seconds: 60, maxMinutes: MAX_MINUTES }).next.session?.endsAt).toBe(at + MIN);
    const odd = must(a, { e: "length", now: at, seconds: 90, maxMinutes: MAX_MINUTES });
    expect(odd.next.session?.endsAt).toBe(at + 90_000);
    expect(fx(odd.effects, "audit")).toHaveLength(1);
    // The cap still wins over a longer ask, to the millisecond.
    const cap = must(a, { e: "length", now: at, seconds: 3 * 3600, maxMinutes: 120 });
    expect(cap.next.session?.endsAt).toBe(APPROVED_AT + 120 * MIN);
  });

  it("SESS-01 audit: a length change is audited by the phone, and a replay audits nothing", () => {
    const at = APPROVED_AT + MIN;
    const step = must(approved(), length(at, 30));
    expect(fx(step.effects, "audit")).toEqual([{ fx: "audit", type: "session.length", actor: "phone" }]);
    expect(fx(must(step.next, length(at, 30)).effects, "audit")).toEqual([]);
  });

  it("SESS-01 audit: the same choice repeated within a minute moves the end and pushes, but writes no audit row", () => {
    const at = APPROVED_AT + MIN;
    const once = must(approved(), length(at, 30)).next;
    const again = must(once, length(at + sec(20), 30));
    expect(again.next.session?.endsAt).toBe(at + sec(20) + 30 * MIN);
    expect(fx(again.effects, "push")).toEqual([{ fx: "push", to: "both" }]);
    expect(fx(again.effects, "audit")).toEqual([]);
    // A real change of five minutes is audited, and push comes first.
    const moved = must(once, length(at + sec(20), 35));
    expect(moved.effects.map((e) => e.fx)).toEqual(["push", "audit"]);
  });

  it("SESS-01 audit: thirty repeats 59 s apart each move the end under a minute, yet the net drift is audited", () => {
    let m = must(claimedOwner(), { e: "approve", now: APPROVED_AT, items: [asItem(DECK)], minutes: 30 }).next;
    let rows = 0;
    for (let i = 1; i <= 30; i++) {
      const step = must(m, length(APPROVED_AT + i * sec(59), 30));
      rows += fx(step.effects, "audit").length;
      m = step.next;
    }
    // The first repeat is 59 s from the approved end (unlogged); the second is 118 s from it (logged), and so on.
    expect(rows).toBe(15);
  });

  it("SESS-01 audit: a 30 then a 29 within 20 s is audited when the net move since the last audit is a minute", () => {
    const approvedFor31 = must(claimedOwner(), {
      e: "approve",
      now: APPROVED_AT,
      items: [asItem(DECK)],
      minutes: 31,
    }).next;
    expect(approvedFor31.session && "auditedEndsAt" in approvedFor31.session).toBe(false);
    const first = must(approvedFor31, length(APPROVED_AT + sec(5), 30));
    expect(fx(first.effects, "audit")).toEqual([]);
    const second = must(first.next, length(APPROVED_AT + sec(15), 29));
    expect(fx(second.effects, "audit")).toHaveLength(1);
    expect(second.next.session?.auditedEndsAt).toBe(second.next.session?.endsAt);
  });

  it("shortens as well as lengthens", () => {
    const a = approved();
    const at = APPROVED_AT + MIN;
    expect(must(a, length(at, 5)).next.session?.endsAt).toBe(at + 5 * MIN);
    expect(must(a, length(at, 80)).next.session?.endsAt).toBe(at + 80 * MIN);
  });

  it("is absolute: a replay at the same instant changes nothing and pushes nothing, a later one never adds up", () => {
    const at = APPROVED_AT + MIN;
    const once = must(approved(), length(at, 30)).next;
    const replay = must(once, length(at, 30));
    expect(replay.next).toBe(once);
    expect(replay.effects).toEqual([]);
    const late = must(once, length(at + sec(20), 30)).next;
    expect(late.session?.endsAt).toBe(at + sec(20) + 30 * MIN);
  });

  it("never ends later than approval plus the cap, however often the phone asks", () => {
    const cap = APPROVED_AT + MAX_MINUTES * MIN;
    let m = approved();
    for (const at of [APPROVED_AT + MIN, APPROVED_AT + 50 * MIN, APPROVED_AT + 89 * MIN]) {
      m = must(m, length(at, MAX_MINUTES)).next;
      expect(m.session?.endsAt).toBe(cap);
    }
  });

  it("clamps to the cap the event carries, so a demo session stops at the demo cap", () => {
    const at = APPROVED_AT + MIN;
    expect(must(approved(), length(at, 720, 120)).next.session?.endsAt).toBe(APPROVED_AT + 120 * MIN);
  });

  it("is wrong_state before approval, after the end and in waiting, and leaves those machines alone", () => {
    const at = T0 + sec(30);
    for (const m of [waiting(), claimedOwner(), offered(), ended()]) {
      expect(refused(m, length(at, 30)), m.state).toBe("wrong_state");
    }
  });

  it("the timer ends the session at the new endsAt, not the old one", () => {
    const at = APPROVED_AT + MIN;
    const m = must(approved(), length(at, 5)).next;
    expect(must(m, { e: "timer", now: at + 5 * MIN - 1 }).next).toBe(m);
    const { next } = must(m, { e: "timer", now: at + 5 * MIN });
    expect(next.state).toBe("ended");
    expect(next.endReason).toBe("auto");
  });

  it("past endsAt (a late alarm) ends the session as the timer would, never brings it back", () => {
    const late = must(approved(), length(APPROVED_AT, 5)).next;
    const endsAt = late.session?.endsAt ?? 0;
    for (const now of [endsAt, endsAt + sec(20)]) {
      const { next, effects } = must(late, length(now, 60));
      expect(next.state).toBe("ended");
      expect(next.endReason).toBe("auto");
      expect(fx(effects, "push")).not.toEqual([]);
    }
    // A moment before the end still sets it.
    expect(must(late, length(endsAt - 1, 60)).next.session?.endsAt).toBe(endsAt - 1 + 60 * MIN);
  });

  it("a guest session's Open click starts at the length given, like an approval", () => {
    const at = T0 + sec(40);
    const open = must(offered(), { e: "open.click", now: at, minutes: 60 }).next;
    expect(open.session?.endsAt).toBe(at + 60 * MIN);
    expect(must(open, length(at + MIN, 30)).next.session?.endsAt).toBe(at + 31 * MIN);
  });
});

describe("SESS-01 sheet: presets above the cap", () => {
  const preset = (minutes: number) => ({ dataset: { minutes: String(minutes) }, hidden: false });
  const bubble = (...minutes: number[]) => {
    const chips = minutes.map(preset);
    return { chips, hidden: false, querySelectorAll: () => chips } as {
      chips: typeof chips;
      hidden: boolean;
      querySelectorAll: () => typeof chips;
    };
  };

  it("hides each preset above the mode's cap and keeps the rest", () => {
    const b = bubble(30, 60, 120);
    fitPresets(b, 60);
    expect(b.chips.map((c) => c.hidden)).toEqual([false, false, true]);
    expect(b.hidden).toBe(false);
  });

  it("leaves a missing bubble alone", () => {
    expect(() => fitPresets(null, 60)).not.toThrow();
  });

  it("hides the whole bubble when no preset fits, and shows all under a roomy cap", () => {
    const none = bubble(30, 60, 120);
    fitPresets(none, 20);
    expect(none.hidden).toBe(true);
    const all = bubble(30, 60, 120);
    fitPresets(all, 720);
    expect(all.chips.some((c) => c.hidden) || all.hidden).toBe(false);
  });
});

describe("SESS-01 sheet: Until and the clamp on the phone", () => {
  const at = (h: number, m: number, s = 0) => new Date(2026, 10, 25, h, m, s);

  it("counts whole seconds to the next HH:MM:00, unrounded", () => {
    expect(secondsUntil("15:30", at(14, 0))).toBe(90 * 60);
    expect(secondsUntil("14:05", at(14, 0, 40))).toBe(4 * 60 + 20);
    expect(secondsUntil("14:02", at(14, 0, 30))).toBe(90);
  });

  it("takes a time not ahead as tomorrow's: the current minute and one just past are about a day away, never shortened", () => {
    expect(secondsUntil("14:00", at(14, 0))).toBe(24 * 3600);
    expect(secondsUntil("14:00", at(14, 0, 20))).toBe(24 * 3600 - 20);
    expect(secondsUntil("13:55", at(14, 0))).toBe(24 * 3600 - 5 * 60);
    expect(secondsUntil("12:59", at(14, 0))).toBe(23 * 3600 - 60);
  });

  it("Set is enabled from exactly 60 s ahead to the room the server leaves, and disabled outside it", () => {
    const room = 7200;
    expect(canSet("14:01", room, at(14, 0))).toBe(true);
    expect(canSet("14:01", room, at(14, 0, 1))).toBe(false);
    expect(canSet("14:02", room, at(14, 0, 1))).toBe(true);
    expect(canSet("14:00", room, at(14, 0, 30))).toBe(false);
    expect(canSet("13:59", room, at(14, 0))).toBe(false);
    expect(canSet("16:00", room, at(14, 0))).toBe(true);
    expect(canSet("16:01", room, at(14, 0))).toBe(false);
    expect(canSet("", room, at(14, 0))).toBe(false);
  });

  it("SESS-01 sheet: late in a session the room is what is left to approval plus the cap, not the cap from now", () => {
    // 11 h into a 12 h session: 3600 s of room, so 5 h ahead is refused though it is within 12 h of now.
    expect(canSet("19:00", 3600, at(14, 0))).toBe(false);
    expect(canSet("14:59", 3600, at(14, 0))).toBe(true);
    expect(canSet("15:01", 3600, at(14, 0))).toBe(false);
  });

  it("23:30 to 00:30 crosses midnight: 3600 s", () => {
    expect(secondsUntil("00:30", at(23, 30))).toBe(3600);
    expect(canSet("00:30", 7200, at(23, 30))).toBe(true);
  });

  describe("the hour a clock change repeats (Europe/London, 25 October 2026: 01:00 to 02:00 happens twice)", () => {
    const tz = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = "Europe/London";
    });
    afterAll(() => {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    });

    it("a time whose first instant has passed is still ahead at its second", () => {
      // 01:30 the second time round; 01:45 is 15 minutes away, not a day.
      expect(secondsUntil("01:45", new Date("2026-10-25T01:30:00Z"))).toBe(15 * 60);
    });

    it("takes the first instant still in the future", () => {
      // 00:30 UTC is 01:30 BST, the first time round; 01:45 is 15 minutes away, at its first instant.
      expect(secondsUntil("01:45", new Date("2026-10-25T00:30:00Z"))).toBe(15 * 60);
      // 01:15 has passed once; its second instant, an hour on, is still ahead.
      expect(secondsUntil("01:15", new Date("2026-10-25T00:30:00Z"))).toBe(45 * 60);
    });

    it("leaves an ordinary day alone", () => {
      expect(secondsUntil("15:30", new Date("2026-10-26T14:00:00Z"))).toBe(90 * 60);
      expect(secondsUntil("14:00", new Date("2026-10-26T14:00:00Z"))).toBe(24 * 3600);
    });
  });

  it("SESS-01 sheet: an end the server stopped more than a minute short of the ask is reported, a few seconds are not", () => {
    const now = 1_000_000;
    expect(cutShort(now + 6 * 3600_000, now, 6 * 3600)).toBe(false);
    expect(cutShort(now + 6 * 3600_000 - 30_000, now, 6 * 3600)).toBe(false);
    expect(cutShort(now + 2 * 3600_000, now, 6 * 3600)).toBe(true);
  });

  it("keeps a preset inside the minimum and the mode's cap, as the route takes it", () => {
    expect(MIN_LENGTH_SECONDS).toBe(60);
    expect(clampLength(1, 7200)).toBe(60);
    expect(clampLength(5400, 7200)).toBe(5400);
    expect(clampLength(23 * 3600, 7200)).toBe(7200);
    expect(clampLength(43_200, 43_200)).toBe(43_200);
  });
});
