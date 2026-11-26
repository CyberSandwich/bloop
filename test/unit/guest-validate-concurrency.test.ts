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

  it("lets a second validation finish while a first one's window read never settles inside its scan (a scan gate)", async () => {
    const large = spaced(PDF_WINDOW_BYTES + 1000);
    // The head and tails arrive; the first window, read from inside the scan, never does.
    const stuck = {
      size: large.length,
      read: (o: number, n: number) => (n === PDF_WINDOW_BYTES ? never : Promise.resolve(large.slice(o, o + n))),
    };
    void validate(stuck, "pdf");
    expect(await within(validate(reader(validPdf()), "pdf"))).toEqual({ ok: true, type: "pdf" });
  });

  it("reads a PDF of one window whole, and scans a larger one in window reads (a whole read beside the buffer)", async () => {
    const counted = (pdf: Uint8Array) => {
      const reads: number[] = [];
      return {
        reads,
        size: pdf.length,
        read: async (o: number, n: number) => {
          reads.push(n);
          return pdf.slice(o, o + n);
        },
      };
    };
    const one = counted(spaced(PDF_WINDOW_BYTES));
    scans.windows = [];
    expect(await validate(one, "pdf")).toEqual({ ok: true, type: "pdf" });
    expect(one.reads).toEqual([PDF_WINDOW_BYTES]);
    expect(scans.windows).toEqual([PDF_WINDOW_BYTES]);
    const more = counted(spaced(PDF_WINDOW_BYTES + 1000));
    scans.windows = [];
    expect(await validate(more, "pdf")).toEqual({ ok: true, type: "pdf" });
    // The head, the zip end record's tail, the PDF tail, then two windows.
    expect(more.reads.slice(3)).toEqual([PDF_WINDOW_BYTES, 1000]);
    expect(more.reads).toHaveLength(5);
    expect(scans.windows).toEqual([PDF_WINDOW_BYTES, 1000]);
  }, 30_000);
});

/** A PDF of `size` bytes: header, spaces, `%%EOF`. */
function spaced(size: number): Uint8Array {
  const pdf = new Uint8Array(size).fill(0x20);
  pdf.set(new TextEncoder().encode("%PDF-1.5\n"));
  pdf.set(new TextEncoder().encode("%%EOF\n"), size - 6);
  return pdf;
}
