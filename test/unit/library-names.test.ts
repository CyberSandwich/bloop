import { describe, expect, it } from "vitest";
import { isValidName, NAME_MAX } from "../../src/shared/name-rule.ts";
import { renamed } from "../../src/worker/library/names.ts";

describe("a name's length is counted in code points (src/shared/name-rule.ts)", () => {
  it("accepts 200 of them even when that is 400 UTF-16 units, and refuses the 201st", () => {
    const stem = "😀".repeat(NAME_MAX - ".pdf".length);
    expect(renamed(stem, "pdf")).toBe(`${stem}.pdf`);
    expect(renamed(`${stem}😀`, "pdf")).toBeNull();
  });

  it("a name of exactly 200 code points of emoji passes and 201 fails, with no extension in the way", () => {
    expect(isValidName("😀".repeat(NAME_MAX))).toBe(true);
    expect(isValidName("😀".repeat(NAME_MAX + 1))).toBe(false);
  });

  it("refuses an empty name, a control, a bidi override, a slash and a lone surrogate", () => {
    for (const bad of ["", "a\u0000b", "a‮b", "a/b", "a\\b", "a\ud800b"]) {
      expect(isValidName(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(isValidName("講義 ‍ 😀")).toBe(true);
  });

  it("the route's UTF-16 cap on the body admits every name this accepts", () => {
    expect("😀".repeat(NAME_MAX).length).toBeLessThanOrEqual(400);
  });
});
