import { describe, expect, it } from "vitest";
import { MAX_NAME_CHARS, renamed } from "../../src/worker/library/names.ts";

describe("a name's length is counted in code points", () => {
  it("accepts 200 of them even when that is 400 UTF-16 units, and refuses the 201st", () => {
    const stem = "😀".repeat(MAX_NAME_CHARS - ".pdf".length);
    expect(renamed(stem, "pdf")).toBe(`${stem}.pdf`);
    expect(renamed(`${stem}😀`, "pdf")).toBeNull();
  });

  it("the route's UTF-16 cap on the body admits every name this accepts", () => {
    const longest = `${"😀".repeat(MAX_NAME_CHARS - ".pdf".length)}`;
    expect(longest.length).toBeLessThanOrEqual(400);
  });
});
