import { describe, expect, it } from "vitest";
import { clampLength, fitPresets, MIN_LENGTH_MINUTES, minutesUntil } from "../../public/js/shared/length.js";
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
  minutes,
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
      expect(effects).toHaveLength(1);
    }
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

  it("counts whole minutes to a later time today", () => {
    expect(minutesUntil("15:30", at(14, 0))).toBe(90);
    expect(minutesUntil("14:05", at(14, 0, 40))).toBe(4);
  });

  it("takes a time over an hour past as tomorrow's", () => {
    expect(minutesUntil("12:59", at(14, 0))).toBe(23 * 60 - 1);
    expect(minutesUntil("13:00", at(14, 0, 1))).toBe(23 * 60);
  });

  it("takes a time within the last hour, the current minute included, as the shortest length, never the cap", () => {
    expect(minutesUntil("14:30", at(14, 30, 20))).toBe(MIN_LENGTH_MINUTES);
    expect(minutesUntil("14:25", at(14, 30))).toBe(MIN_LENGTH_MINUTES);
    expect(minutesUntil("13:01", at(14, 0))).toBe(MIN_LENGTH_MINUTES);
    expect(minutesUntil("14:00", at(14, 0))).toBe(MIN_LENGTH_MINUTES);
  });

  it("keeps a length inside the minimum and the mode's cap, as the route takes it", () => {
    expect(MIN_LENGTH_MINUTES).toBe(5);
    expect(clampLength(1, 120)).toBe(5);
    expect(clampLength(90, 120)).toBe(90);
    expect(clampLength(23 * 60, 120)).toBe(120);
    expect(clampLength(720, 720)).toBe(720);
  });
});
