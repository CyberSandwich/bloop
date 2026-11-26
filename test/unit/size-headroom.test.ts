// tools/size-headroom.mjs: the local size check says so when a CSS budget is within reach of CI's different gzip.
import { describe, expect, it } from "vitest";
import { MARGIN, tightCss } from "../../tools/size-headroom.mjs";

describe("a CSS entry near its limit is flagged, because CI's zlib can measure about 20 bytes more", () => {
  const entry = (name: string, size: number, sizeLimit = 6150) => ({ name, size, sizeLimit });

  it("warns for a CSS entry within the margin, and only for CSS", () => {
    const lines = tightCss([
      entry("site page CSS", 6137),
      entry("app page CSS", 7000, 7100),
      entry("font", 54990, 55000),
      entry("hero image", 157499, 157500),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("site page CSS: 6137 of 6150");
    expect(lines[0]).toContain("CI decides");
  });

  it("is quiet at exactly the margin, and warns one byte inside it", () => {
    expect(tightCss([entry("legal page CSS", 6150 - MARGIN)])).toEqual([]);
    expect(tightCss([entry("legal page CSS", 6150 - MARGIN + 1)])).toHaveLength(1);
  });

  it("warns for an entry already over its limit", () => {
    expect(tightCss([entry("site page CSS", 6163)])).toHaveLength(1);
  });
});
