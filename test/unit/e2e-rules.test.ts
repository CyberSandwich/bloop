// Rules for the e2e specs that a reading can hold (they run in CI only).
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("../e2e/", import.meta.url);
const specs = readdirSync(dir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ f, text: readFileSync(new URL(f, dir), "utf8") }));

describe("e2e specs", () => {
  it("never claim no toast with a retrying toHaveCount(0): a toast leaves by itself, so it passes either way", () => {
    // A tap that dismisses one waits with toBeHidden; "none came" is expectNoToast, one read.
    const retrying = /(toast\b[^;\n]*|getByRole\("(alert|status)"\)|\balert)\)\.toHaveCount\(0\)/;
    for (const { f, text } of specs) {
      const bad = text.split("\n").filter((line) => retrying.test(line) && !line.trim().startsWith("/"));
      expect(bad, f).toEqual([]);
    }
  });
});
