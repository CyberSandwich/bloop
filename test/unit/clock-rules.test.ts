import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("./", import.meta.url));

describe("unit tests that decide an outcome by a deadline", () => {
  it("never set one a few ms after the real clock: a loaded runner outruns it, so inject the clock", () => {
    // A real-time gap decides which of two causes wins; a clock the test owns does not. A constant is read as a gap
    // too (a SCREAMING_CASE name), except where vi.setSystemTime owns the clock. Known gap: a sum split across lines
    // (`const t = Date.now(); ... t + 40`) is not seen. A line that is safe on purpose says `clock-rules: ok`.
    const short = /\b(?:Date|performance)\.now\(\)\s*\+\s*(?:\d{1,3}\b(?!\s*\*)|[A-Z][A-Z0-9_]*\b(?!\s*[(*.]))/;
    const files = readdirSync(DIR, { recursive: true, encoding: "utf8" }).filter(
      (f) => f.endsWith(".test.ts") && f !== "clock-rules.test.ts",
    );
    const bad = files.flatMap((f) =>
      readFileSync(`${DIR}${f}`, "utf8")
        .split("\n")
        .map((line, i) => ({ at: `${f}:${i + 1}`, line }))
        .filter(
          ({ line }) =>
            short.test(line) && !/setSystemTime|clock-rules: ok/.test(line) && !line.trim().startsWith("//"),
        )
        .map(({ at }) => at),
    );
    expect(bad).toEqual([]);
  });
});
