// The upload engine's pure parts: the fingerprint, the part plan, the pace and the byte units.
import { describe, expect, it, vi } from "vitest";
import { fingerprint, nextConcurrency, PACE, planParts } from "../../public/js/core/upload.js";
import { formatBytes } from "../../public/js/core/upload-format.js";

const MIB = 1024 * 1024;
const bytes = (size: number, fill = 1) => new Uint8Array(size).fill(fill);

describe("fingerprint", () => {
  it("rejects when the name rule cannot be fetched, so the file fails instead of resuming on a wrong name", async () => {
    vi.resetModules();
    vi.doMock("../../public/js/shared/file-name.js", () => {
      throw new Error("offline");
    });
    try {
      const fresh = await import("../../public/js/core/upload.js");
      await expect(fresh.fingerprint(new File([bytes(10)], "a.pdf"))).rejects.toThrow();
    } finally {
      vi.doUnmock("../../public/js/shared/file-name.js");
      vi.resetModules();
    }
  });

  it("is 64 lowercase hex characters, stable for the same file", async () => {
    const a = await fingerprint(new File([bytes(300_000)], "Talk.pptx"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await fingerprint(new File([bytes(300_000)], "Talk.pptx"))).toBe(a);
  });

  it("ignores lastModified: a picker that stamps each copy with the time still resumes", async () => {
    const a = await fingerprint(new File([bytes(1000)], "Talk.pptx", { lastModified: 1 }));
    const b = await fingerprint(new File([bytes(1000)], "Talk.pptx", { lastModified: 2_000_000_000_000 }));
    expect(a).toBe(b);
  });

  it("changes with the name, the size, and the first and last bytes", async () => {
    const base = await fingerprint(new File([bytes(300_000)], "Talk.pptx"));
    expect(await fingerprint(new File([bytes(300_000)], "Other.pptx"))).not.toBe(base);
    expect(await fingerprint(new File([bytes(300_001)], "Talk.pptx"))).not.toBe(base);
    const first = bytes(300_000);
    first[0] = 9;
    expect(await fingerprint(new File([first], "Talk.pptx"))).not.toBe(base);
    const last = bytes(300_000);
    last[299_999] = 9;
    expect(await fingerprint(new File([last], "Talk.pptx"))).not.toBe(base);
  });

  it("names the file as the server keeps it: the same cleaned name is the same file", async () => {
    const a = await fingerprint(new File([bytes(100)], "Caf\u00e9  Menu.pdf"));
    expect(await fingerprint(new File([bytes(100)], "Cafe\u0301 Menu.pdf"))).toBe(a);
    expect(await fingerprint(new File([bytes(100)], "Caf\u00e9 Menu.pdf"))).toBe(a);
  });

  it("reads the first and the last 64 KiB and nothing else, even of a huge file", async () => {
    const read: [number, number][] = [];
    const file = {
      name: "Big.pptx",
      size: 450 * MIB,
      slice: (start: number, end: number) => {
        read.push([start, end]);
        return new Blob([new ArrayBuffer(end - start)]);
      },
    };
    await fingerprint(file);
    expect(read).toEqual([
      [0, 65_536],
      [450 * MIB - 65_536, 450 * MIB],
    ]);
  });

  it("works for a file smaller than one sample, and an empty one", async () => {
    expect(await fingerprint(new File([bytes(10)], "a.txt"))).toMatch(/^[0-9a-f]{64}$/);
    expect(await fingerprint(new File([], "a.txt"))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("planParts", () => {
  it("makes one part of a 3 MB file, and 30 of a 500 MB file with a remainder last", () => {
    expect(planParts(3 * MIB, 16 * MIB)).toEqual([[0, 3 * MIB]]);
    const big = planParts(500_000_000, 16 * MIB);
    expect(big).toHaveLength(30);
    expect(big[0]).toEqual([0, 16 * MIB]);
    expect(big[29]).toEqual([29 * 16 * MIB, 500_000_000]);
    expect(big.reduce((sum, [s, e]) => sum + e - s, 0)).toBe(500_000_000);
  });

  it("ends exactly at the file when it is a whole number of parts", () => {
    expect(planParts(40, 20)).toEqual([
      [0, 20],
      [20, 40],
    ]);
  });
});

describe("nextConcurrency", () => {
  const ok = (ms: number) => ({ ok: true, ms });
  it("starts at 2 and gains one after two parts in a row finish under 10 s, up to 4", () => {
    let pace = PACE;
    expect(pace.limit).toBe(2);
    pace = nextConcurrency(pace, ok(9_999));
    expect(pace.limit).toBe(2);
    pace = nextConcurrency(pace, ok(9_999));
    expect(pace.limit).toBe(3);
    pace = nextConcurrency(nextConcurrency(pace, ok(1)), ok(1));
    expect(pace.limit).toBe(4);
    pace = nextConcurrency(nextConcurrency(pace, ok(1)), ok(1));
    expect(pace.limit).toBe(4);
  });

  it("a slow part resets the run of fast ones", () => {
    let pace = nextConcurrency(PACE, ok(1));
    pace = nextConcurrency(pace, ok(10_000));
    pace = nextConcurrency(pace, ok(1));
    expect(pace.limit).toBe(2);
  });

  it("drops to 1 after any failure, then climbs again", () => {
    let pace = nextConcurrency(nextConcurrency(PACE, ok(1)), ok(1));
    expect(pace.limit).toBe(3);
    pace = nextConcurrency(pace, { ok: false, ms: 0 });
    expect(pace.limit).toBe(1);
    pace = nextConcurrency(nextConcurrency(pace, ok(1)), ok(1));
    expect(pace.limit).toBe(2);
  });
});

describe("formatBytes", () => {
  it("counts both numbers in the total's unit: whole above 10, one decimal under", () => {
    expect(formatBytes(34 * MIB, 88 * MIB)).toBe("34 of 88 MB");
    expect(formatBytes(3.4 * MIB, 8.8 * MIB)).toBe("3.4 of 8.8 MB");
    expect(formatBytes(0, 8.8 * MIB)).toBe("0.0 of 8.8 MB");
  });

  it("reads a file under 1 MB in KB, whole", () => {
    expect(formatBytes(340 * 1024, 900 * 1024)).toBe("340 of 900 KB");
    expect(formatBytes(10, 500)).toBe("0 of 1 KB");
  });

  it("reads a batch over 1 GB in GB", () => {
    expect(formatBytes(512 * MIB, 1.5 * 1024 * MIB)).toBe("0.5 of 1.5 GB");
    expect(formatBytes(20 * 1024 * MIB, 30 * 1024 * MIB)).toBe("20 of 30 GB");
  });

  it("rounds the sent share down and the total to nearest, so a share never reads ahead of the bytes", () => {
    expect(formatBytes(87.9 * MIB, 87.6 * MIB)).toBe("87 of 88 MB");
    expect(formatBytes(3.49 * MIB, 8.76 * MIB)).toBe("3.4 of 8.8 MB");
  });
});
