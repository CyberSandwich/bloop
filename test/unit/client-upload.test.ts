// The upload engine's pure parts: the fingerprint, the part plan, the pace, the time left and the byte units.
import { describe, expect, it } from "vitest";
import {
  etaLabel,
  etaLeft,
  etaOf,
  etaStart,
  fingerprint,
  formatBytes,
  nextConcurrency,
  PACE,
  planParts,
} from "../../public/js/core/upload.js";

const MIB = 1024 * 1024;
const bytes = (size: number, fill = 1) => new Uint8Array(size).fill(fill);
const etaLabelAt = (eta: Parameters<typeof etaLeft>[0], now: number) => etaLabel(etaLeft(eta, now) ?? 0);

describe("fingerprint", () => {
  it("is 64 lowercase hex characters, stable for the same file", async () => {
    const a = await fingerprint(new File([bytes(300_000)], "Talk.pptx"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await fingerprint(new File([bytes(300_000)], "Talk.pptx"))).toBe(a);
  });

  it("ignores lastModified: an iOS picker stamps each copy with the current time", async () => {
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

  it("reads 16 samples of 64 KiB at most, the first and last included, and never the middle of a big file whole", async () => {
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
    expect(read).toHaveLength(16);
    expect(read[0]).toEqual([0, 65_536]);
    expect(read[15]).toEqual([450 * MIB - 65_536, 450 * MIB]);
    expect(read.every(([s, e]) => e - s === 65_536)).toBe(true);
    expect(read.map(([s]) => s)).toEqual([...read.map(([s]) => s)].sort((a, b) => a - b));
  });

  it("works for a file smaller than one sample", async () => {
    expect(await fingerprint(new File([bytes(10)], "a.txt"))).toMatch(/^[0-9a-f]{64}$/);
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

describe("the time left", () => {
  /** Steady throughput of `rate` bytes a second, sampled each second for `secs`. */
  function steady(rate: number, secs: number, total: number) {
    let eta = etaStart();
    let now = 1000;
    let loaded = 0;
    eta = etaOf(eta, loaded, total, now);
    for (let i = 0; i < secs; i++) {
      now += 1000;
      loaded += rate;
      eta = etaOf(eta, loaded, total, now);
    }
    return { eta, now, loaded };
  }

  it("UP-10 estimate shows after 5 s of samples, and not before", () => {
    expect(steady(1000, 4, 1_000_000).eta.est).toBeNull();
    const five = steady(1000, 5, 1_000_000);
    expect(five.eta.est).toBeCloseTo(((1_000_000 - 5000) / 1000) * 1000, -1);
  });

  it("UP-10 throughput is an EWMA with 0.2 for the newest second", () => {
    const { eta, now, loaded } = steady(1000, 6, 1_000_000);
    expect(eta.rate).toBeCloseTo(1000, 6);
    // One fast second: 0.2 * 2000 + 0.8 * 1000.
    const next = etaOf(eta, loaded + 2000, 1_000_000, now + 1000);
    expect(next.rate).toBeCloseTo(1200, 6);
  });

  it("UP-10 estimate hysteresis: a change under 20 percent keeps the shown value, 20 percent or more moves it", () => {
    const now = 100_000;
    // Showing 100 s at 1000 B/s; one second on, the shown value has counted down to 99 s.
    const shown = { at: now, bytes: 0, rate: 1000, secs: 10, est: 100_000, estAt: now };
    const at = now + 1000;
    const shownAt = 99_000;
    // Bytes left are chosen so the new estimate is a set share of the shown value, the rate holding at 1000 B/s.
    const feed = (share: number) => etaOf(shown, 1000, 1000 + ((shownAt * share) / 1000) * 1000, at);
    expect(feed(1.19).est).toBe(100_000);
    expect(feed(0.81).est).toBe(100_000);
    expect(feed(1.21).est).toBeCloseTo(shownAt * 1.21, 0);
    expect(feed(0.79).est).toBeCloseTo(shownAt * 0.79, 0);
  });

  it("UP-10 the shown value counts down between changes, so minutes never tick back up", () => {
    const eta = { at: 0, bytes: 0, rate: 1000, secs: 10, est: 600_000, estAt: 0 };
    expect(etaOf(eta, 0, 1, 0).est).toBe(600_000);
    expect(etaLabelAt(eta, 0)).toBe("10 min left");
    expect(etaLabelAt(eta, 125_000)).toBe("8 min left");
    expect(etaLabelAt(eta, 541_000)).toBe("Under a minute left");
  });

  it("UP-10 whole minutes round up, and under a minute reads Under a minute left", () => {
    expect(etaLabel(59_999)).toBe("Under a minute left");
    expect(etaLabel(60_000)).toBe("1 min left");
    expect(etaLabel(60_001)).toBe("2 min left");
    expect(etaLabel(0)).toBe("Under a minute left");
    expect(etaLabel(3_600_000)).toBe("60 min left");
  });

  it("re-anchors after a gap, so waiting does not drag the mean to zero", () => {
    const { eta, now, loaded } = steady(1000, 6, 1_000_000);
    const gap = { ...eta, at: -1 };
    const back = etaOf(gap, loaded, 1_000_000, now + 120_000);
    expect(back.rate).toBeCloseTo(1000, 6);
    expect(etaOf(back, loaded + 1000, 1_000_000, now + 121_000).rate).toBeCloseTo(1000, 6);
  });
});
