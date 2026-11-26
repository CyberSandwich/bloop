import { describe, expect, it } from "vitest";
import { FORMATS, type FormatType } from "../../src/worker/seams/guest-drop/formats.ts";
import type { RangeReader } from "../../src/worker/seams/guest-drop/index.ts";
import { PDF_WINDOW_BYTES } from "../../src/worker/seams/guest-drop/pdf-scan.ts";
import { READ_PLAN } from "../../src/worker/seams/guest-drop/read-plan.ts";
import { MAX_OBJECT_BYTES, validate } from "../../src/worker/seams/guest-drop/validate.ts";
import {
  buildZip,
  validDeck,
  validGif,
  validHeic,
  validJpeg,
  validPdf,
  validPng,
  validVideo,
  validWebm,
  validWebp,
} from "../zip-builder.ts";

const MIB = 1024 * 1024;

/** What a format's smallest valid file looks like, used as the head and the tail of a sparse object. */
const SEEDS: Partial<Record<FormatType, () => Uint8Array>> = {
  pptx: validDeck,
  pdf: validPdf,
  jpg: validJpeg,
  png: validPng,
  gif: validGif,
  webp: validWebp,
  mp4: validVideo,
  mov: () => validVideo("qt  "),
  heic: validHeic,
  webm: validWebm,
};

interface Spent {
  reads: number[];
}

/** An object of `size` bytes: the seed at the start and at the end, zeros between. Records every read's length. */
function sparse(seed: Uint8Array, size: number): RangeReader & Spent {
  const reads: number[] = [];
  return {
    size,
    reads,
    read: async (offset, length) => {
      reads.push(length);
      const out = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
      const tailAt = size - seed.length;
      for (let i = 0; i < out.length; i++) {
        const at = offset + i;
        out[i] = at < seed.length ? (seed[at] as number) : at >= tailAt ? (seed[at - tailAt] as number) : 0;
      }
      return out;
    },
  };
}

describe("DROP-04 memory: no validator holds more than its read plan allows", () => {
  it("the plan covers the largest object with windows of one PDF window each", () => {
    expect(READ_PLAN.maxReads * PDF_WINDOW_BYTES).toBeGreaterThanOrEqual(MAX_OBJECT_BYTES);
    expect(READ_PLAN.maxReadBytes).toBeLessThanOrEqual(PDF_WINDOW_BYTES);
    expect(READ_PLAN.smallObjectBytes).toBeLessThanOrEqual(16 * MIB);
  });

  const sizes = [5 * MIB, 25 * MIB, 100 * MIB];
  for (const type of Object.keys(FORMATS) as FormatType[]) {
    for (const size of sizes) {
      it(`${type} at ${size / MIB} MiB: one read of at most the object up to 16 MiB, else reads of at most one window`, async () => {
        const object = sparse((SEEDS[type] ?? (() => new Uint8Array(64)))(), size);
        await validate(object, type);
        const biggest = Math.max(0, ...object.reads);
        expect(object.reads.length).toBeLessThanOrEqual(READ_PLAN.maxReads);
        // The same bound as the plan: whole up to the small-object cap (a PDF: one window), else one window a read.
        const whole = FORMATS[type].family === "pdf" ? PDF_WINDOW_BYTES : READ_PLAN.smallObjectBytes;
        expect(biggest).toBeLessThanOrEqual(size <= whole ? size : PDF_WINDOW_BYTES);
      });
    }
  }
});

describe("DROP-04 memory: a deck with one large stored entry reads only its parts", () => {
  for (const mib of [5, 25]) {
    it(`a ${mib} MiB stored image in a deck is never read: the reads add up to at most the whole object once`, async () => {
      const deck = buildZip([
        ...validDeckEntries(),
        { name: "ppt/media/imageBig.jpg", data: new Uint8Array(mib * MIB).fill(7), method: 0 },
      ]);
      const reads: number[] = [];
      const object: RangeReader = {
        size: deck.length,
        read: async (offset, length) => {
          reads.push(length);
          return deck.slice(offset, offset + length);
        },
      };
      expect(await validate(object, "pptx")).toEqual({ ok: true, type: "pptx" });
      const total = reads.reduce((n, r) => n + r, 0);
      if (deck.length <= READ_PLAN.smallObjectBytes) expect(reads).toEqual([deck.length]);
      else expect(total).toBeLessThan(MIB);
    });
  }
});

/** The entries of `validDeck`, as builder input, so a test can add one more. */
function validDeckEntries() {
  return [
    {
      name: "[Content_Types].xml",
      data:
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
      method: 8 as const,
    },
    { name: "ppt/presentation.xml", data: "<root/>", method: 8 as const },
  ];
}
