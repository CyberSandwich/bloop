import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DemoSlots } from "../../src/worker/do/demo-slots.ts";
import { sqlOver } from "./sqlite.ts";

function slots(): DemoSlots {
  return new DemoSlots(sqlOver(new DatabaseSync(":memory:")));
}

const T = 1_000_000;
const HOLD = 60_000;

const FAR = 10_000;

describe("F14 DEMO-02 flood: one IP hash cannot fill the cap", () => {
  it("DEMO-02 per-ip: refuses a third concurrent slot for one IP hash and still serves another", () => {
    const s = slots();
    expect(s.reserve("a", "ip1", T, HOLD, FAR, 2)).toBe(true);
    expect(s.reserve("b", "ip1", T, HOLD, FAR, 2)).toBe(true);
    expect(s.reserve("c", "ip1", T, HOLD, FAR, 2)).toBe(false);
    expect(s.reserve("d", "ip2", T, HOLD, FAR, 2)).toBe(true);
  });

  it("DEMO-02 per-ip: a release or a lapsed hold gives the IP its slot back, and a renewal does not count twice", () => {
    const s = slots();
    s.reserve("a", "ip1", T, HOLD, FAR, 1);
    expect(s.reserve("a", "ip1", T + 1, HOLD, FAR, 1)).toBe(true);
    expect(s.reserve("b", "ip1", T + 2, HOLD, FAR, 1)).toBe(false);
    s.release("a");
    expect(s.reserve("b", "ip1", T + 3, HOLD, FAR, 1)).toBe(true);
    expect(s.reserve("c", "ip1", T + 3 + HOLD, HOLD, FAR, 1)).toBe(true);
  });
});

describe("DEMO-02 flood: the global cap on concurrent demo sessions", () => {
  it("DEMO-02 cap: takes slots up to the cap and refuses the next one", () => {
    const s = slots();
    expect(s.reserve("a", "ip-a", T, HOLD, 2, FAR)).toBe(true);
    expect(s.reserve("b", "ip-b", T, HOLD, 2, FAR)).toBe(true);
    expect(s.reserve("c", "ip-c", T, HOLD, 2, FAR)).toBe(false);
    expect(s.count()).toBe(2);
  });

  it("DEMO-02 cap: a released slot is free again at once", () => {
    const s = slots();
    s.reserve("a", "ip-a", T, HOLD, 1, FAR);
    expect(s.reserve("b", "ip-b", T, HOLD, 1, FAR)).toBe(false);
    s.release("a");
    expect(s.reserve("b", "ip-b", T, HOLD, 1, FAR)).toBe(true);
  });

  it("DEMO-02 cap: a lapsed hold frees its slot without a release", () => {
    const s = slots();
    s.reserve("a", "ip-a", T, HOLD, 1, FAR);
    expect(s.reserve("b", "ip-b", T + HOLD - 1, HOLD, 1, FAR)).toBe(false);
    expect(s.reserve("b", "ip-b", T + HOLD, HOLD, 1, FAR)).toBe(true);
    expect(s.count()).toBe(1);
  });

  it("DEMO-02 cap: reserving a held screen again renews it instead of taking a second slot", () => {
    const s = slots();
    s.reserve("a", "ip-a", T, HOLD, 1, FAR);
    expect(s.reserve("a", "ip-a", T + 30_000, HOLD, 1, FAR)).toBe(true);
    expect(s.count()).toBe(1);
    expect(s.reserve("b", "ip-b", T + HOLD, HOLD, 1, FAR)).toBe(false);
  });

  it("DEMO-02 cap: releasing an unknown screen is harmless", () => {
    const s = slots();
    s.release("nope");
    expect(s.count()).toBe(0);
  });
});
