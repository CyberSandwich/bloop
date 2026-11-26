import { describe, expect, it, vi } from "vitest";
import { validate } from "../../src/worker/seams/guest-drop/validate.ts";
import { reader, validPdf } from "../zip-builder.ts";

const scans = vi.hoisted(() => ({ running: 0, peak: 0, failNext: false }));

vi.mock("../../src/worker/seams/guest-drop/pdf-scan.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/worker/seams/guest-drop/pdf-scan.ts")>();
  return {
    ...real,
    scanPdfChunks: async (...args: Parameters<typeof real.scanPdfChunks>) => {
      scans.running++;
      scans.peak = Math.max(scans.peak, scans.running);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (scans.failNext) {
          scans.failNext = false;
          throw new Error("scan broke");
        }
        return await real.scanPdfChunks(...args);
      } finally {
        scans.running--;
      }
    },
  };
});

describe("one whole-file PDF scan per isolate at a time (memory)", () => {
  it("runs concurrent whole-file scans one after another (two 16 MiB scans at once)", async () => {
    scans.peak = 0;
    const verdicts = await Promise.all(Array.from({ length: 4 }, () => validate(reader(validPdf()), "pdf")));
    expect(verdicts).toEqual(Array.from({ length: 4 }, () => ({ ok: true, type: "pdf" })));
    expect(scans.peak).toBe(1);
  });

  it("lets the next scan run when one throws", async () => {
    scans.failNext = true;
    const [broken, next] = await Promise.allSettled([
      validate(reader(validPdf()), "pdf"),
      validate(reader(validPdf()), "pdf"),
    ]);
    expect(broken).toMatchObject({ status: "rejected" });
    expect(next).toEqual({ status: "fulfilled", value: { ok: true, type: "pdf" } });
  });
});
