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

  it("never go back or forward straight after a click or tap: wait for the page it opened first", () => {
    // A click returns before its navigation commits; history read mid-swap fails "not attached to an active page".
    const travel = /\.go(Back|Forward)\(/;
    for (const { f, text } of specs) {
      const lines = text.split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("/"));
      const bad = lines.filter((line, i) => travel.test(line) && /\.(click|tap)\(/.test(lines[i - 1] ?? ""));
      expect(bad, f).toEqual([]);
    }
  });

  it("never read the viewer pill's box straight off a locator: settledPill reads it in one frame, glides done", () => {
    // The pill moves when the stage lays out a new item and glides on a change of place; two boundingBox calls can
    // straddle that move, and one taken mid-glide is scaled.
    // A locator held in a variable or passed to a wrapper slips past this; review keeps those to settledPill.
    const direct = /locator\((["'`])#(controls|dots)\1\)\.boundingBox\(/;
    for (const { f, text } of specs) {
      const bad = text.split("\n").filter((line) => direct.test(line) && !line.trim().startsWith("/"));
      expect(bad, f).toEqual([]);
    }
  });
});
