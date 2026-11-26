// tools/size-headroom.mjs: the local size check fails over a limit and says so when a CSS budget is within reach of
// CI's different gzip.
import { describe, expect, it } from "vitest";
import { check, MARGIN } from "../../tools/size-headroom.mjs";

describe("a CSS entry near its limit is flagged, because CI's zlib can measure about 20 bytes more", () => {
  const entry = (name: string, size: number, sizeLimit = 6150) => ({
    name,
    size,
    sizeLimit,
    passed: size <= sizeLimit,
  });

  it("warns for a CSS entry within the margin, and only for CSS", () => {
    const { failures, warnings } = check([
      entry("site page CSS", 6137),
      entry("app page CSS", 7000, 7100),
      entry("font", 54990, 55000),
      entry("hero image", 157499, 157500),
    ]);
    expect(failures).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("site page CSS: 6137 of 6150");
    expect(warnings[0]).toContain("CI decides");
  });

  it("is quiet at exactly the margin, and warns one byte inside it", () => {
    expect(check([entry("legal page CSS", 6150 - MARGIN)]).warnings).toEqual([]);
    expect(check([entry("legal page CSS", 6150 - MARGIN + 1)]).warnings).toHaveLength(1);
  });

  it("an entry over its limit is a failure, not a warning", () => {
    const { failures, warnings } = check([entry("site page CSS", 6163), entry("font", 56000, 55000)]);
    expect(failures).toEqual(["site page CSS: 6163 over 6150 bytes", "font: 56000 over 55000 bytes"]);
    expect(warnings).toEqual([]);
  });
});
