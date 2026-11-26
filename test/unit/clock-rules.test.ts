import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("./", import.meta.url));

describe("unit tests that decide an outcome by a deadline", () => {
  it("never set one a few ms after the real clock: a loaded runner outruns it, so inject the clock", () => {
    // `x = Date.now() + 40` leaves a real-time gap that decides which of two causes wins; a clock the test owns does not.
    const short = /\b(?:Date|performance)\.now\(\)\s*\+\s*\d{1,2}\b(?!\s*\*|\s*_)/;
    const bad = readdirSync(DIR)
      .filter((f) => f.endsWith(".test.ts") && f !== "clock-rules.test.ts")
      .flatMap((f) =>
        readFileSync(`${DIR}${f}`, "utf8")
          .split("\n")
          .map((line, i) => ({ at: `${f}:${i + 1}`, line }))
          .filter(({ line }) => short.test(line) && !line.trim().startsWith("//")),
      )
      .map(({ at }) => at);
    expect(bad).toEqual([]);
  });
});
