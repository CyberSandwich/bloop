import { describe, expect, it } from "vitest";
import { QR_MODULES, qrMatrix, qrPath, qrSize } from "../../public/js/core/qr.js";

describe("QR drawing", () => {
  it("draws a link as a 41 module square, the same size for any code", () => {
    for (const code of ["K7MQ9X", "23456A", "ZZZZZZ"]) {
      const m = qrMatrix(`https://bloop.saputra.co.uk/a?c=${code}`);
      expect(m).toHaveLength(QR_MODULES);
      expect(m.every((row) => row.length === QR_MODULES)).toBe(true);
    }
  });

  it("keeps a 4 module quiet zone on every side", () => {
    const m = qrMatrix("http://127.0.0.1:8787/a?c=K7MQ9X");
    for (let i = 0; i < 4; i++) {
      expect(m[i]?.some(Boolean)).toBe(false);
      expect(m[QR_MODULES - 1 - i]?.some(Boolean)).toBe(false);
      expect(m.some((row) => row[i] || row[QR_MODULES - 1 - i])).toBe(false);
    }
    expect(m[4]?.[4]).toBe(true); // the finder pattern's corner
  });

  it("merges horizontal runs into one path", () => {
    const m = [
      [true, true, false, true],
      [false, false, false, false],
      [false, true, true, true],
    ];
    expect(qrPath(m)).toBe("M0 0h2v1h-2zM3 0h1v1h-1zM1 2h3v1h-3z");
  });

  it("the path covers exactly the dark modules", () => {
    const m = qrMatrix("http://127.0.0.1:8787/a?c=K7MQ9X");
    const dark = m.flat().filter(Boolean).length;
    const covered = [...qrPath(m).matchAll(/h(\d+)v1/g)].reduce((sum, r) => sum + Number(r[1]), 0);
    expect(covered).toBe(dark);
  });

  it("sizes whole device pixels per module to half the viewport height", () => {
    // 1080p: 13 device px per module, 533 px (design.md section 10)
    expect(qrSize(1080, 1)).toBe(533);
    // 1366 x 768: 9 px, 369 px
    expect(qrSize(768, 1)).toBe(369);
    // a 2x display: whole device pixels, so a half-pixel CSS size is fine
    expect(qrSize(900, 2)).toBe((Math.floor((0.5 * 900 * 2) / 41) * 41) / 2);
  });

  it("never goes below 2 device pixels per module", () => {
    expect(qrSize(100, 1)).toBe(82);
  });
});
