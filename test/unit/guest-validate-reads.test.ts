import { describe, expect, it, vi } from "vitest";
import { dropError, type FormatType } from "../../src/worker/seams/guest-drop/formats.ts";
import { PDF_WINDOW_BYTES } from "../../src/worker/seams/guest-drop/pdf-scan.ts";
import { READ_PLAN, ReadBudgetExceeded } from "../../src/worker/seams/guest-drop/read-plan.ts";
import { MAX_OBJECT_BYTES, validate } from "../../src/worker/seams/guest-drop/validate.ts";
import { buildCfb } from "../cfb-builder.ts";
import { reader, validDeck, validGif, validJpeg, validPdf, validPng, validVideo, validWebm } from "../zip-builder.ts";

const enc = new TextEncoder();
const MIB = 1024 * 1024;
const refused = (error: string) => ({ ok: false, error });

/** A reader over `bytes` that records each read as `[offset, length]`. */
const counted = (bytes: Uint8Array) => {
  const reads: [number, number][] = [];
  return {
    reads,
    size: bytes.length,
    read: async (o: number, n: number) => {
      reads.push([o, n]);
      return bytes.slice(o, o + n);
    },
  };
};

/** A PDF of `size` bytes: header, spaces, `%%EOF`. */
const spacedPdf = (size: number) => {
  const bytes = new Uint8Array(size).fill(0x20);
  bytes.set(enc.encode("%PDF-1.5\n"));
  bytes.set(enc.encode("%%EOF\n"), size - 6);
  return bytes;
};

const FILES: [FormatType, () => Uint8Array][] = [
  ["pptx", () => validDeck()],
  ["doc", () => buildCfb(["WordDocument"])],
  ["pdf", validPdf],
  ["jpg", () => validJpeg()],
  ["png", () => validPng()],
  ["gif", () => validGif()],
  ["mp4", () => validVideo()],
  ["webm", validWebm],
  ["txt", () => enc.encode("plain notes\n")],
];

describe("one read plan per object, made in validate", () => {
  it.each(FILES)("reads a small %s in one operation (the head, tails and checks share it)", async (type, build) => {
    const file = counted(build());
    expect(await validate(file, type)).toEqual({ ok: true, type });
    expect(file.reads).toEqual([[0, file.size]]);
  });

  it("reads a large PDF as its head, its two tails and one read per 8 MiB window, within the plan", async () => {
    const file = counted(spacedPdf(20 * MIB));
    expect(await validate(file, "pdf")).toEqual({ ok: true, type: "pdf" });
    expect(file.reads.length).toBe(3 + Math.ceil(file.size / PDF_WINDOW_BYTES));
    expect(Math.max(...file.reads.map(([, n]) => n))).toBe(PDF_WINDOW_BYTES);
    expect(3 + Math.ceil(MAX_OBJECT_BYTES / PDF_WINDOW_BYTES)).toBeLessThanOrEqual(READ_PLAN.maxReads);
  });

  it("refuses an object over MAX_OBJECT_BYTES as too_large without reading it (no upper bound on the size)", async () => {
    const read = vi.fn(async () => new Uint8Array());
    expect(await validate({ size: MAX_OBJECT_BYTES + 1, read }, "mp4")).toEqual(refused("too_large"));
    expect(read).not.toHaveBeenCalled();
  });

  it.each(FILES)(
    "answers a spent read budget on a %s as bad_structure (a throw left the object in R2)",
    async (type, build) => {
      const bytes = build();
      const spent = {
        size: bytes.length,
        read: async (): Promise<Uint8Array> => {
          throw new ReadBudgetExceeded();
        },
      };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await validate(spent, type)).toEqual(refused("bad_structure"));
      expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
        { evt: "drop.refused", reason: "read_budget", bytes: bytes.length },
      ]);
      warn.mockRestore();
    },
  );

  it("walks a GIF at MAX_OBJECT_BYTES to its end within the plan: head, two tails and 64 windows", async () => {
    // A frame whose data runs in 255-byte sub-blocks to the end of the file, with no trailer.
    const head = validGif(1, 1).subarray(0, 13 + 10 + 1);
    let reads = 0;
    const endless = {
      size: MAX_OBJECT_BYTES,
      read: async (o: number, n: number) => {
        reads++;
        const out = new Uint8Array(n);
        const first = o < head.length ? head.length - o : (256 - ((o - head.length) % 256)) % 256;
        for (let i = first; i < n; i += 256) out[i] = 255;
        if (o < head.length) out.set(head.subarray(o, o + n));
        return out;
      },
    };
    expect(await validate(endless, "gif")).toEqual(refused("bad_structure"));
    expect(reads).toBe(3 + MAX_OBJECT_BYTES / READ_PLAN.maxReadBytes);
    expect(reads).toBeLessThanOrEqual(READ_PLAN.maxReads);
  }, 120_000);
});

describe("a short read is refused, never checked as fewer bytes (readExact)", () => {
  /** A reader that answers the first read in full and every later one a byte short. */
  const shortAfterHead = (bytes: Uint8Array, size = bytes.length) => {
    let reads = 0;
    return {
      size,
      read: async (o: number, n: number) => {
        const out = new Uint8Array(n);
        out.set(bytes.subarray(o, o + n));
        return reads++ === 0 ? out : out.subarray(0, Math.max(0, n - 1));
      },
    };
  };

  it("refuses a large video whose tail comes back short (the polyglot check ran on missing bytes)", async () => {
    const video = validVideo();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await validate(shortAfterHead(video, 17 * MIB), "mp4")).toEqual(refused("bad_structure"));
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { evt: "drop.refused", reason: "short_read", bytes: 17 * MIB },
    ]);
    warn.mockRestore();
  });

  it.each(FILES)(
    "refuses a small %s whose one whole read comes back short (the checks ran on fewer bytes)",
    async (type, build) => {
      const bytes = build();
      const short = { size: bytes.length, read: async (o: number, n: number) => bytes.slice(o, o + n - 1) };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await validate(short, type)).toEqual(refused("bad_structure"));
      warn.mockRestore();
    },
  );
});

describe("the codes a guest's phone knows", () => {
  it("maps encrypted to bad_structure; every other code is its own", () => {
    expect(dropError("encrypted")).toBe("bad_structure");
    for (const code of ["too_large", "bad_type", "bad_structure", "macro_content"] as const) {
      expect(dropError(code)).toBe(code);
    }
  });

  it("refuses an encrypted PDF as encrypted, which a guest sees as bad_structure", async () => {
    const pdf = enc.encode("%PDF-1.5\ntrailer << /Encrypt 9 0 R >>\n%%EOF\n");
    const verdict = await validate(reader(pdf), "pdf");
    expect(verdict).toEqual(refused("encrypted"));
    expect(dropError((verdict as { error: "encrypted" }).error)).toBe("bad_structure");
  });
});
