// Crafts zip files for the guest-drop tests, including ones whose central directory lies.
import { deflateRawSync } from "node:zlib";

export interface BuiltEntry {
  name: string;
  data?: Uint8Array | string;
  /** 0 stored, 8 deflate. */
  method?: 0 | 8;
  /** Override what the central directory declares. */
  declaredUncompressed?: number;
  declaredCompressed?: number;
}

const enc = new TextEncoder();
const bytes = (d: Uint8Array | string | undefined) => (typeof d === "string" ? enc.encode(d) : (d ?? new Uint8Array()));

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function le(...fields: [number, 2 | 4][]): Uint8Array {
  const out = new Uint8Array(fields.reduce((n, [, w]) => n + w, 0));
  const v = new DataView(out.buffer);
  let at = 0;
  for (const [value, width] of fields) {
    if (width === 2) v.setUint16(at, value, true);
    else v.setUint32(at, value, true);
    at += width;
  }
  return out;
}

export function buildZip(entries: BuiltEntry[], comment = ""): Uint8Array {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = bytes(e.data);
    const method = e.method ?? 0;
    const stored = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const name = enc.encode(e.name);
    const csize = e.declaredCompressed ?? stored.length;
    const usize = e.declaredUncompressed ?? raw.length;
    const local = concat([
      le([0x04034b50, 4], [20, 2], [0, 2], [method, 2], [0, 2], [0, 2], [0, 4], [csize, 4], [usize, 4]),
      le([name.length, 2], [0, 2]),
      name,
      stored,
    ]);
    central.push(
      concat([
        le(
          [0x02014b50, 4],
          [20, 2],
          [20, 2],
          [0, 2],
          [method, 2],
          [0, 2],
          [0, 2],
          [0, 4],
          [csize, 4],
          [usize, 4],
          [name.length, 2],
          [0, 2],
          [0, 2],
          [0, 2],
          [0, 2],
          [0, 4],
          [offset, 4],
        ),
        name,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }
  const cd = concat(central);
  const note = enc.encode(comment);
  const end = concat([
    le(
      [0x06054b50, 4],
      [0, 2],
      [0, 2],
      [entries.length, 2],
      [entries.length, 2],
      [cd.length, 4],
      [offset, 4],
      [note.length, 2],
    ),
    note,
  ]);
  return concat([...locals, cd, end]);
}

const CONTENT_TYPES =
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>';

/** A minimal structurally valid OOXML package whose main part is `main` (the part that makes it a deck, document or sheet). */
export const validPackage = (main: string, extra: BuiltEntry[] = [], contentTypes = CONTENT_TYPES): Uint8Array =>
  buildZip([
    { name: "[Content_Types].xml", data: contentTypes, method: 8 },
    { name: main, data: "<root/>", method: 8 },
    ...extra,
  ]);

/** A minimal structurally valid deck. */
export const validDeck = (extra: BuiltEntry[] = [], contentTypes = CONTENT_TYPES): Uint8Array =>
  validPackage("ppt/presentation.xml", extra, contentTypes);

export const validPdf = (): Uint8Array => enc.encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

const u16be = (n: number) => new Uint8Array([(n >>> 8) & 255, n & 255]);
const u16le = (n: number) => new Uint8Array([n & 255, (n >>> 8) & 255]);
const u32be = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u32le = (n: number) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);

/** A minimal JPEG: SOI, one comment segment, a baseline frame header of the given size, EOI. */
export const validJpeg = (comment = "x", width = 1, height = 1): Uint8Array =>
  concat([
    new Uint8Array([0xff, 0xd8, 0xff, 0xfe, 0, comment.length + 2]),
    enc.encode(comment),
    new Uint8Array([0xff, 0xc0, 0, 11, 8]),
    u16be(height),
    u16be(width),
    new Uint8Array([1, 1, 0x11, 0]),
    new Uint8Array([0xff, 0xd9]),
  ]);

/** A minimal PNG: signature, an IHDR chunk of the given size and an IEND chunk (the CRCs are not checked). */
export const validPng = (width = 1, height = 1): Uint8Array =>
  concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    u32be(13),
    enc.encode("IHDR"),
    u32be(width),
    u32be(height),
    new Uint8Array([8, 2, 0, 0, 0, 0, 0, 0, 0]),
    u32be(0),
    enc.encode("IEND"),
    new Uint8Array([0xae, 0x42, 0x60, 0x82]),
  ]);

/** A minimal GIF: header, logical screen of the given size, trailer. */
export const validGif = (width = 1, height = 1): Uint8Array =>
  concat([enc.encode("GIF89a"), u16le(width), u16le(height), new Uint8Array([0, 0, 0]), new Uint8Array([0x3b])]);

/** A minimal lossless WebP of the given size: RIFF length equals the file's. */
export const validWebp = (width = 1, height = 1): Uint8Array => {
  const chunk = concat([
    enc.encode("VP8L"),
    u32le(5),
    new Uint8Array([0x2f]),
    u32le((width - 1) | ((height - 1) << 14)),
  ]);
  return concat([enc.encode("RIFF"), u32le(4 + chunk.length), enc.encode("WEBP"), chunk]);
};

/** A minimal HEIC: an `ftyp` box then a `meta` box. */
export const validHeic = (): Uint8Array =>
  concat([u32be(16), enc.encode("ftypheic"), u32be(0), u32be(16), enc.encode("meta"), new Uint8Array(8)]);

/** A minimal WebM: an EBML header with the `webm` DocType, then a segment id. */
export const validWebm = (): Uint8Array =>
  concat([
    new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 0x42, 0xf7, 0x81, 1, 0x42, 0x82, 0x84]),
    enc.encode("webm"),
    new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x80]),
  ]);
const box = (type: string, payload: Uint8Array) => concat([u32be(8 + payload.length), enc.encode(type), payload]);

/** A minimal ISO base media file: an `ftyp` box with the given major brand, then `moov` and `mdat` boxes. */
export const validVideo = (brand = "isom", payloadBytes = 64): Uint8Array =>
  concat([
    box("ftyp", concat([enc.encode(brand), u32be(0), enc.encode(brand)])),
    box("moov", new Uint8Array(16)),
    box(
      "mdat",
      Uint8Array.from({ length: payloadBytes }, (_, i) => i % 251),
    ),
  ]);

export { concat };

/** A RangeReader over a byte array, for the pure validators. */
export const reader = (data: Uint8Array) => ({
  size: data.length,
  read: async (offset: number, length: number) => data.slice(offset, offset + length),
});
