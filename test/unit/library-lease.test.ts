import { describe, expect, it } from "vitest";
import { leaseTakenAt } from "../../src/worker/library/export.ts";

const NOW = 10 * 86_400_000;
const DAY = 86_400_000;

describe("an export resume lease", () => {
  it("names the snapshot moment while it is within the last day", () => {
    expect(leaseTakenAt(String(NOW), NOW)).toBe(NOW);
    expect(leaseTakenAt(String(NOW - DAY + 1), NOW)).toBe(NOW - DAY + 1);
  });

  it("is stale at exactly a day and after, and the legacy value 1 is stale", () => {
    expect(leaseTakenAt(String(NOW - DAY), NOW)).toBeNull();
    expect(leaseTakenAt(String(NOW - 2 * DAY), NOW)).toBeNull();
    expect(leaseTakenAt("1", NOW)).toBeNull();
  });

  it("is not a moment when it is from the future, empty, absent or not plain digits", () => {
    for (const answer of [String(NOW + 1), "", null, undefined, "1e12", "0x10", " 5", "-5", "12.5", "9".repeat(17)]) {
      expect(leaseTakenAt(answer, NOW), String(answer)).toBeNull();
    }
  });
});
