import { describe, expect, it, vi } from "vitest";
import { PDF_WINDOW_BYTES } from "../../src/worker/seams/guest-drop/pdf-scan.ts";
import { validate } from "../../src/worker/seams/guest-drop/validate.ts";
import { reader, validPdf } from "../zip-builder.ts";

const scans = vi.hoisted(() => ({ hangNext: false, windows: [] as number[] }));

// The real scan, except that the next one can be made to never settle, and every chunk's size is recorded.
vi.mock("../../src/worker/seams/guest-drop/pdf-scan.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/worker/seams/guest-drop/pdf-scan.ts")>();
  return {
    ...real,
    scanPdfChunks: (next: Parameters<typeof real.scanPdfChunks>[0]) => {
      if (scans.hangNext) {
        scans.hangNext = false;
        return new Promise(() => {});
      }
      return real.scanPdfChunks(async () => {
        const chunk = await next();
        if (chunk) scans.windows.push(chunk.length);
        return chunk;
      });
    },
  };
});

const never = new Promise<Uint8Array>(() => {});
/** `run`'s value, or "blocked" when it takes longer than a second. */
const within = <T>(run: Promise<T>) =>
  Promise.race([run, new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 1000))]);

describe("no PDF validation waits on another", () => {
  it("lets a second validation finish while a first one's scan never settles (a whole-scan gate blocked it)", async () => {
    scans.hangNext = true;
    void validate(reader(validPdf()), "pdf");
    expect(await within(validate(reader(validPdf()), "pdf"))).toEqual({ ok: true, type: "pdf" });
  });

  it("lets a second validation finish while a first one's store read never settles", async () => {
    const pdf = validPdf();
    void validate({ size: pdf.length, read: () => never }, "pdf");
    expect(await within(validate(reader(pdf), "pdf"))).toEqual({ ok: true, type: "pdf" });
  });

  it("scans a small PDF in PDF_WINDOW_BYTES windows sliced from its one read (it was scanned as one chunk)", async () => {
    const size = PDF_WINDOW_BYTES + 1000;
    const pdf = new Uint8Array(size).fill(0x20);
    pdf.set(new TextEncoder().encode("%PDF-1.5\n"));
    pdf.set(new TextEncoder().encode("%%EOF\n"), size - 6);
    let reads = 0;
    const counted = {
      size,
      read: async (o: number, n: number) => {
        reads++;
        return pdf.slice(o, o + n);
      },
    };
    scans.windows = [];
    expect(await validate(counted, "pdf")).toEqual({ ok: true, type: "pdf" });
    expect(scans.windows).toEqual([PDF_WINDOW_BYTES, 1000]);
    expect(reads).toBe(1);
  }, 30_000);
});
