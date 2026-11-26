import { describe, expect, it } from "vitest";
import { NAME_MAX } from "../../public/js/shared/file-name.js";
import { renamed } from "../../src/worker/library/names.ts";

// The rule itself is public/js/shared/file-name.js (test/unit/names.test.ts); a rename is judged by it here.
describe("a rename is judged by the shared file name rule", () => {
  it("accepts 200 code points even when that is 400 UTF-16 units, and refuses the 201st", () => {
    const stem = "😀".repeat(NAME_MAX - ".pdf".length);
    expect(renamed(stem, "pdf")).toBe(`${stem}.pdf`);
    expect(renamed(`${stem}😀`, "pdf")).toBeNull();
  });

  it("refuses an empty base, a control, a bidi override, a slash and a lone surrogate", () => {
    for (const bad of ["", " ", "a\u0000b", "a‮b", "a/b", "a\\b", "a\ud800b"]) {
      expect(renamed(bad, "pdf"), JSON.stringify(bad)).toBeNull();
    }
    expect(renamed("講義 😀", "pdf")).toBe("講義 😀.pdf");
  });

  it("refuses a name the upload path would have cleaned: a doubled space, a tab, a no-break space, a Hangul filler", () => {
    for (const bad of ["a  b", "a\tb", "a\u00a0b", "a\u3164b", "a\u200d b"]) {
      expect(renamed(bad, "pdf"), JSON.stringify(bad)).toBeNull();
    }
  });

  it("accepts a decomposed base, since a rename is normalized to NFC first", () => {
    expect(renamed("e\u0301", "pdf")).toBe("\u00e9.pdf");
  });

  it("the route's UTF-16 cap on the body admits every name this accepts", () => {
    expect("😀".repeat(NAME_MAX).length).toBeLessThanOrEqual(400);
  });
});
